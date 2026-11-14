import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrders,openLocalRepository } from '../../src/server/orders.mjs';
import { createJobRunner } from '../../src/agent/run-job.mjs';
import { syntheticPayment, fictionalArtifact } from '../../src/vendor/fixture.mjs';
for(const mode of ['unknown','lost-submit','reserved-before-submit'])test(`TS1 ${mode} never advances second payment or re-submits first on resume`,async t=>{
 const h=await fixture(t),healthySubmit=h.ports.paymentExecution.submit;
 if(mode==='reserved-before-submit'){
   const original=h.repository.runTransaction;let armed=true;
   // Commit-before-throw is the actual crash boundary, not a rolled-back intent.
   h.ports.repository={async runTransaction(cb){const value=await original(cb);if(armed&&value?.sourceRuns?.[0].paymentAttempted){armed=false;throw new Error('process interruption');}return value;}};
   await assert.rejects(h.runner().runJob(h.input),/process interruption/);h.ports.repository=h.repository;
 }else h.ports.paymentExecution.submit=async x=>{h.calls.submit.push(x);if(mode==='lost-submit')throw new Error('lost response');return {status:'unknown'};};
 let run=await h.runner().runJob(h.input);assert.equal(run.stage,'PAYMENT_UNKNOWN');assert.equal(run.sourceRuns[1].paymentAttempted,false);
 const submits=h.calls.submit.length;await h.runner().runJob(h.input);assert.equal(h.calls.submit.length,submits);assert.equal(h.calls.model.length,1);
 assert.deepEqual(run.report.nextCheck,{code:'CHECK_SAME_PAYMENT',sourceId:'company-records'});
 h.paid.add('source-0');h.ports.paymentExecution.submit=healthySubmit;run=await h.runner().runJob(h.input);assert.equal(run.stage,'COMPLETE');assert.equal(h.calls.submit.filter(x=>x.quote.orderId==='source-0').length,submits);assert.equal(h.calls.model.length,2);
});
for(const mode of ['stop','expiry'])test(`TS1 ${mode} between sources blocks only new payment and retains paid delivery recovery`,async t=>{
 const h=await fixture(t),submit=h.ports.paymentExecution.submit;
 h.ports.paymentExecution.submit=async x=>{const result=await submit(x);if(mode==='stop')await h.orders.stopLocalJob(h.input);else h.expire();return result;};
 const run=await h.runner().runJob(h.input);assert.equal(run.stage,'BLOCKED');assert.equal(h.calls.submit.length,1);assert.equal(run.sourceRuns[1].paymentAttempted,false);
 assert.equal(run.report.facts.length,1);assert.equal(run.report.purchases[0].lifecycle,'DELIVERED');assert.equal(run.report.purchases[1].proofId,null);
 assert.ok(run.report.missing.includes(`background-research:${mode==='stop'?'OWNER_STOPPED':'DEADLINE_EXPIRED'}`));assert.deepEqual(run.report.nextCheck,{code:'OWNER_REVIEW',sourceId:'background-research'});
});
test('TS1 first delivery failure does not block second proof and report inference waits for both durable artifacts',async t=>{
 const h=await fixture(t),retrieve=h.orders.retrieveDelivery;let unavailable=true;
 h.orders.retrieveDelivery=async x=>{if(unavailable&&x.quoteId===h.job.quoteId)throw new Error('delivery unavailable');return retrieve(x);};
 let run=await h.runner().runJob(h.input);assert.equal(h.calls.submit.length,2);assert.equal(h.calls.model.length,1);assert.equal(run.report.facts.length,1);assert.equal(run.report.facts[0].sourceId,'background-research');assert.equal(run.report.interpretations.length,0);assert.deepEqual(run.report.nextCheck,{code:'RETRIEVE_SAME_DELIVERY',sourceId:'company-records'});
 unavailable=false;await h.orders.stopLocalJob(h.input);run=await h.runner().runJob(h.input);assert.equal(run.stage,'COMPLETE');assert.equal(h.calls.model.length,2);assert.equal(h.calls.submit.length,2);
});
for(const mode of ['throw','one-source','invented-excerpt','assurance','bad-consistency'])test(`TS1 report ${mode} falls back to exact excerpts without reinference or repayment`,async t=>{
 const h=await fixture(t),propose=h.ports.model.propose;
 h.ports.model.propose=async x=>{if(x.phase==='plan')return propose(x);h.calls.model.push(x);if(mode==='throw')throw new Error('response lost');const findings=x.evidence.map(a=>({artifactId:a.artifactId,excerpt:a.content.slice(0,50)}));if(mode==='one-source')findings.pop();if(mode==='invented-excerpt')findings[1].excerpt='Supplier is verified';return {findings,interpretations:mode==='bad-consistency'?[{kind:'COMPARE_SOURCE_CONSISTENCY',findingIndexes:[0]}]:[],...(mode==='assurance'?{supplierVerified:true}:{})};};
 let run=await h.runner().runJob(h.input);assert.equal(run.stage,'PARTIAL');assert.equal(run.report.facts.length,2);assert.equal(run.report.interpretations.length,0);assert.ok(run.report.limits.includes('MODEL_REPORT_UNAVAILABLE'));
 run=await h.runner().runJob(h.input);assert.equal(run.stage,'PARTIAL');assert.equal(h.calls.model.length,2);assert.equal(h.calls.submit.length,2);
});
test('TS1 concurrent pending plan consumes once and stale completion cannot release payment',async t=>{
 const h=await fixture(t);let entered,release;const started=new Promise(r=>{entered=r;}),held=new Promise(r=>{release=r;}),propose=h.ports.model.propose;
 h.ports.model.propose=async x=>{entered();await held;return propose(x);};
 const first=h.runner().runJob(h.input),rejected=assert.rejects(first,{code:'RUN_SUPERSEDED'});await started;
 const second=await h.runner().runJob(h.input);release();await rejected;assert.equal(second.planState,'UNAVAILABLE');assert.equal(h.calls.submit.length,0);assert.equal(h.calls.model.length,1);
});

