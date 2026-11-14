import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, GenesisAccount } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';
import { compileManifest, manifestHash } from './manifest.mjs';
import { ReadOnlyProvider, snapshot, query } from './readonly.mjs';
import { executeStep, inspect } from './operator.mjs';

// Synthetic .testnet-named accounts are genesis fixtures on a REAL local chain.
// No RPC or chain relabelling: executeStep receives the actual local chain ID.
test('real Sandbox qualifies the exact manifest operator; keyless factory/child and sole finite pay key', async t => {
  const b=KeyPair.fromRandom('ed25519'), o=KeyPair.fromRandom('ed25519'), v=KeyPair.fromRandom('ed25519'), agent=KeyPair.fromRandom('ed25519');
  const genesis=(id,key)=>new GenesisAccount(id,key.getPublicKey().toString(),key.toString(),100n*10n**24n);
  const dir=await mkdtemp(join(tmpdir(),'haldir-provision-'));
  const s=await Sandbox.start({version:'2.14.0',config:{additionalAccounts:[genesis('bootstrap.testnet',b),genesis('owner.testnet',o),genesis('vendor.testnet',v)]}});
  try {
    const sdk=new JsonRpcProvider({url:s.rpcUrl},{retries:1});
    const status=await sdk.viewNodeStatus(), p=new ReadOnlyProvider(s.rpcUrl,{localTestOnly:true});
    const live=await snapshot(p,status.chain_id);
    const bytes={factory:await readFile(new URL('../../target/mandate-factory-wasm/u01_mandate_factory.wasm',import.meta.url)),mandate:await readFile(new URL('../../target/mandate-wasm/u01_mandate_proof.wasm',import.meta.url))};
    const spec={network:'testnet',rpc:'https://rpc.testnet.near.org',provisioner:'bootstrap.testnet',factory:'f.bootstrap.testnet',agent:'a.bootstrap.testnet',owner:'owner.testnet',allowlist:['vendor.testnet'],job_label:'qualification',
      bootstrap_public_key:b.getPublicKey().toString(),agent_public_key:agent.getPublicKey().toString(),cap:'1000000000000000000000000',operating_float:'2000000000000000000000000',agent_funding:'1000000000000000000000000',allowance:'600000000000000000000000',factory_funding:'4000000000000000000000000',factory_gas_reserve:'1000000000000000000000000',provisioner_gas_reserve:'2000000000000000000000000',owner_gas_reserve:'2000000000000000000000000',max_total_outlay:'20000000000000000000000000',max_jobs:4,deadline_ns:String((BigInt(live.timestamp_nanosec)/1_000_000n+3600000n)*1_000_000n),create_gas:'300000000000000'};
    // Compile the public-shaped input fixture with measured local fee values;
    // this object is NOT a testnet protocol observation or approved deployment.
    const fixtureProtocol={...live,chain_id:'testnet',rpc:spec.rpc};
    const m=compileManifest(spec,fixtureProtocol,bytes);
    const approval={manifest_sha256:manifestHash(m),public_writes:true,allowed_steps:m.steps.map(x=>x.kind),max_total_outlay:spec.max_total_outlay,expires_at:new Date(Date.now()+3600000).toISOString()};
    const signer=KeyPairSigner.fromSecretKey(b.toString());
    const reservedPath=join(dir,'reserved-canary.json');
    await assert.rejects(executeStep({manifest:m,approval,step:'factory_create',signer:{async getPublicKey(){throw new Error('synthetic-signer-failure');}},bytes,journalPath:reservedPath,provider:p,localTestOnly:true,localChain:status.chain_id}),/synthetic-signer-failure/);
    assert.equal(JSON.parse(await readFile(reservedPath)).phase,'RESERVED');
    let retrySigns=0;
    await assert.rejects(executeStep({manifest:m,approval,step:'factory_create',signer:{async getPublicKey(){retrySigns++;return b.getPublicKey();}},bytes,journalPath:reservedPath,provider:p,localTestOnly:true,localChain:status.chain_id}),/EEXIST/);
    assert.equal(retrySigns,0);
    const receipts=[];
    for(const step of m.steps) {
      const r=await executeStep({manifest:m,approval,step:step.kind,signer,bytes,journalPath:join(dir,step.kind+'.json'),provider:p,localTestOnly:true,localChain:status.chain_id});
      assert.equal(r.status,'VERIFIED'); receipts.push(r);
    }
    const before=await inspect(m,p); assert.equal(before.child,null);
    const owner=new Account(spec.owner,sdk,o.toString());
    const created=await owner.signAndSendTransaction({receiverId:spec.factory,actions:[actions.functionCall('create_job',m.owner_create.actions[0].args,300_000_000_000_000n,BigInt(spec.cap)+BigInt(spec.operating_float))],waitUntil:'FINAL'});
    assert.equal(Buffer.from(created.status.SuccessValue,'base64').toString(),'true');
    const after=await inspect(m,p,{childRequired:true});
    assert.equal(m.budget.child_max_storage_bytes,after.child.storage_usage+16*(89+spec.allowlist[0].length)+85);
    assert.ok(before.agent.storage_usage<=m.budget.agent_storage_upper_bytes);
    assert.equal(m.budget.factory_max_storage_bytes,before.factory.storage_usage+spec.max_jobs*165);
    const restricted=new Account(spec.agent,sdk,agent.toString());
    const paid=await restricted.signAndSendTransaction({receiverId:m.mandate,actions:[actions.functionCall('pay',{order_id:'one',recipient:spec.allowlist[0],amount:'1'},100_000_000_000_000n,0n)],waitUntil:'FINAL'});
    assert.ok(Object.hasOwn(paid.status,'SuccessValue'));
    const denied=await restricted.signAndSendTransaction({receiverId:m.mandate,actions:[actions.functionCall('stop',{},100_000_000_000_000n,0n)],waitUntil:'FINAL',throwOnFailure:false}).then(()=>false,()=>true);
    assert.equal(denied,true);
    await owner.signAndSendTransaction({receiverId:m.mandate,actions:[actions.functionCall('stop',{},100_000_000_000_000n,0n)],waitUntil:'FINAL'});
    await owner.signAndSendTransaction({receiverId:m.mandate,actions:[actions.functionCall('withdraw',{},100_000_000_000_000n,0n)],waitUntil:'FINAL'});
    // Existing journal cannot cause a second sign or send, even when re-entry
    // fails earlier because a target now exists. We never manufacture a retry.
    let signs=0;
    await assert.rejects(executeStep({manifest:m,approval,step:'agent_create',signer:{getPublicKey(){signs++;}},bytes,journalPath:join(dir,'agent_create.json'),provider:p,localTestOnly:true,localChain:status.chain_id}),/AGENT_EXISTS/);
    assert.equal(signs,0);
    const report={kind:'actual-local-sandbox',chain_id:status.chain_id,public_writes:0,receipts,child:m.mandate,creation_hash:created.transaction.hash,payment_hash:paid.transaction.hash,child_storage_usage:after.child.storage_usage,calculated_child_max:m.budget.child_max_storage_bytes,factory_code_hash:after.factory.code_hash,mandate_code_hash:after.child.code_hash,agent_permission:before.agentKeys[0].access_key.permission,teardown:'completed after assertions'};
    await writeFile(new URL('./sandbox-receipt.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
    t.diagnostic(JSON.stringify(report));
  } finally {await s.tearDown();await rm(dir,{recursive:true,force:true});}
});
