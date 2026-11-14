import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import {syncBuiltinESMExports} from 'node:module';
import {mkdir,writeFile,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {KeyPair,baseEncode,SignedTransaction} from 'near-api-js';
import {createHash} from 'node:crypto';
import {harness,adaptFixture,inputHashes,evidenceDirectory} from './operational-faults-fixture.mjs';
const evidenceTop=await evidenceDirectory(process.env.HALDIR_FAULT_EVIDENCE_DIR,'haldir-operational-fault-evidence-');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const effects=s=>{assert.equal(s.c.rpc.filter(r=>r.method==='send_tx').length,s.c.sends,'count every attempted broadcast, including rejected duplicates');return {signs:s.c.signs,sends:s.c.sends,inference:s.c.inference.length};};
const financial=s=>Object.fromEntries(Object.entries(s.rows).filter(([k])=>/^(nativeOperations|claims|deliveries|modelReservations|modelGrants|modelReleaseSpend|ownerOperations)$/.test(k)));
function outerFence(t){
 const allowed=new Set(),c={forbidden:0},originals=[];
 const deny=()=>{c.forbidden++;throw Error('OUTER_NATIVE_EXTERNAL_DENIED');};
 const replace=(obj,key,value)=>{originals.push([obj,key,obj[key]]);obj[key]=value;};
 const listen=net.Server.prototype.listen;
 replace(net.Server.prototype,'listen',function(...args){if(args[0]!==0||args[1]!=='127.0.0.1')return deny();this.once('listening',()=>allowed.add(this.address().port));return listen.apply(this,args);});
 const connect=net.Socket.prototype.connect;
 replace(net.Socket.prototype,'connect',function(...args){const arg=Array.isArray(args[0])?args[0][0]:args[0];if(!arg||typeof arg!=='object'||arg.host!=='127.0.0.1'||!allowed.has(Number(arg.port)))return deny();return connect.apply(this,args);});
 for(const [obj,key]of [[globalThis,'fetch'],[tls,'connect'],[https,'request'],[https,'get'],[http2,'connect']])replace(obj,key,deny);
 for(const key of ['request','get']){const original=http[key];replace(http,key,function(options,...rest){if(options?.host!=='127.0.0.1'||!allowed.has(Number(options.port)))return deny();return original.call(this,options,...rest);});}
 syncBuiltinESMExports();try{fetch('https://forbidden.invalid/outer-control');assert.fail('outer fence missing');}catch(e){assert.equal(e.message,'OUTER_NATIVE_EXTERNAL_DENIED');c.negativeControl=1;}assert.equal(c.forbidden,1);t.after(()=>{for(const [obj,key,value]of originals.reverse())obj[key]=value;syncBuiltinESMExports();});
 return {allowed,c};
}
function signedIdentity(op){
 assert.equal(op.phase,'BROADCAST_INTENT');assert.ok(op.signedTransaction);
 const decoded=SignedTransaction.decode(Buffer.from(op.signedTransaction,'base64'));
 assert.equal(baseEncode(createHash('sha256').update(decoded.transaction.encode()).digest()),op.transactionHash);
 assert.equal(decoded.transaction.signerId,op.binding.signerId);assert.equal(decoded.transaction.receiverId,op.binding.mandateId);
 assert.equal(op.operationId,op.request.operationId);assert.equal(op.jobId,op.request.approvedJobInput.jobId);
 return {operationId:op.operationId,transactionHash:op.transactionHash,signedTransaction:op.signedTransaction};
}
for(const fault of ['unknown','deadline'])test(`operational actual main composed ${fault}: retained identity and no unauthorized extra effects`,{timeout:55000},async t=>{
 assert.equal(process.versions.node,'26.13.1');
 const evidence=join(evidenceTop,fault);await mkdir(evidence,{recursive:true});process.env.HALDIR_FAULT_EVIDENCE_DIR=evidence;
 const before=await inputHashes(),fence=outerFence(t),api=await harness(t),pair=KeyPair.fromRandom('ed25519');
 const f=await api.tree(t,'auto',pair.getPublicKey().toString());fence.allowed.add(f.p);
 const adaptation=await adaptFixture(f,fault);const h=await api.launch(t,f);let stopped=false,released=false;
 const trace={classification:'LOCAL_SYNTHETIC_ACTUAL_MAIN_SQLITE_NOT_CHAIN_PROVIDER_FIRESTORE_OR_BROWSER_PROOF',fault,adaptation,before};
 try{
  const initial=await h.snapshot();for(const rows of Object.values(initial.rows))assert.equal(rows.length,0);
  assert.deepEqual(initial.c.seeds,['publicApprovals']);assert.deepEqual(effects(initial),{signs:0,sends:0,inference:0});
  const headers=await api.login(f.p,pair),req=(path,body={})=>api.call(f.p,path,body,headers);
  const a=await req('/api/public/jobs',{approvalId:'operational-approval',admissionKey:'operational-fault-'+fault});assert.equal(a.status,201,a.text);
  const jobId=a.body.job.jobId,path=`/api/public/jobs/${jobId}`,refs=a.body.job.sourceRefs;trace.jobId=jobId;trace.sourceRefs=refs;
  const prepared=await req(path+'/owner/prepare',{action:'create'});assert.equal(prepared.status,200,prepared.text);assert.equal(prepared.body.walletEligible,true);
  const op=prepared.body.operation;assert.equal(op.status,'AWAITING_WALLET');
  const ownerEvidence=await h.command({kind:'owner-evidence',action:'create',request:op.request});
  const created=await req(path+'/owner/receipt',{operationId:op.operationId,transactionHash:ownerEvidence.transactionHash,signerId:'alice.testnet'});
  assert.equal(created.status,200,created.text);assert.equal(created.body.operation.status,'CONFIRMED');assert.equal(created.body.operation.receipt.receiptId,ownerEvidence.receiptId);
  const admitted=await h.snapshot();assert.equal(admitted.rows.jobs[0].value.publicManifest.chainEvidence.deployment,'FACTORY_READY');
  assert.equal(admitted.rows.jobs.length,1);assert.equal(admitted.rows.orders.length,2);assert.equal(admitted.rows.mandates[0].value.jobId,jobId);
  if(fault==='unknown'){
   const run=await req(path+'/run');trace.initialRun=run;assert.equal(run.status,200,run.text);assert.equal(run.body.run.stage,'PAYMENT_UNKNOWN');
   assert.equal(run.body.economics.state,'uncertain');assert.equal(run.body.economics.reason,'OPERATION_UNCERTAIN');
   assert.equal(run.body.run.report.status,'PARTIAL');assert.deepEqual(run.body.run.report.facts,[]);assert.deepEqual(run.body.run.report.nextCheck,{code:'CHECK_SAME_PAYMENT',sourceId:refs[0].sourceId});
   assert.ok(run.body.run.report.missing.includes(refs[0].sourceId+':PAYMENT_EVIDENCE_UNAVAILABLE'));
   let s=await h.snapshot();trace.unknownSnapshot=s;assert.deepEqual(effects(s),{signs:1,sends:1,inference:1});assert.ok(s.c.fault.hiddenReads>0);assert.equal(s.c.fault.signedCommits,1);
   assert.equal(s.rows.nativeOperations.length,1);assert.equal(s.rows.claims.length,0);assert.equal(s.rows.deliveries.length,0);assert.equal(s.rows.modelReservations.length,1);
   assert.equal(s.c.inference[0].phase,'plan');assert.equal(s.state.spent,'8');assert.equal(s.state.orders.length,1);
   assert.equal(run.body.orders[1].payment.status,'NOT_STARTED');assert.equal(run.body.orders[1].order.proof,null);
   const native=s.rows.nativeOperations[0].value,identity=signedIdentity(native);assert.equal(native.transactionHash,s.c.fault.lostHash);assert.equal(native.jobId,jobId);assert.equal(native.quote.amountAtomic,'8');
   trace.lookup=await h.command({kind:'reopen-lookup',quoteId:refs[0].quoteId});assert.equal(trace.lookup.reopened,true);assert.equal(trace.lookup.closed,true);assert.equal(trace.lookup.result.status,'unknown');assert.deepEqual(signedIdentity(trace.lookup.op),identity);
   const heldEffects=effects(s);const read=await req(path);assert.equal(read.body.run.stage,'PAYMENT_UNKNOWN');assert.deepEqual(effects(await h.snapshot()),heldEffects);
   const retry=await req(path+'/resume');assert.equal(retry.status,200,retry.text);assert.equal(retry.body.run.stage,'PAYMENT_UNKNOWN');s=await h.snapshot();assert.deepEqual(effects(s),heldEffects);assert.deepEqual(signedIdentity(s.rows.nativeOperations[0].value),identity);
   trace.reveal=await h.command({kind:'reveal-same-evidence'});assert.equal(trace.reveal.hash,identity.transactionHash);assert.ok(trace.reveal.receiptIds.length>0);
   const afterReveal=await req(path);assert.equal(afterReveal.body.orders[0].order.proof,null,'reveal alone cannot invent settlement');assert.deepEqual(effects(await h.snapshot()),heldEffects);
   const resumed=await req(path+'/resume');trace.resumed=resumed;assert.equal(resumed.status,200,resumed.text);assert.equal(resumed.body.run.stage,'COMPLETE');assert.equal(resumed.body.job.jobId,jobId);assert.deepEqual(resumed.body.job.sourceRefs,refs);assert.equal(resumed.body.job.scope.budgetAtomic,'30');
   assert.equal(resumed.body.orders[0].order.proof.transactionHash,identity.transactionHash);assert.ok(trace.reveal.receiptIds.includes(resumed.body.orders[0].order.proof.payReceiptId));assert.ok(trace.reveal.receiptIds.includes(resumed.body.orders[0].order.proof.transferReceiptId));assert.equal(resumed.body.orders[0].payment.transactionHash,identity.transactionHash);
   assert.equal(resumed.body.run.report.facts.length,2);for(let i=0;i<2;i++){assert.equal(resumed.body.run.report.facts[i].sourceId,refs[i].sourceId);assert.equal(resumed.body.orders[i].order.jobId,jobId);assert.equal(resumed.body.orders[i].order.quoteId,refs[i].quoteId);}
   s=await h.snapshot();assert.deepEqual(effects(s),{signs:2,sends:2,inference:2});assert.deepEqual(signedIdentity(s.rows.nativeOperations.find(r=>r.key===refs[0].quoteId).value),identity);assert.equal(s.rows.claims.length,2);assert.equal(s.rows.deliveries.length,2);assert.equal(s.state.spent,'17');assert.equal(s.c.inference.filter(r=>r.phase==='plan').length,1);assert.equal(s.c.inference.filter(r=>r.phase==='report').length,1);
   assert.equal((await req(path+'/resume')).body.run.stage,'COMPLETE');assert.deepEqual(effects(await h.snapshot()),effects(s));
  }else{
   const started=performance.now();let settled=false;const pending=req(path+'/run').then(r=>{settled=true;return r;});
   let faultState;const until=performance.now()+25000;
   while(true){faultState=(await h.command({kind:'fault-state'})).fault;if(faultState.aborted)break;if(performance.now()>until)throw Error('HARNESS_ORIGINAL_ABORT_NOT_OBSERVED');await pause(80);}
   trace.abort=faultState;assert.equal(faultState.abortCode,'EXECUTION_DEADLINE','observe the original public run signal, not custody cleanup');assert.equal(faultState.holdEntered,1,'second semantic signed commit must be held');assert.equal(faultState.signedCommits,2);assert.equal(faultState.holdReleased,0);assert.equal(settled,false,'request must drain its held operation, not timeout harness');
   assert.ok(performance.now()-started>=19500,'real 20s shared timer, no clock patch');assert.ok(faultState.abortedAt-faultState.signalStartedAt>=19500);assert.ok(faultState.abortedAt-faultState.signalStartedAt<23000);
   let s=await h.snapshot();trace.heldSnapshot=s;assert.deepEqual(effects(s),{signs:2,sends:1,inference:1});assert.equal(s.c.fault.lateSigns,0);assert.equal(s.rows.nativeOperations.length,2);
   const first=s.rows.orders.find(r=>r.key===refs[0].quoteId).value;assert.equal(first.lifecycle,'DELIVERED');assert.ok(first.proof);assert.ok(first.artifact);assert.equal(s.rows.claims.length,1);assert.equal(s.rows.deliveries.length,1);
   const native=s.rows.nativeOperations.find(r=>r.key===refs[1].quoteId).value,identity=signedIdentity(native);assert.equal(native.transactionHash,faultState.heldHash);assert.equal(native.jobId,jobId);assert.equal(native.quote.amountAtomic,'9');
   await h.command({kind:'release-hold'});released=true;const response=await pending;trace.deadlineResponse=response;
   assert.equal(response.status,503,response.text);assert.equal(response.body.error,'EXECUTION_DEADLINE');
   s=await h.snapshot();assert.equal(s.c.fault.holdReleased,1);assert.ok(s.c.fault.holdReleasedAt>=s.c.fault.abortedAt);assert.equal(s.c.fault.lateSigns,0);assert.deepEqual(effects(s),{signs:2,sends:1,inference:1});
   trace.lookup=await h.command({kind:'reopen-lookup',quoteId:refs[1].quoteId});assert.equal(trace.lookup.result.status,'unknown');assert.deepEqual(signedIdentity(trace.lookup.op),identity);
   const view=await req(path);assert.equal(view.status,200,view.text);assert.equal(view.body.orders[0].order.proof.proofId,first.proof.proofId);assert.equal(view.body.orders[1].payment.status,'SUBMITTED');assert.equal(view.body.orders[1].order.proof,null);assert.equal(view.body.economics.state,'uncertain');assert.notEqual(view.body.run.stage,'COMPLETE');
   const resume=await req(path+'/resume');trace.resumed=resume;assert.equal(resume.status,200,resume.text);assert.notEqual(resume.body.run.stage,'COMPLETE');assert.equal(resume.body.run.report.status,'PARTIAL');assert.equal(resume.body.run.report.facts.length,1);assert.equal(resume.body.run.report.facts[0].proofId,first.proof.proofId);assert.deepEqual(effects(await h.snapshot()),{signs:2,sends:1,inference:1});
   assert.deepEqual(signedIdentity((await h.snapshot()).rows.nativeOperations.find(r=>r.key===refs[1].quoteId).value),identity);
  }
  const final=await h.snapshot();trace.final=final;assert.equal(final.c.fault.lateSigns,0);const retained=financial(final);
  trace.child=await h.stop();stopped=true;assert.equal(trace.child.argv[1],f.entry);assert.equal(trace.child.hooks.length,2);assert.equal(trace.child.forbidden,1);assert.equal(trace.child.negativeControl,1);assert.throws(()=>process.kill(trace.child.pid,0),{code:'ESRCH'});
  // Default process reopen is intentionally financially closed, even after the qualified run.
  const replay=await api.launch(t,f,true);fence.allowed.add(f.p);
  const replayHeaders=await api.login(f.p,pair),replayCall=(suffix,body={})=>api.call(f.p,path+suffix,body,replayHeaders);
  const reopened=await replayCall('');assert.equal(reopened.status,200,reopened.text);assert.equal(reopened.body.job.jobId,jobId);assert.equal((await replayCall('/resume')).status,503);
  const r=await replay.snapshot();assert.deepEqual(financial(r),retained);assert.deepEqual(effects(r),{signs:0,sends:0,inference:0});assert.equal(r.c.resolutions,0);assert.deepEqual(r.c.seeds,[]);trace.defaultReopen=r;
  trace.replayChild=await replay.stop();assert.throws(()=>process.kill(trace.replayChild.pid,0),{code:'ESRCH'});
  assert.equal(fence.c.forbidden,1,'only deliberate outer control');assert.equal(fence.c.negativeControl,1);trace.outerFence=fence.c;trace.after=await inputHashes();assert.deepEqual(trace.after,before);trace.status='PASS';
 }finally{
  if(!released&&fault==='deadline'){const state=await h.command({kind:'fault-state'}).catch(()=>null);if(state?.fault.holdEntered===1)await h.command({kind:'release-hold'}).catch(()=>{});}
  if(!stopped){trace.failureSnapshot=await h.snapshot().catch(e=>({error:e.message}));trace.child=await h.stop().catch(e=>({error:e.message}));}
  await writeFile(join(evidence,'trace.json'),JSON.stringify(trace,null,2));
 }
});
