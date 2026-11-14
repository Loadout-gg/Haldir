import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Sandbox, GenesisAccount } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, baseEncode } from 'near-api-js';
import { createNearOwnerOperations } from '../src/server/near-owner-operations.mjs';

const ONE=10n**24n, CAP=10n*ONE, FLOAT=5n*ONE;
const hash = bytes => baseEncode(createHash('sha256').update(bytes).digest());
const opId=(job,action)=>createHash('sha256').update(JSON.stringify(['haldir-owner-v1',job,action])).digest('hex');

test('ACTUAL SANDBOX only: concrete owner provider prepares and observes create / stop / native withdraw', {timeout:120000}, async t => {
  const sandbox=await Sandbox.start({version:'2.14.0'});
  try {
    assert.equal(new URL(sandbox.rpcUrl).hostname,'127.0.0.1');
    const provider=new JsonRpcProvider({url:sandbox.rpcUrl},{retries:1});
    const networkId=(await provider.viewNodeStatus()).chain_id;
    assert.ok(!['testnet','mainnet'].includes(networkId));
    const genesis=GenesisAccount.createDefault(), root=new Account(genesis.accountId,provider,genesis.privateKey);
    const send=(account,receiverId,list)=>account.signAndSendTransaction({receiverId,actions:list,waitUntil:'FINAL',throwOnFailure:false});
    const fc=(method,args={},deposit=0n,gas=100000000000000n)=>actions.functionCall(method,args,gas,deposit);
    async function role(name) {
      const key=KeyPair.fromRandom('ed25519'), id=`${name}.${root.accountId}`;
      const tx=await send(root,id,[actions.createAccount(),actions.transfer(200n*ONE),actions.addFullAccessKey(key.getPublicKey())]);
      assert.ok('SuccessValue' in tx.status);
      return {id,key,account:new Account(id,provider,key.toString())};
    }
    const owner=await role('owner'), agent=await role('agent'), vendor=await role('vendor'), factory=await role('factory');
    const wasm=await readFile(new URL('../target/mandate-wasm/u01_mandate_proof.wasm',import.meta.url));
    const factoryWasm=await readFile(new URL('../target/mandate-factory-wasm/u01_mandate_factory.wasm',import.meta.url));
    assert.ok('SuccessValue' in (await send(factory.account,factory.id,[actions.deployContract(factoryWasm),fc('new',{max_jobs:4}),actions.deleteKey(factory.key.getPublicKey())])).status);
    const head=await provider.viewBlock({finality:'final'});
    const expiresAt=new Date(Number(BigInt(head.header.timestamp_nanosec)/1000000n)+3600000).toISOString().replace(/\.\d{3}Z$/,'Z');
    const label='owner-provider';
    const mandateId='j'+createHash('sha256').update(`${owner.id}:${label}`).digest('hex').slice(0,32)+'.'+factory.id;
    const scope={networkId,mandateId,budgetAtomic:String(CAP),vendorIds:[vendor.id],expiresAt};
    const manifest={manifestId:'sandbox-approved-manifest',ownerId:owner.id,
      binding:{networkId,ownerId:owner.id,mandateId,signerId:agent.id,codeHash:hash(wasm)},
      approved:{job:scope,quote:{networkId,mandateId,vendorId:vendor.id,amountAtomic:'1',orderId:'order-1'}},
      creation:{factory:factory.id,factoryCodeHash:hash(factoryWasm),job_label:label,operating_float:String(FLOAT),create_gas:'300000000000000'}};
    const job={jobId:'sandbox-owner-job',ownerId:owner.id,scope,publicManifest:manifest};
    const records={jobs:{[job.jobId]:job},ownerOperations:{}};
    const repository={async runTransaction(fn){return fn({async get(c,k){return structuredClone(records[c]?.[k]??null);}});}};
    const operations=createNearOwnerOperations({repository,rpcUrl:sandbox.rpcUrl,provider,localTestOnly:true,networkId,timeoutMs:30000});
    const observed={};
    for(const action of ['create','stop','withdraw']) {
      const operationId=opId(job.jobId,action);
      const row={operationId,jobId:job.jobId,ownerId:owner.id,action,status:'PREPARING',request:null,transactionHash:null};
      records.ownerOperations[operationId]=row;
      const input={operationId,action,job,manifest,ownerId:owner.id};
      const call=await operations.prepare(input); // create before any child account exists
      assert.equal(call.network,networkId); assert.equal(call.signerId,owner.id);
      row.request=call;
      const tx=await send(owner.account,call.receiverId,[fc(call.methodName,call.args,BigInt(call.deposit),BigInt(call.gas))]);
      assert.ok('SuccessValue' in tx.status,JSON.stringify(tx.status));
      assert.ok(tx.receipts_outcome.every(r=>!('Failure' in r.outcome.status)));
      row.transactionHash=tx.transaction.hash; row.status='SUBMITTED';
      const observation=await operations.reconcile({...input,transactionHash:row.transactionHash,signerId:owner.id});
      observed[action]=observation;
      await t.test(`${action}: final concrete observation on actual ${networkId}`,async()=>{
        assert.equal(observation.status,'CONFIRMED'); assert.equal(observation.finality,'final');
        assert.equal(observation.networkId,networkId); assert.notEqual(observation.networkId,'testnet');
        assert.equal(observation.ownerId,owner.id); assert.equal(observation.mandateId,mandateId);
        if(action==='withdraw') {
          assert.equal(observation.amountAtomic,String(CAP));
          const receipt=await provider.viewTransactionReceipt(observation.receiptId);
          assert.equal(receipt.predecessor_id,mandateId); assert.equal(receipt.receiver_id,owner.id);
          assert.deepEqual(receipt.receipt.Action.actions,[{Transfer:{deposit:String(CAP)}}]);
        }
      });
      // Mutation controls over real captured RPC records, not fabricated positives.
      const finalTx=await provider.viewTransactionStatusWithReceipts({txHash:row.transactionHash,accountId:owner.id,waitUntil:'FINAL'});
      const fullReceipts=await Promise.all(finalTx.receipts_outcome.map(r=>provider.viewTransactionReceipt(r.id)));
      const controls=action==='create'?[
        ['wrong deployment code hash', r=>{const d=r.receipt.Action.actions.find(a=>a?.DeployContract);if(d)d.DeployContract.code=Buffer.alloc(32,1).toString('base64');}],
        ['wrong initializer owner',r=>{const c=r.receipt.Action.actions.find(a=>a?.FunctionCall?.method_name==='new_from_factory')?.FunctionCall;if(c){const a=JSON.parse(Buffer.from(c.args,'base64'));a.owner=vendor.id;c.args=Buffer.from(JSON.stringify(a)).toString('base64');}}],
        ['detached creation callback',r=>{if(r.receipt.Action.actions[0]?.FunctionCall?.method_name==='on_create')r.receipt.Action.input_data_ids=[hash('unrelated-data')];}],
      ]:action==='withdraw'?[
        ['gas refund cannot replace principal return',r=>{if(r.predecessor_id===mandateId&&r.receiver_id===owner.id){r.predecessor_id='system';r.receipt.Action.output_data_receivers=[];}}],
        ['wrong principal recipient',r=>{if(r.predecessor_id===mandateId&&r.receiver_id===owner.id)r.receiver_id=vendor.id;}],
        ['detached refund callback',r=>{if(r.receipt.Action.actions[0]?.FunctionCall?.method_name==='on_refund')r.receipt.Action.input_data_ids=[hash('unrelated-data')];}],
      ]:[];
      for(const [name,mutate] of controls) await t.test(`${action}: actual-receipt negative ${name}`,async()=>{
        const mutated=structuredClone(fullReceipts);mutated.forEach(mutate);
        const readProvider=new Proxy(provider,{get(target,key){
          if(key==='viewTransactionStatusWithReceipts')return async()=>structuredClone(finalTx);
          if(key==='viewTransactionReceipt')return async id=>structuredClone(mutated.find(r=>r.receipt_id===id));
          const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
        }});
        const observer=createNearOwnerOperations({repository,rpcUrl:sandbox.rpcUrl,provider:readProvider,localTestOnly:true,networkId,timeoutMs:30000});
        const result=await observer.reconcile({...input,transactionHash:row.transactionHash,signerId:owner.id});
        assert.equal(result.status,'UNKNOWN');assert.equal(result.amountAtomic,undefined);
      });
      if(action==='stop') await t.test('stop: actual state stopped=false is not confirmed',async()=>{
        const readProvider=new Proxy(provider,{get(target,key){
          if(key==='query')return async p=>{const r=await target.query(p);if(p.request_type==='call_function'&&p.method_name==='get_status'){
            const state=JSON.parse(Buffer.from(r.result));state.stopped=false;r.result=[...Buffer.from(JSON.stringify(state))];}return r;};
          const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
        }});
        const result=await createNearOwnerOperations({repository,rpcUrl:sandbox.rpcUrl,provider:readProvider,localTestOnly:true,networkId,timeoutMs:30000}).reconcile({...input,transactionHash:row.transactionHash,signerId:owner.id});
        assert.equal(result.status,'UNKNOWN');
      });
      if(action==='withdraw') {
        const again=await operations.reconcile({...input,transactionHash:row.transactionHash,signerId:owner.id});
        assert.deepEqual(again,observation,'read-only same-identity replay');
        const wrong=await operations.reconcile({...input,transactionHash:observed.stop.transactionHash,signerId:owner.id});
        assert.equal(wrong.status,'UNKNOWN');
      }
    }
    t.diagnostic(JSON.stringify({qualification:'ACTUAL_LOCAL_SANDBOX_NOT_PUBLIC',networkId,observed}));
  } finally { await sandbox.stop(); }
});
