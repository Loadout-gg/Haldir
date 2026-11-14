#!/usr/bin/env node
// Public writes are impossible without separate exact parent approval AND
// operator-supplied dedicated bootstrap credential FD. No owner-key support.
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { KeyPairSigner } from 'near-api-js';
import { compileManifest, manifestHash, PINS, digest } from './manifest.mjs';
import { ReadOnlyProvider, snapshot, query, maybeAccount } from './readonly.mjs';
import { authorize, executeStep, inspect } from './operator.mjs';
const args=process.argv.slice(2), command=args.shift();
const option=k=>{const i=args.indexOf('--'+k);return i<0?null:args[i+1];};
const required=k=>{const v=option(k);if(!v)throw new Error('MISSING_'+k);return v;};
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const save=async v=>{await writeFile(required('out'),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({status:'WRITTEN',out:option('out'),...(v.schema?{manifest_sha256:manifestHash(v)}:{})}));};
const artifactBytes=async()=>({mandate:await readFile(new URL('../../target/mandate-wasm/u01_mandate_proof.wasm',import.meta.url)),factory:await readFile(new URL('../../target/mandate-factory-wasm/u01_mandate_factory.wasm',import.meta.url))});
async function loadManifest() {const m=await json(required('manifest'));if(manifestHash(compileManifest(m.spec,m.protocol,await artifactBytes()))!==manifestHash(m))throw new Error('MANIFEST_TAMPER');return m;}
try {
  if(command==='snapshot') await save(await snapshot(new ReadOnlyProvider()));
  else if(command==='compile') {
    const spec=await json(required('spec')), protocol=await json(required('protocol'));
    await save(compileManifest(spec,protocol,await artifactBytes()));
  } else if(command==='template') await save({network:'testnet',rpc:'https://rpc.testnet.near.org',provisioner:null,factory:null,agent:null,owner:null,allowlist:[],job_label:null,bootstrap_public_key:null,agent_public_key:null,cap:null,operating_float:null,agent_funding:null,allowance:null,factory_funding:null,factory_gas_reserve:null,provisioner_gas_reserve:null,owner_gas_reserve:null,max_total_outlay:null,max_jobs:null,deadline_ns:null,create_gas:null});
  else if(command==='inventory') {
    const files=['qualification/mandate-contract/src/lib.rs','qualification/mandate-factory/src/lib.rs','qualification/mandate-contract/Cargo.lock','qualification/mandate-factory/Cargo.lock','target/mandate-wasm/u01_mandate_proof.wasm','target/mandate-factory-wasm/u01_mandate_factory.wasm'];
    const result={pins:PINS,files:[]};for(const path of files){const b=await readFile(new URL('../../'+path,import.meta.url));result.files.push({path,bytes:b.length,sha256:digest(b)});}await save(result);
  } else if(command==='preflight') {
    const m=await loadManifest(),p=new ReadOnlyProvider(),protocol=await snapshot(p),accounts={};
    for(const id of [m.spec.provisioner,m.spec.owner,...m.spec.allowlist,m.spec.factory,m.spec.agent,m.mandate]) {
      const state=await maybeAccount(p,id); accounts[id]={state,keys:state?(await query(p,id,'view_access_key_list')):null};
    }
    await save({manifest_sha256:manifestHash(m),protocol,accounts,public_writes:0});
  } else if(command==='verify') {
    const m=await loadManifest(),p=new ReadOnlyProvider(); const protocol=await snapshot(p);
    await save({manifest_sha256:manifestHash(m),protocol,accounts:await inspect(m,p,{childRequired:true}),public_writes:0});
  } else if(command==='execute') {
    const m=await loadManifest(),approval=await json(required('approval')),step=required('step');
    authorize(m,approval,step);
    const fd=Number(required('bootstrap-key-fd'));if(!Number.isInteger(fd)||fd<3)throw new Error('PROTECTED_FD_REQUIRED');
    // Delayed protected-process resolution. Raw values never enter argv/env/logs.
    let cached;
    const signer={getPublicKey:async()=>{cached??=KeyPairSigner.fromSecretKey(readFileSync(fd,'utf8'));return cached.getPublicKey();},signTransaction:async tx=>cached.signTransaction(tx)};
    console.log(JSON.stringify(await executeStep({manifest:m,approval,step,bytes:await artifactBytes(),journalPath:required('journal'),signer})));
  } else if(command==='reconcile') {
    const j=await json(required('journal')),p=new ReadOnlyProvider();await snapshot(p);
    if(!j.transaction_hash) console.log(JSON.stringify({phase:j.phase,status:'UNSENT_OR_UNKNOWN_NO_AUTOMATIC_RETRY'}));
    else {const r=await p.sendJsonRpc('EXPERIMENTAL_tx_status',{tx_hash:j.transaction_hash,sender_account_id:j.signer_id,wait_until:'FINAL'});
      console.log(JSON.stringify({phase:j.phase,transaction_hash:j.transaction_hash,final_execution_status:r.final_execution_status,status:r.status,note:'No send. Run exact account verification separately.'}));}
  } else throw new Error('USAGE');
} catch {
  // Never emit vendor/SDK errors: malformed key diagnostics can be secret-bearing.
  console.error('HALDIR_TOOL_FAILED: invalid input, missing authority, RPC unavailable, or unverified outcome. No automatic retry. Inspect only nonsecret preflight/journal metadata.');
  process.exitCode=1;
}
