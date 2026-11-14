import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer,request} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm,realpath,stat,access,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname,basename,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {KeyPair} from 'near-api-js';
import {serializeMessageNep413} from '@meteorwallet/sdk';
import {requiredRuntimeSources,optionalRuntimeSources} from './package-runtime.mjs';

const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
const origin='https://haldir.ldt.sh';
const configured={HALDIR_APPROVED_ORIGIN:origin,GOOGLE_CLOUD_PROJECT:'loadout-haldir-demo',HALDIR_PROJECT_NUMBER:'147018706305',HALDIR_REGION:'europe-west1',HALDIR_FIRESTORE_DATABASE_ID:'haldir'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function approvedTempRoot(){
 const value=process.env.TMPDIR;
 assert.ok(typeof value==='string'&&isAbsolute(value),'APPROVED_TMPDIR_REQUIRED');
 try{const root=await realpath(value);assert.ok((await stat(root)).isDirectory());await access(root,constants.W_OK|constants.X_OK);return root;}
 catch{throw Error('APPROVED_TMPDIR_UNAVAILABLE_OR_NOT_WRITABLE');}
}
const tempRoot=await approvedTempRoot();
async function evidenceDirectory(value,prefix){
 if(value===undefined)return mkdtemp(join(tempRoot,prefix));
 assert.ok(typeof value==='string'&&isAbsolute(value),'EVIDENCE_DIR_ABSOLUTE_REQUIRED');
 let parent=resolve(value),parts=[];
 while(true){try{parent=await realpath(parent);break;}catch(e){if(e.code!=='ENOENT')throw e;parts.unshift(basename(parent));parent=dirname(parent);}}
 const target=join(parent,...parts),inside=relative(tempRoot,target);
 assert.ok(inside&&inside!=='..'&&!inside.startsWith('..'+sep)&&!isAbsolute(inside),'EVIDENCE_DIR_OUTSIDE_APPROVED_TMPDIR');
 await mkdir(target,{recursive:true});assert.deepEqual(await readdir(target),[],'EVIDENCE_DIR_NOT_EMPTY');return target;
}
const evidence=await evidenceDirectory(process.env.HALDIR_ENTRYPOINT_EVIDENCE_DIR,'haldir-operational-entrypoint-evidence-');
const selected=[...new Set([...requiredRuntimeSources,...optionalRuntimeSources])].filter(p=>!['src/server/trusted-public-manifest.mjs','deployment/haldir-public/trusted-manifest.mjs'].includes(p));
async function port(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function call(p,path,body,headers={}){return new Promise((resolve,reject)=>{
 const q=request({host:'127.0.0.1',port:p,path,method:body===undefined?'GET':'POST',headers:{host:'haldir.ldt.sh',origin,'x-haldir-csrf':'1','content-type':'application/json',...headers}},r=>{const parts=[];r.on('data',b=>parts.push(b));r.on('error',reject);r.on('end',()=>{const text=Buffer.concat(parts).toString();let body;try{body=JSON.parse(text);}catch{}resolve({status:r.statusCode,headers:r.headers,text,body});});});
 q.setTimeout(30000,()=>q.destroy(Error('FINITE_HTTP_TIMEOUT')));q.on('error',reject);q.end(body===undefined?undefined:JSON.stringify(body));
});}
async function tree(t,mode,ownerKey){
 const root=await mkdtemp(join(tempRoot,'haldir-operational-entrypoint-')),before={},children=[];
 t.after(async()=>{for(const child of children){if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}}await rm(root,{recursive:true,force:true});});
 for(const path of [...selected,'deployment/haldir-public/operational-entrypoint-fixture.mjs','deployment/haldir-public/operational-entrypoint.test.mjs','deployment/haldir-public/package-runtime.mjs','target/mandate-wasm/u01_mandate_proof.wasm','target/mandate-factory-wasm/u01_mandate_factory.wasm']){
   let bytes;try{bytes=await readFile(join(sourceRoot,path));}catch(e){throw Error(`SETUP_BLOCKED: ${path}: ${e.code}`);}
   before[path]=sha(bytes);await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes);
 }
 await symlink(join(sourceRoot,'node_modules'),join(root,'node_modules'),'dir');
 await symlink(join(sourceRoot,'deployment/haldir-preview/node_modules'),join(root,'deployment/haldir-preview/node_modules'),'dir');
 const pub=join(root,'deployment/haldir-public');await mkdir(join(pub,'ui/assets'),{recursive:true});await mkdir(join(pub,'ui/fonts'));
 await writeFile(join(pub,'ui/index.html'),'<!doctype html>SYNTHETIC OPERATIONAL TEST ASSETS — NOT BROWSER UI ACCEPTANCE');
 await writeFile(join(pub,'ui/assets/fixture.js'),'/* SYNTHETIC NOT BUILT */');await writeFile(join(pub,'ui/fonts/fixture.txt'),'SYNTHETIC');
 await writeFile(join(pub,'ui-build-receipt.json'),JSON.stringify({approvedOrigin:origin,viteApprovedOrigin:origin,publicMode:'public-testnet',originClassification:'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE'}));
 const p=await port(),config={root,mode,port:p,ownerKey,sqlite:join(root,'operational.sqlite'),checkpoint:join(root,'synthetic-chain.json')};
 await mkdir(join(root,'home'));await mkdir(join(root,'tmp'));
 await writeFile(join(root,'fixture.json'),JSON.stringify(config));
 await writeFile(join(root,'preload.mjs'),`import {readFile} from 'node:fs/promises';import {installClosedFixture} from './deployment/haldir-public/operational-entrypoint-fixture.mjs';await installClosedFixture(JSON.parse(await readFile(new URL('./fixture.json',import.meta.url),'utf8')));`);
 return {root,p,config,before,children,entry:join(pub,'main.mjs')};
}
async function launch(t,f,replay=false){
 if(replay){f.p=await port();await writeFile(join(f.root,'fixture.json'),JSON.stringify({...f.config,port:f.p,replay:true}));}
 const argv=['--import',join(f.root,'preload.mjs'),...(f.config.mode==='auto'||replay?[f.entry]:['--input-type=module','--eval','/* actual exported start runs in the explicitly selected test preload */'])];
 const env={...configured,PORT:String(f.p),HOME:join(f.root,'home'),TMPDIR:join(f.root,'tmp')};
 if(replay)Object.assign(env,{HALDIR_FINANCIAL_ACTIONS:'true',HALDIR_MODEL:'forbidden',HALDIR_QUALIFIED_MODEL:'true',HALDIR_QUALIFIED_SIGNING:'true',HALDIR_SIGNER_MODULE:'https://forbidden.invalid'});
 const child=spawn(process.execPath,argv,{env,stdio:['ignore','pipe','pipe','ipc']});f.children.push(child);let stdout='',stderr='',exited=false;
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const exit=once(child,'exit').then(v=>{exited=true;return v;});const messages=new Map();let serial=0;
 child.on('message',m=>{const waiter=messages.get(m.id);if(waiter){messages.delete(m.id);m.error?waiter.reject(Error(m.error)):waiter.resolve(m);}});
 const command=body=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{messages.delete(id);reject(Error('FINITE_FIXTURE_IPC_TIMEOUT'));},10000);messages.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});child.send({...body,id});});
 const stop=async()=>{if(!exited)child.kill('SIGTERM');const result=await exit;
   const match=stderr.match(/OPERATIONAL_RECEIPT (.+)/);assert.ok(match,stderr);const receipt=JSON.parse(match[1]);
   if(evidence){await mkdir(evidence,{recursive:true});const name=`${f.config.mode}-${replay?'replay':'lifecycle'}`;await writeFile(join(evidence,name+'.stdout.txt'),stdout);await writeFile(join(evidence,name+'.stderr.txt'),stderr);await writeFile(join(evidence,name+'.json'),JSON.stringify({argv,envKeys:Object.keys(env),exit:result,receipt},null,2));}
   assert.deepEqual(result,[0,null],stderr);assert.equal(receipt.pid,child.pid);assert.equal(receipt.ppid,process.pid);assert.equal(receipt.node,'26.13.1');
   assert.equal(receipt.forbidden,1,'only the deliberate denied negative control');assert.equal(receipt.negativeControl,1);assert.equal(receipt.drainedBeforeClose,true);assert.equal(receipt.closes,1);
   await assert.rejects(call(f.p,'/healthz'),{code:'ECONNREFUSED'},'owned listener must close after SIGTERM');
   return receipt;
 };
 t.after(async()=>{if(!exited){child.kill('SIGTERM');let timer;await Promise.race([exit,new Promise(r=>{timer=setTimeout(()=>{child.kill('SIGKILL');r();},9000);})]);clearTimeout(timer);if(evidence){await mkdir(evidence,{recursive:true});const name=`${f.config.mode}-${replay?'replay':'lifecycle'}`;await writeFile(join(evidence,name+'.stdout.txt'),stdout);await writeFile(join(evidence,name+'.stderr.txt'),stderr);await writeFile(join(evidence,name+'-cleanup.json'),JSON.stringify({exit:await exit,argv},null,2));}}});
 const until=Date.now()+10000;
 while(!stdout.includes('LISTENING')){if(exited)throw Error(`SETUP_BLOCKED: child exited before listening: ${stderr}`);if(Date.now()>until)throw Error(`SETUP_BLOCKED: no listening signal: ${stderr}`);await new Promise(r=>setTimeout(r,15));}
 assert.equal((await call(f.p,'/healthz')).status,200);
 return {child,command,stop,snapshot:()=>command({kind:'snapshot'})};
}
async function login(p,pair){
 const challenge=await call(p,'/api/wallet-auth/challenge',{accountId:'alice.testnet',networkId:'testnet'});assert.equal(challenge.status,200,challenge.text);const c=challenge.body;
 const verified=await call(p,'/api/wallet-auth/verify',{accountId:'alice.testnet',networkId:'testnet',challengeId:c.challengeId,publicKey:pair.getPublicKey().toString(),signature:Buffer.from(pair.sign(serializeMessageNep413({...c.payload,nonce:Buffer.from(c.payload.nonce,'base64')})).signature).toString('base64')});
 assert.equal(verified.status,200,verified.text);return{cookie:verified.headers['set-cookie'][0].split(';')[0]};
}
for(const mode of ['exported','auto'])test(`operational ${mode}: post-start admission, real TS1 owner/native/AI, economics, stop/withdraw and persistent replay`,{timeout:60000},async t=>{
 assert.equal(process.versions.node,'26.13.1','SETUP_BLOCKED: select the pinned Node executable');
 const pair=KeyPair.fromRandom('ed25519'),f=await tree(t,mode,pair.getPublicKey().toString()),h=await launch(t,f);
 const initial=await h.snapshot();for(const [name,rows]of Object.entries(initial.rows))assert.equal(rows.length,0,`${name} must not be seeded`);
 assert.deepEqual(initial.c.seeds,['publicApprovals']);assert.equal(initial.c.inference.length,0);assert.equal(initial.c.resolutions,0);
 const headers=await login(f.p,pair),req=(path,body={})=>call(f.p,path,body,headers);
 const preview=await req('/api/public/approvals/read',{approvalId:'operational-approval'});assert.equal(preview.status,200,preview.text);assert.equal(preview.body.ownerCreationRequired,true);
 const a=await req('/api/public/jobs',{approvalId:'operational-approval',admissionKey:'operational-admission'});assert.equal(a.status,201,a.text);
 const jobId=a.body.job.jobId,path=`/api/public/jobs/${jobId}`;assert.match(jobId,/^[a-f0-9-]{36}$/);assert.equal(a.body.job.ownerCreationRequired,true);
 let snapshot=await h.snapshot();assert.equal(snapshot.rows.jobs.length,1);assert.equal(snapshot.rows.jobs[0].value.publicManifest.chainEvidence.deployment,'FACTORY_READY');assert.equal(snapshot.rows.mandates[0].value.jobId,jobId);
 const effects=()=>h.snapshot().then(s=>({inference:s.c.inference.length,signs:s.c.signs,sends:s.c.sends}));
 const beforeRefusal=await effects();assert.equal((await req(path+'/run',{ownerId:'wrong.testnet'})).status,400);assert.deepEqual(await effects(),beforeRefusal);
 const operations=[];
 async function owner(action){
   const prepared=await req(path+'/owner/prepare',{action});assert.equal(prepared.status,200,prepared.text);const op=prepared.body.operation;
   assert.equal(op.status,'AWAITING_WALLET');assert.equal(prepared.body.walletEligible,true);operations.push(op.operationId);
   const synthetic=await h.command({kind:'owner-evidence',action,request:op.request});
   const receipt=await req(path+'/owner/receipt',{operationId:op.operationId,transactionHash:synthetic.transactionHash,signerId:'alice.testnet'});
   assert.equal(receipt.status,200,receipt.text);assert.equal(receipt.body.operation.status,'CONFIRMED',receipt.text);assert.equal(receipt.body.operation.receipt.receiptId,synthetic.receiptId);
   return receipt.body.operation;
 }
 await owner('create');
 const started=performance.now(),run=await req(path+'/run');if(evidence){await writeFile(join(evidence,mode+'-run-response.json'),JSON.stringify({run,snapshot:await h.snapshot()},null,2));}assert.equal(run.status,200,run.text);assert.equal(run.body.run.stage,'COMPLETE',run.text);assert.ok(performance.now()-started<20000);
 assert.equal(run.body.orders.length,2);assert.ok(run.body.orders.every(r=>r.order.lifecycle==='DELIVERED'));
 assert.equal(new Set(run.body.orders.map(r=>r.order.proof.proofId)).size,2);assert.equal(new Set(run.body.orders.map(r=>r.payment.transactionHash)).size,2);
 const report=run.body.run.report;assert.equal(report.supplierVerified,false);assert.equal(report.facts.length,2);assert.match(report.facts.map(f=>f.excerpt).join('\n'),/NW-FICTION-2048/);assert.match(report.facts.map(f=>f.excerpt).join('\n'),/ISO 9001/);assert.match(report.facts.map(f=>f.excerpt).join('\n'),/Next check:/);assert.equal(report.nextCheck.code,'COMPARE_SOURCES_WITH_CONTRACT');
 for(let i=0;i<2;i++){const fact=report.facts[i],order=run.body.orders[i].order;assert.equal(fact.sourceId,a.body.job.sourceRefs[i].sourceId);assert.equal(fact.quoteId,order.quoteId);assert.equal(fact.proofId,order.proof.proofId);assert.equal(fact.contentDigest,order.artifact.contentDigest);assert.ok(fact.excerpt.length>80);}
 const paidEconomics=run.body.economics; // Assert after the rest of the real trace, never fabricate a missing reader.
 snapshot=await h.snapshot();assert.equal(snapshot.c.inference.length,2);assert.equal(snapshot.c.verification,2);assert.equal(snapshot.c.drains,2);assert.equal(snapshot.c.sends,2);assert.equal(snapshot.c.signs,2);assert.equal(snapshot.c.resolutions,1);
 assert.equal(snapshot.rows.modelReservations.length,2);assert.ok(snapshot.rows.modelReservations.every(r=>r.value.state==='COMPLETED_VERIFIED'));assert.equal(snapshot.rows.modelGrants[0].value.calls,2);assert.equal(snapshot.rows.modelReleaseSpend.length,1);
 const reservationTotal=snapshot.rows.modelReservations.reduce((n,r)=>n+BigInt(r.value.reservedCostMicros),0n),grant=snapshot.rows.modelGrants[0].value,release=snapshot.rows.modelReleaseSpend[0].value;
 assert.equal(BigInt(grant.reservedCostMicros),reservationTotal);assert.equal(BigInt(release.reservedCostMicros),reservationTotal);assert.ok(reservationTotal<=BigInt(grant.authorization.maxCostMicros));assert.ok(reservationTotal<=BigInt(release.maxCostMicros));
 for(const name of ['nativeOperations','claims','deliveries'])assert.equal(snapshot.rows[name].length,2);
 const paidEffects=await effects();const recovered=await h.command({kind:'recover-cache'});assert.equal(recovered.results.length,2);assert.deepEqual(recovered.results[0],snapshot.rows.modelReservations.find(r=>r.value.phase==='plan').value.result);assert.deepEqual(recovered.results[1],snapshot.rows.modelReservations.find(r=>r.value.phase==='report').value.result);const resume=await req(path+'/resume');assert.equal(resume.status,200,resume.text);assert.deepEqual(resume.body.run,run.body.run);assert.deepEqual(await effects(),paidEffects);
 await owner('stop');const withdraw=await owner('withdraw');assert.equal(withdraw.receipt.amountAtomic,'13');
 const final=await req(path);assert.equal(final.status,200,final.text);assert.equal(new Set(operations).size,3);
 snapshot=await h.snapshot();const financial=Object.fromEntries(Object.entries(snapshot.rows).filter(([n])=>/^(nativeOperations|claims|deliveries|modelReservations|modelGrants|modelReleaseSpend|ownerOperations)$/.test(n)));
 const firstReceipt=await h.stop();assert.equal(firstReceipt.opens,1);assert.equal(firstReceipt.readiness,1);assert.equal(firstReceipt.constructors,1);
 if(mode==='auto'){assert.equal(firstReceipt.argv[1],f.entry);assert.equal(firstReceipt.hooks.length,2);}
 const replay=await launch(t,f,true);const replayHeaders=await login(f.p,pair);const config=await call(f.p,'/api/public/config',{},replayHeaders);assert.equal(config.body.financialActions,false,'poisoned env cannot enable the default graph');
 const reopened=await call(f.p,path,{},replayHeaders);assert.equal(reopened.status,200,reopened.text);assert.equal((await call(f.p,path+'/resume',{},replayHeaders)).status,503,'default auto-entry cannot reopen financial admission');assert.equal(reopened.body.job.jobId,jobId);assert.deepEqual(reopened.body.run,run.body.run);assert.deepEqual(reopened.body.orders,final.body.orders);
 const after=await replay.snapshot();for(const [name,rows]of Object.entries(financial))assert.deepEqual(after.rows[name],rows,`persistent replay must not mutate ${name}`);
 assert.equal(after.c.inference.length,0);assert.equal(after.c.signs,0);assert.equal(after.c.sends,0);assert.equal(after.c.resolutions,0);assert.deepEqual(after.c.seeds,[]);
 await replay.stop();
 const afterHashes={};for(const p of Object.keys(f.before))afterHashes[p]=sha(await readFile(join(sourceRoot,p)));
 if(evidence)await writeFile(join(evidence,mode+'-trace.json'),JSON.stringify({classification:'LOCAL_SYNTHETIC_SQLITE_NOT_FIRESTORE_CHAIN_PROVIDER_OR_UI_PROOF',jobId,operations,run:run.body,final:final.body,financial,sourceBefore:f.before,sourceAfter:afterHashes,sourceStable:JSON.stringify(f.before)===JSON.stringify(afterHashes)},null,2));
 assert.deepEqual(afterHashes,f.before,'source changed during execution; rerun after writer freeze');
 assert.equal(paidEconomics?.state,'known',`SETUP_BLOCKED: real economics reader not mounted: ${JSON.stringify(paidEconomics)}`);
 assert.deepEqual(paidEconomics.amounts,{capAtomic:'30',spentAtomic:'17',reservedAtomic:'0',availableAtomic:'13',refundedAtomic:'0'});
 assert.equal(final.body.economics.state,'known');assert.equal(final.body.economics.amounts.refundedAtomic,'13');assert.equal(final.body.economics.amounts.availableAtomic,'0');
});