for(const boundary of ['before-inference','after-output'])test(`TS1 report interruption ${boundary} remains consumed and never authorizes inference or payment retry`,async t=>{
 const h=await fixture(t),original=h.repository.runTransaction;let armed=true;
 h.ports.repository={async runTransaction(cb){let stop=false;const value=await original(async tx=>cb({...tx,set(c,k,v){if(armed&&c==='agentRuns'&&(boundary==='before-inference'?v.stage==='REPORT_PENDING':v.stage==='COMPLETE')){armed=false;if(boundary==='after-output')throw new Error('report persistence failure');stop=true;}tx.set(c,k,v);}}));if(stop)throw new Error('report intent committed response lost');return value;}};
 await assert.rejects(h.runner().runJob(h.input),/report/);const calls=h.calls.model.length;h.ports.repository=h.repository;
 const result=await h.runner().runJob(h.input);assert.equal(result.stage,'PARTIAL');assert.equal(result.report.facts.length,2);assert.ok(result.report.limits.includes('MODEL_REPORT_UNAVAILABLE'));assert.equal(h.calls.model.length,calls);assert.equal(h.calls.submit.length,2);
});

test('TS1 cached interpretation cannot bypass advisory allowlist on replay',async t=>{
 const h=await fixture(t);await h.runner().runJob(h.input);
 await h.repository.runTransaction(async tx=>{const run=await tx.get('agentRuns',h.job.jobId);run.report.interpretations=[{kind:'SUPPLIER_SAFE',findingIndexes:[0,1]}];tx.set('agentRuns',h.job.jobId,run);});
 await assert.rejects(h.runner().runJob(h.input),{code:'APPROVAL_CHANGED'});assert.equal(h.calls.model.length,2);assert.equal(h.calls.submit.length,2);
});

