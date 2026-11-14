// TEST ONLY: exact hash-bound reuse of the accepted entrypoint tracer.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm,realpath,stat,access,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname,basename,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
export const root=fileURLToPath(new URL('../../',import.meta.url));
export const sha=b=>createHash('sha256').update(b).digest('hex');
export async function approvedTempRoot(){
 const value=process.env.TMPDIR;
 assert.ok(typeof value==='string'&&isAbsolute(value),'APPROVED_TMPDIR_REQUIRED');
 try{const root=await realpath(value);assert.ok((await stat(root)).isDirectory());await access(root,constants.W_OK|constants.X_OK);return root;}
 catch{throw Error('APPROVED_TMPDIR_UNAVAILABLE_OR_NOT_WRITABLE');}
}
export const tempRoot=await approvedTempRoot();
export async function evidenceDirectory(value,prefix){
 if(value===undefined)return mkdtemp(join(tempRoot,prefix));
 assert.ok(typeof value==='string'&&isAbsolute(value),'EVIDENCE_DIR_ABSOLUTE_REQUIRED');
 let parent=resolve(value),parts=[];
 while(true){try{parent=await realpath(parent);break;}catch(e){if(e.code!=='ENOENT')throw e;parts.unshift(basename(parent));parent=dirname(parent);}}
 const target=join(parent,...parts),inside=relative(tempRoot,target);
 assert.ok(inside&&inside!=='..'&&!inside.startsWith('..'+sep)&&!isAbsolute(inside),'EVIDENCE_DIR_OUTSIDE_APPROVED_TMPDIR');
 await mkdir(target,{recursive:true});assert.deepEqual(await readdir(target),[],'EVIDENCE_DIR_NOT_EMPTY');return target;
}
const pins={
 'operational-entrypoint.test.mjs':'5ba957403c90b8bb01ffdf3d1c9e7c20a372738c4ced92750e9f201e8a327c58',
 'operational-entrypoint-fixture.mjs':'78355079f291f2704ee2b16b180a500409ff39ca78aefb9ac5a927ad0b750d68',
};
function once(source,old,next){assert.equal(source.split(old).length,2,'exact adaptation boundary');return source.replace(old,next);}
export async function harness(t){
 const scratch=await mkdtemp(join(tempRoot,'haldir-operational-fault-harness-'));
 t.after(()=>rm(scratch,{recursive:true,force:true}));
 const dir=join(scratch,'deployment/haldir-public');await mkdir(dir,{recursive:true});
 await symlink(join(root,'node_modules'),join(scratch,'node_modules'),'dir');
 await writeFile(join(dir,'package-runtime.mjs'),await readFile(join(root,'deployment/haldir-public/package-runtime.mjs')));
 let source=await readFile(join(root,'deployment/haldir-public/operational-entrypoint.test.mjs'),'utf8');assert.equal(sha(source),pins['operational-entrypoint.test.mjs']);
 const marker="for(const mode of ['exported','auto'])test(";assert.equal(source.split(marker).length,2);
 source=source.slice(0,source.indexOf(marker));
 source=once(source,"const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));",`const sourceRoot=${JSON.stringify(root)};`);
 source=once(source,'process.env.HALDIR_ENTRYPOINT_EVIDENCE_DIR','process.env.HALDIR_FAULT_EVIDENCE_DIR');
 source+='\nexport {tree,launch,login,call};\n';
 await writeFile(join(dir,'accepted-harness.mjs'),source);
 return import(pathToFileURL(join(dir,'accepted-harness.mjs')).href);
}
export async function adaptFixture(f,fault){
 assert.ok(['unknown','deadline'].includes(fault));
 const path=join(f.root,'deployment/haldir-public/operational-entrypoint-fixture.mjs');
 let source=await readFile(path,'utf8');assert.equal(sha(source),pins['operational-entrypoint-fixture.mjs']);
 source=once(source,'  const deny = () => {',`  let runSignal, releaseHold;
  const held=new Promise(resolve=>{releaseHold=resolve;});
  c.fault={kind:${JSON.stringify(fault)},signedCommits:0,holdEntered:0,holdReleased:0,hiddenReads:0,lateSigns:0,revealed:false};
  const deny = () => {`);
 source=once(source,"state.orders.push({order_id:q.orderId,recipient:q.vendorId,amount:q.amountAtomic,state:'paid'});result=e.finalTransaction;",`state.orders.push({order_id:q.orderId,recipient:q.vendorId,amount:q.amountAtomic,state:'paid'});result=e.finalTransaction;
      if(c.fault.kind==='unknown'&&c.sends===1){c.fault.lostHash=txHash;c.fault.causalReceiptIds=e.receipts.map(r=>r.receipt_id);throw Error('SYNTHETIC_ACCEPTED_RESPONSE_LOST');}`);
 source=once(source,"assert.equal(p.wait_until,'FINAL');result=txs.get(p.tx_hash);",`assert.equal(p.wait_until,'FINAL');if(p.tx_hash===c.fault.lostHash&&!c.fault.revealed){c.fault.hiddenReads++;throw Error('SYNTHETIC_SAME_EVIDENCE_UNAVAILABLE');}result=txs.get(p.tx_hash);`);
 source=once(source,'c.signs++;return sign.apply(this,args);','if(runSignal?.aborted)c.fault.lateSigns++;c.signs++;return sign.apply(this,args);');
 source=once(source,'globalThis.__operationalFixture={c,localQualification,openRepository};',`globalThis.__operationalFixture={c,localQualification,openRepository,observeRunSignal:signal=>{runSignal=signal;c.fault.signalStartedAt=performance.now();signal.addEventListener('abort',()=>{c.fault.abortedAt=performance.now();c.fault.aborted=true;c.fault.abortCode=signal.reason?.code;c.fault.abortMessage=signal.reason?.message;},{once:true});}};`);
 source=once(source,"return real.createTrustedComposition({repository${f.replay?'':',localQualification:f.localQualification'}});", "const graph=real.createTrustedComposition({repository${f.replay?'':',localQualification:f.localQualification'}});if(f.replay)return graph;return {...graph,trustedSignerProvider:async input=>{globalThis.__operationalFixture.observeRunSignal(input.signal);return graph.trustedSignerProvider(input);}};");
 source=once(source,'    return repository;\n',`    const originalTransaction=repository.runTransaction;
    repository.runTransaction=async fn=>{
      let signed;
      const result=await originalTransaction(tx=>fn({...tx,set:(collection,key,value)=>{
        if(collection==='nativeOperations'&&value.phase==='BROADCAST_INTENT')signed={key,value:structuredClone(value)};
        return tx.set(collection,key,value);
      }}));
      if(signed){c.fault.signedCommits++;if(c.fault.kind==='deadline'&&c.fault.signedCommits===2){
        c.fault.holdEntered++;c.fault.heldKey=signed.key;c.fault.heldHash=signed.value.transactionHash;c.fault.holdEnteredAt=performance.now();
        await held;c.fault.holdReleased++;c.fault.holdReleasedAt=performance.now();
      }}
      return result;
    };
    return repository;
`);
 source=once(source,"    if(m.kind==='recover-cache'){",`    if(m.kind==='fault-state'){process.send({id:m.id,fault:c.fault});
    }else if(m.kind==='release-hold'){assert.equal(c.fault.holdEntered,1);releaseHold();process.send({id:m.id});
    }else if(m.kind==='reveal-same-evidence'){assert.ok(c.fault.lostHash);c.fault.revealed=true;process.send({id:m.id,hash:c.fault.lostHash,receiptIds:c.fault.causalReceiptIds});
    }else if(m.kind==='reopen-lookup'){
      const reopened=openLocalRepository({filename:f.sqlite,localTestOnly:true});
      const before={signs:c.signs,sends:c.sends,inference:c.inference.length};
      const {createNearMandateExecution}=await import(at('src/server/near-mandate.mjs'));
      const op=await reopened.runTransaction(tx=>tx.get('nativeOperations',m.quoteId));assert.ok(op?.transactionHash);
      let result;try{const execution=createNearMandateExecution({repository:reopened,binding:b,rpcUrl:approved.rpcUrl,allowedRpcUrls:approved.allowedRpcUrls,signer:{getPublicKey:()=>assert.fail('lookup cannot resolve signer'),signTransaction:()=>assert.fail('lookup cannot sign')}});result=await execution.lookup(op.request);}finally{reopened.close();}
      assert.deepEqual({signs:c.signs,sends:c.sends,inference:c.inference.length},before);
      process.send({id:m.id,result,op,before,reopened:true,closed:true});
    }else if(m.kind==='recover-cache'){`);
 // Snapshot additional incumbent run/guard rows without modifying application code.
 source=once(source,"['jobs','mandates','quotes','orders','nativeOperations'","['agentRuns','publicRunGuards','jobs','mandates','quotes','orders','nativeOperations'");
 await writeFile(path,source);
 return {acceptedFixtureHash:pins['operational-entrypoint-fixture.mjs'],adaptedFixtureHash:sha(source),fault};
}
export async function inputHashes(){
 const {requiredRuntimeSources,optionalRuntimeSources}=await import('./package-runtime.mjs');
 for(const p of ['operational-faults-fixture.mjs','operational-faults.test.mjs'])assert.equal([...requiredRuntimeSources,...optionalRuntimeSources].includes('deployment/haldir-public/'+p),false,'test-only helper must stay outside runtime allowlist');
 const paths=[...new Set([...requiredRuntimeSources,...optionalRuntimeSources,
  'deployment/haldir-public/package-runtime.mjs',...Object.keys(pins).map(p=>'deployment/haldir-public/'+p),
  'deployment/haldir-public/operational-faults.test.mjs','deployment/haldir-public/operational-faults-fixture.mjs',
  'target/mandate-wasm/u01_mandate_proof.wasm','target/mandate-factory-wasm/u01_mandate_factory.wasm'])].filter(p=>!['src/server/trusted-public-manifest.mjs','deployment/haldir-public/trusted-manifest.mjs'].includes(p));
 const hashes={};for(const p of paths)hashes[p]=sha(await readFile(join(root,p)));return hashes;
}