for(const mutate of [x=>{x.arguments.quoteIds.reverse();},x=>{x.arguments.vendorId='evil.testnet';},x=>{x.tool='withdraw';},x=>{x.arguments.quoteIds[1]='new-quote';}])test(`TS1 plan injection ${mutate.toString()} is consumed once with no payment`,async t=>{
 const h=await fixture(t);h.ports.model.propose=async x=>{h.calls.model.push(x);const output={tool:'requestquotes',arguments:{quoteIds:h.job.sourceRefs.map(s=>s.quoteId)}};mutate(output);return output;};
 const first=await h.runner().runJob(h.input);assert.equal(first.planState,'UNAVAILABLE');assert.equal(h.calls.submit.length,0);await h.runner().runJob(h.input);assert.equal(h.calls.model.length,1);assert.equal(h.calls.submit.length,0);
});

// Scenario-only semantic oracle: shared legitimate facts remain allowed by TS1.
function assertNorthwindReport(report) {
 const records=report.facts.filter(f=>f.sourceId==='company-records').map(f=>f.excerpt).join('\n');
 const research=report.facts.filter(f=>f.sourceId==='background-research').map(f=>f.excerpt).join('\n');
 assert.match(records,/Legal name: Northwind Print Ltd \(fictional\)/,'company-records must supply the fictional legal name');
 assert.match(records,/Registration: NW-FICTION-2048/);
 assert.match(records,/Registered address: 14 Paper Lane, Testhaven/);
 assert.match(research,/registration NW-FICTION-2048.*14 Paper Lane, Testhaven.*match/);
 assert.match(research,/self-reported at 12,000 cartons per month/);
 assert.match(research,/Certification gap: ISO 9001 certificate number, issuer and expiry are not documented/);
 assert.match(research,/Next check: Before signing, request the ISO 9001 certificate number, issuer and expiry/);
 assert.match(research,/compare the certificate's legal name and site address with registration NW-FICTION-2048/);
 assert.deepEqual(report.interpretations,[{kind:'COMPARE_SOURCE_CONSISTENCY',findingIndexes:[0,1]},{kind:'COMPARE_COMPANY_DETAILS',findingIndexes:[0,2,3]}]);
 assert.deepEqual(report.nextCheck,{code:'COMPARE_SOURCES_WITH_CONTRACT',sourceId:null});
 assert.ok(['FICTIONAL_SAMPLE','SOURCE_ACCURACY_NOT_VERIFIED','NO_SIGNING_ASSURANCE'].every(x=>report.limits.includes(x)));
 assert.equal(report.supplierVerified,false);
 assert.equal(report.fictionalSample,true);
}

// The synthetic model selects actual document lines; it does not supply facts
// from a second fixture. Orders, artifact generation, proof validation, report
// substring/provenance validation and durable replay are the real implementations.
function northwindModel(h, mode='substantive') {
 h.ports.model.propose=async input=>{
   h.calls.model.push(structuredClone(input));
   if(input.phase==='plan')return {tool:'requestquotes',arguments:{quoteIds:input.approvedSources.map(s=>s.quoteId)}};
   const [records,research]=input.evidence;
   const extract=(a,label)=>a.content.split('\n').find(line=>line.startsWith(label))??a.content;
   const findings=mode==='substantive'?
     [[records,'Company record:'],[research,'Research note:'],[research,'Certification gap:'],[research,'Next check:']].map(([a,label])=>({artifactId:a.artifactId,excerpt:extract(a,label)})):
     input.evidence.map(a=>({artifactId:a.artifactId,excerpt:mode==='common-prefix'?a.content.slice(0,80):a.content.split(' Requested sample:')[0]}));
   return {findings,interpretations:mode==='substantive'?[{kind:'COMPARE_SOURCE_CONSISTENCY',findingIndexes:[0,1]},{kind:'COMPARE_COMPANY_DETAILS',findingIndexes:[0,2,3]}]:[{kind:'COMPARE_SOURCE_CONSISTENCY',findingIndexes:[0,1]}]};
 };
}

test('Northwind actual fictional documents carry complementary evidence, a certification limit and a concrete next check through the real runner',async t=>{
 const h=await fixture(t,{northwind:true});northwindModel(h);
 const run=await h.runner().runJob(h.input);
 assert.equal(run.stage,'COMPLETE');assertNorthwindReport(run.report);
 const members=await h.orders.getOrders(h.input);
 assert.equal(run.report.facts.length,4);
 for(const fact of run.report.facts){
   const member=members.find(m=>m.sourceId===fact.sourceId),{order}=member,a=order.artifact;
   assert.ok(a.content.includes(fact.excerpt),'each useful excerpt must be an actual delivered substring');
   assert.deepEqual({quoteId:fact.quoteId,orderId:fact.orderId,vendorId:fact.vendorId,proofId:fact.proofId,artifactId:fact.artifactId,contentDigest:fact.contentDigest},
     {quoteId:order.quoteId,orderId:order.orderId,vendorId:order.quote.vendorId,proofId:order.proof.proofId,artifactId:a.artifactId,contentDigest:a.contentDigest});
   assert.deepEqual(a,fictionalArtifact({quoteId:order.quoteId,quote:order.quote}));
   assert.equal(fact.fictionalSample,true);
 }
 assert.notEqual(members[0].order.artifact.contentDigest,members[1].order.artifact.contentDigest);
 assert.notEqual(members[0].order.proof.proofId,members[1].order.proof.proofId);
 assert.deepEqual(await h.runner().runJob(h.input),run);
 assert.deepEqual(h.calls.model.map(x=>x.phase),['plan','report']);assert.equal(h.calls.submit.length,2);
 t.diagnostic('NORTHWIND_REPORT '+JSON.stringify(run.report));
});

for(const mode of ['common-prefix','disclaimer'])test(`Northwind scenario acceptance rejects ${mode}-only evidence without universally banning shared source facts`,async t=>{
 const h=await fixture(t,{northwind:true});northwindModel(h,mode);
 const run=await h.runner().runJob(h.input);
 // This is a scenario acceptance oracle, not a new production semantic filter.
 assert.equal(run.stage,'COMPLETE');assert.equal(run.report.facts[0].excerpt,run.report.facts[1].excerpt);
 assert.throws(()=>assertNorthwindReport(run.report),/company-records must supply the fictional legal name/);
 assert.deepEqual(await h.runner().runJob(h.input),run);assert.equal(h.calls.model.length,2);assert.equal(h.calls.submit.length,2);
});

for(const mode of ['model-unavailable','wrong-source-excerpt'])test(`Northwind ${mode} retains useful paid evidence in fallback and replays without new inference or payment`,async t=>{
 const h=await fixture(t,{northwind:true});northwindModel(h);const propose=h.ports.model.propose;
 h.ports.model.propose=async input=>{
   if(input.phase==='plan')return propose(input);
   const output=await propose(input);
   if(mode==='model-unavailable')throw new Error('synthetic model unavailable');
   output.findings[1].excerpt=output.findings[0].excerpt; // Real text, wrong artifact.
   return output;
 };
 const run=await h.runner().runJob(h.input);
 assert.equal(run.stage,'PARTIAL');assert.equal(run.report.facts.length,2);assert.deepEqual(run.report.interpretations,[]);
 assert.match(run.report.facts[0].excerpt,/Registration: NW-FICTION-2048/);
 assert.match(run.report.facts[1].excerpt,/Certification gap: ISO 9001/);
 assert.match(run.report.facts[1].excerpt,/Next check: Before signing, request/);
 assert.ok(run.report.limits.includes('MODEL_REPORT_UNAVAILABLE'));
 assert.deepEqual(run.report.nextCheck,{code:'REVIEW_REPORT_AVAILABILITY',sourceId:null});
 for(const fact of run.report.facts){const {order}= (await h.orders.getOrders(h.input)).find(m=>m.sourceId===fact.sourceId);assert.equal(fact.excerpt,order.artifact.content);assert.equal(fact.proofId,order.proof.proofId);}
 const replay=await h.runner().runJob(h.input);assert.equal(replay.stage,'PARTIAL');assert.deepEqual(replay.report,run.report);
 assert.equal(h.calls.model.length,2);assert.equal(h.calls.submit.length,2);
});

const time=Date.parse('2026-11-13T10:00:00Z');
async function fixture(t, { northwind = false } = {}) {
 const repository=openLocalRepository({filename:':memory:',localTestOnly:true}); t.after(()=>repository.close());
 const jobTerms={networkId:'testnet',mandateId:'two.testnet',purpose:'Fictional supplier research',output:'Evidence brief',budgetAtomic:'30',vendorIds:['registry.testnet','background.testnet'],expiresAt:'2026-11-13T18:00:00Z'};
 const approved={schemaVersion:'haldir.approved.two-source.v1',job:jobTerms,sources:['company-records','background-research'].map((sourceId,i)=>({sourceId,quote:{networkId:'testnet',mandateId:jobTerms.mandateId,vendorId:jobTerms.vendorIds[i],amountAtomic:i?'9':'8',orderId:`source-${i}`,content:northwind?`Northwind fictional sample: ${sourceId}`:`Fictional source ${i}`}}))};
 const paid=new Set(),calls={model:[],submit:[],lookup:[],delivery:[]}; let clock=time;
 const orders=createOrders({repository,localTestOnly:true,now:()=>clock,trustedReceiptCollector:({quote})=>paid.has(quote.orderId)?syntheticPayment(quote,quote.orderId==='source-0'?11:31).evidence:null});
 const job=await orders.createJob({ownerId:'owner.testnet',admissionKey:'two',approved}),input={ownerId:job.ownerId,jobId:job.jobId};
 const retrieve=orders.retrieveDelivery.bind(orders); orders.retrieveDelivery=async x=>{calls.delivery.push(x.quoteId);return retrieve(x);};
 const model={propose:async x=>{calls.model.push(structuredClone(x));return x.phase==='plan'?{tool:'requestquotes',arguments:{quoteIds:job.sourceRefs.map(s=>s.quoteId)}}:{findings:x.evidence.map(a=>({artifactId:a.artifactId,excerpt:a.content.slice(0,100)})),interpretations:[{kind:'COMPARE_SOURCE_CONSISTENCY',findingIndexes:[0,1]}]};}};
 const paymentExecution={submit:async x=>{calls.submit.push(x);paid.add(x.quote.orderId);return {status:'submitted'};},lookup:async x=>{calls.lookup.push(x);return {status:'submitted'};}};
 const ports={repository,orders,model,paymentExecution,now:()=>clock};
 return {repository,orders,job,input,ports,calls,paid,expire:()=>{clock+=86400000;},runner:()=>createJobRunner(ports)};
}
test('TS1 runner sequentially buys two sources with one plan and one provenance-linked report',async t=>{
 const h=await fixture(t),run=await h.runner().runJob(h.input);
 assert.equal(run.schemaVersion,'haldir.agent-run.two-source.v1'); assert.equal(run.stage,'COMPLETE');
 assert.deepEqual(h.calls.submit.map(x=>x.approvedJobInput.quoteId),h.job.sourceRefs.map(x=>x.quoteId));
 assert.deepEqual(h.calls.model.map(x=>x.phase),['plan','report']);
 const orders=await h.orders.getOrders(h.input);
 assert.ok(orders.every(x=>x.order.artifact&&x.order.proof)); assert.notEqual(orders[0].order.proof.proofId,orders[1].order.proof.proofId);
 assert.equal(run.report.facts.length,2); assert.equal(run.report.purchases.length,2); assert.equal(run.report.supplierVerified,false);
 assert.deepEqual(run.report.nextCheck,{code:'COMPARE_SOURCES_WITH_CONTRACT',sourceId:null});
 assert.deepEqual(await h.runner().runJob(h.input),run); assert.equal(h.calls.submit.length,2);assert.equal(h.calls.model.length,2);
 });

 test('TS1 cached report cannot release mutated evidence on replay',async t=>{
 const h=await fixture(t); await h.runner().runJob(h.input);
 await h.repository.runTransaction(async tx=>{const o=await tx.get('orders',h.job.sourceRefs[1].quoteId),d=await tx.get('deliveries',h.job.sourceRefs[1].quoteId);o.artifact.content='Forged supplier assurance';d.artifact=o.artifact;tx.set('orders',o.quoteId,o);tx.set('deliveries',o.quoteId,d);});
 await assert.rejects(h.runner().runJob(h.input),{code:'APPROVAL_CHANGED'});
 assert.equal(h.calls.model.length,2);assert.equal(h.calls.submit.length,2);
 });

for (const phase of ['plan','report']) test(`TS1 trusted cache recovery ${phase} binds identical request and revision without blind propose`, async t => {
 const h=await fixture(t), propose=h.ports.model.propose; let cached, original, recovered=0;
 h.ports.model.contractVersion='haldir.model.runner-recovery.v1';
 h.ports.model.propose=async input=>{const result=await propose(input);if(input.phase===phase&&!cached){cached=result;original=structuredClone(input);throw new Error('saved outward loss');}return result;};
 h.ports.model.recover=async input=>{recovered++;assert.deepEqual(input,original);return cached;};
 const first=await h.runner().runJob(h.input);assert.notEqual(first.stage,'COMPLETE');
 const second=await h.runner().runJob(h.input);assert.equal(second.stage,'COMPLETE');
 assert.equal(recovered,1);assert.equal(h.calls.model.length,2);assert.equal(h.calls.submit.length,2);
});

for (const marker of [undefined,'unknown-version']) test(`TS1 untrusted recovery marker ${marker} cannot convert an arbitrary MODEL_NOT_SENT into retry authority`, async t => {
 const h=await fixture(t);let calls=0,recoveries=0;
 h.ports.model.contractVersion=marker;
 h.ports.model.propose=async()=>{calls++;throw Object.assign(new Error('MODEL_NOT_SENT'),{code:'MODEL_NOT_SENT'});};
 h.ports.model.recover=async()=>{recoveries++;assert.fail('untrusted recovery must not run');};
 await h.runner().runJob(h.input);await h.runner().runJob(h.input);
 assert.equal(calls,1);assert.equal(recoveries,0);assert.equal(h.calls.submit.length,0);
 const run=await h.repository.runTransaction(tx=>tx.get('agentRuns',h.job.jobId));assert.notEqual(run.modelNotAdmitted?.plan,true);
});

test('TS1 cache adoption retains durable revision exclusion against stale completion', async t => {
 const h=await fixture(t),propose=h.ports.model.propose;let cached;
 h.ports.model.contractVersion='haldir.model.runner-recovery.v1';
 h.ports.model.propose=async input=>{const result=await propose(input);if(input.phase==='report'){cached=result;throw new Error('lost report');}return result;};
 h.ports.model.recover=async()=>{
   await h.repository.runTransaction(async tx=>{const run=await tx.get('agentRuns',h.job.jobId);tx.set('agentRuns',h.job.jobId,{...run,revision:run.revision+1});});
   return cached;
 };
 await h.runner().runJob(h.input);
 await assert.rejects(h.runner().runJob(h.input),{code:'RUN_SUPERSEDED'});
 assert.equal(h.calls.model.length,2);assert.equal(h.calls.submit.length,2);
});
