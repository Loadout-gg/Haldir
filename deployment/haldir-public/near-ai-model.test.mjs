import test from 'node:test';
import assert from 'node:assert/strict';
import { createNearAiModel } from './near-ai-model.mjs';
import { createHash } from 'node:crypto';
import { approvedSources, approvedInput } from '../../src/shared/job-contract.mjs';
import { syntheticPayment, fictionalArtifact } from '../../src/vendor/fixture.mjs';
import { verifyPaymentProof } from '../../src/vendor/payment-proof.mjs';
import { verifiedCompletion } from './near-ai-worker.mjs';
import { createNearAiTransport } from './near-ai-transport.mjs';

const expiresAt = '2026-11-16T23:59:00Z';
const clock = () => Date.parse('2026-11-13T14:00:00Z');

test('unknown owner job is rejected before constructing an inference transport', async () => {
  let transports = 0;
  const repository = { async runTransaction(fn) { return fn({ get: async () => null }); } };
  const model = createNearAiModel({ repository, apiKey: 'synthetic-key-only', authorizationExpiresAt: expiresAt,
    now: clock, transportFactory: () => { transports++; throw new Error('Transport must not start'); } });
  await assert.rejects(model.propose({phase:'plan', approvedJobInput:{jobId:'unknown',ownerId:'owner.testnet'}}),
    { message:'MODEL_INPUT_REJECTED' });
  assert.equal(transports, 0);
});


test('abort during drain never releases a completed plan to the runner',async()=>{
 const f=fixture(),controller=new AbortController(),w=wireHarness(f,{onDrain:()=>controller.abort(new Error('synthetic sensitive reason'))});
 await assert.rejects(w.model().propose({...f.plan,signal:controller.signal}),{message:'MODEL_ABORTED'});
 assert.equal(w.calls,1);assert.equal(w.drains,1);
});

test('output persistence failure consumes the plan and prevents another inference',async()=>{
 const f=fixture(),w=wireHarness(f);f.repository.failCompletion=true;
 await assert.rejects(w.model().propose(f.plan),{message:'MODEL_UNAVAILABLE'});
 f.repository.failCompletion=false;
 await assert.rejects(w.model().propose(f.plan),{message:'MODEL_OUTCOME_UNKNOWN'});
 assert.equal(w.calls,1);assert.equal(f.repository.rows('modelReservations').length,1);
});

test('pre-aborted signal is sanitized and leaves no phase reservation',async()=>{
 const f=fixture(),w=wireHarness(f),controller=new AbortController();controller.abort(new Error('secret canary'));
 await assert.rejects(w.model().propose({...f.plan,signal:controller.signal}),{message:'MODEL_ABORTED'});
 assert.equal(w.calls,0);assert.equal(f.repository.rows('modelReservations').length,0);
});

test('missing atomic-release port blocks before an inference transport',async()=>{
 const f=fixture(),w=wireHarness(f);
 await assert.rejects(w.model({budgetFactory:()=>({reserve:async()=>true})}).propose(f.plan),{message:'MODEL_BUDGET_INTEGRATION_REQUIRED'});
 assert.equal(w.calls,0);assert.equal(w.drains,0);
});


test('actual generic adapter reaches SDK verification with its unchanged token-limit field',async()=>{
 const f=fixture(),w=wireHarness(f);let verifies=0;
 const upstream=w.transportFactory();
 const transportFactory=({apiKey,signal})=>createNearAiTransport({apiKey,signal,run:async input=>({ok:true,...await verifiedCompletion(input,async options=>{
  assert.equal(options.e2ee,true);
  return {sdkVersion:'0.3.0',getSdkError:()=>null,pause:async()=>{},client:{
   fetch:upstream.transport,
   async verifyResponse(id){verifies++;return{id,signatureKind:'provider_tee'};},clearResponseCache(){},
  }};
 })})});
 const model=w.model({transportFactory});
 assert.deepEqual(await model.propose(f.plan),{tool:'requestquotes',arguments:{quoteIds:f.sources.map(s=>s.quoteId)}});
 f.deliver(0);f.deliver(1);await model.propose(f.report());
 assert.equal(w.calls,2);assert.equal(verifies,2);
});


test('legacy plan/report ABI and reconstruction remain supported',async()=>{
 const f=fixture({legacy:true}),w=wireHarness(f);
 assert.deepEqual(await w.model().propose(f.plan),{tool:'requestquote',arguments:f.sources[0].quote});
 f.deliver(0);const result=await w.model().propose(f.report());assert.deepEqual(Object.keys(result),['findings']);
 assert.deepEqual(await w.model().propose(f.report()),result);assert.equal(w.calls,2);
});

test('partial report rejection leaves its one full-evidence attempt available',async()=>{
 const f=fixture(),w=wireHarness(f);await w.model().propose(f.plan);f.deliver(0);
 await assert.rejects(w.model().propose(f.report()),{message:'MODEL_INPUT_REJECTED'});
 assert.equal(f.repository.rows('modelReservations').length,1);
 f.deliver(1);await w.model().propose(f.report());assert.equal(w.calls,2);
});

test('cached result validates both current stored source bindings again',async()=>{
 const f=fixture(),w=wireHarness(f);await w.model().propose(f.plan);
 const q=f.repository.get('quotes',f.sources[1].quoteId);q.quote.vendorId='forged.testnet';f.repository.seed('quotes',f.sources[1].quoteId,q);
 await assert.rejects(w.model().propose(f.plan),{message:'MODEL_INPUT_REJECTED'});assert.equal(w.calls,1);
});

test('corrupted cached output never bypasses production result validation',async()=>{
 const f=fixture(),w=wireHarness(f);await w.model().propose(f.plan);
 const row=f.repository.rows('modelReservations')[0];row.result.arguments.quoteIds.reverse();
 f.repository.seed('modelReservations',reservationKey(row.authorizationId,row.jobId,row.phase),row);
 await assert.rejects(w.model().propose(f.plan),{message:'MODEL_OUTCOME_UNKNOWN'});assert.equal(w.calls,1);
});

test('cached results remain readable after both authorization and purchase deadline',async()=>{
 const f=fixture(),w=wireHarness(f);const result=await w.model().propose(f.plan);
 assert.deepEqual(await w.model({now:()=>Date.parse('2026-11-17T00:00:00Z')}).propose(f.plan),result);assert.equal(w.calls,1);
});

test('concurrent reconstructed callers cannot start a second phase attempt',async()=>{
 const f=fixture();let started,release;
 const ready=new Promise(r=>started=r),held=new Promise(r=>release=r);
 const w=wireHarness(f,{beforeResponse:async()=>{started();await held;}});
 const first=w.model().propose(f.plan);await ready;
 await assert.rejects(w.model().propose(f.plan),{message:'MODEL_OUTCOME_UNKNOWN'});
 release();const result=await first;
 assert.deepEqual(await w.model().propose(f.plan),result);assert.equal(w.calls,1);
});

test('source mutation after budget admission is fenced before SDK transport',async()=>{
 const f=fixture(),w=wireHarness(f);
 const budgetFactory=options=>{
  const port=syntheticBudgetFactory(options);
  return {...port,async reserve(intent){const admitted=await port.reserve(intent);
   const q=f.repository.get('quotes',f.sources[1].quoteId);q.quote.amountAtomic='9';f.repository.seed('quotes',f.sources[1].quoteId,q);return admitted;
  }};
 };
 await assert.rejects(w.model({budgetFactory}).propose(f.plan),{message:'MODEL_UNAVAILABLE'});
 assert.equal(w.calls,0);assert.equal(f.repository.rows('modelReservations').length,1);
});


test('verified receipt retains bounded reasoning overshoot telemetry without raw text',async()=>{
 const f=fixture(),w=wireHarness(f,{reasoningTokens:513});await w.model().propose(f.plan);
 const v=f.repository.rows('modelReservations')[0].verification;
 assert.equal(v.reasoningTokens,513);assert.equal(v.reasoningBudgetExceeded,true);assert.equal(v.signatureLookups,1);
 assert.equal(JSON.stringify(v).includes('synthetic-key-only'),false);
});

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reservationKey=(id,jobId,phase)=>digest(['haldir-model-reservation-v1',id,jobId,phase]);
// Synthetic budget port for facade units only. The separately reconstructed
// budget patch is tested with this facade in the private integration gate.
function syntheticBudgetFactory(options) {
 const {repository,ownerId,jobId,requestDigest}=options;
 return {contractVersion:'haldir.model-budget.atomic-release.v1',reservationKey:phase=>reservationKey(options.authorization.authorizationId,jobId,phase),
  async reserve(intent){return repository.runTransaction(async tx=>{
   const key=reservationKey(intent.authorizationId,jobId,intent.phase),prior=await tx.get('modelReservations',key);
   if(prior)return false;
   tx.create('modelReservations',key,{...intent,ownerId,requestDigest,state:'RESERVED_NO_AUTOMATIC_REFUND'});return true;
  });}
 };
}
function wireHarness(f,{beforeResponse=async()=>{},unverified=false,onDrain=()=>{},reasoningTokens=0}={}) {
 let calls=0,drains=0;
 const transportFactory=()=>{
  let receipt;
  return {async transport(url,init){
   calls++;assert.equal(url,'https://cloud-api.near.ai/v1/chat/completions');
   const body=JSON.parse(init.body),request=JSON.parse(body.messages[1].content);
   assert.equal(body.thinking_token_budget,512);assert.equal('signal' in request,false);
   await beforeResponse(request);
   const result=request.phase==='plan'?(request.approvedSources?{tool:'requestquotes',arguments:{quoteIds:request.approvedSources.map(s=>s.quoteId)}}:
    {tool:'requestquote',arguments:request.approvedQuote}):{findings:request.evidence.map(a=>({artifactId:a.artifactId,excerpt:a.content.slice(0,45)})),
     ...(request.approvedJobInput.sourceRefs?{interpretations:[{kind:'COMPARE_SOURCE_CONSISTENCY',findingIndexes:[0,1]}]}:{})};
   receipt={id:`synthetic-${calls}`,signatureKind:unverified?'gateway':'provider_tee',model:body.model,sdkVersion:'0.3.0',httpStatus:200,e2ee:true,
    usage:{prompt_tokens:100,completion_tokens:Math.max(100,reasoningTokens),total_tokens:100+Math.max(100,reasoningTokens)},reasoningTokens,reasoningBudgetExceeded:reasoningTokens>512,signatureLookups:1,inferenceId:null};
   return new Response(JSON.stringify({id:receipt.id,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(result)}}],usage:receipt.usage}),{status:200,headers:{'content-type':'application/json'}});
  },getReceipt:()=>structuredClone(receipt),async drain(){drains++;await onDrain();}};
 };
 return {transportFactory,get calls(){return calls;},get drains(){return drains;},
  model:extra=>f.model({transportFactory,budgetFactory:syntheticBudgetFactory,reservationKey,...extra})};
}

test('two-source job uses one plan and one report, then replays both from durable results',async()=>{
 const f=fixture(),w=wireHarness(f);
 assert.deepEqual(await w.model().propose(f.plan),{tool:'requestquotes',arguments:{quoteIds:f.sources.map(s=>s.quoteId)}});
 f.deliver(0);f.deliver(1);
 const result=await w.model().propose(f.report());assert.equal(result.findings.length,2);
 assert.deepEqual(result.interpretations,[{kind:'COMPARE_SOURCE_CONSISTENCY',findingIndexes:[0,1]}]);
 assert.equal(w.calls,2);assert.equal(w.drains,2);
 const rows=f.repository.rows('modelReservations');assert.equal(rows.length,2);
 assert.deepEqual(rows.map(r=>r.phase).sort(),['plan','report']);
 assert.equal(new Set(rows.map(r=>r.authorizationId)).size,1);
 f.repository.seed('jobs',f.job.jobId,{...f.job,state:'LOCAL_STOPPED'});
 assert.deepEqual(await w.model().propose(f.plan),{tool:'requestquotes',arguments:{quoteIds:f.sources.map(s=>s.quoteId)}});
 assert.deepEqual(await w.model().propose(f.report()),result);assert.equal(w.calls,2);
});


// Explicit synthetic repository and records: no admission, wallet, RPC or hosted proof.
function memoryRepository() {
  const data = new Map(); let tail = Promise.resolve();
  const key = (collection, id) => JSON.stringify([collection, id]);
  return { data, key, failCompletion: false,
    async runTransaction(fn) {
      const run = tail.then(async () => {
        const next = structuredClone(data); let writing = false;
        const value = await fn({
          get: async (c, id) => { assert.equal(writing, false, 'all reads precede writes'); return structuredClone(next.get(key(c,id)) ?? null); },
          create(c,id,value) { writing=true; assert.equal(next.has(key(c,id)),false); next.set(key(c,id),structuredClone(value)); },
          set: (c,id,value) => { writing=true; if (this.failCompletion && value.state==='COMPLETED_VERIFIED') throw new Error('synthetic persistence failure'); next.set(key(c,id),structuredClone(value)); },
        });
        data.clear(); for (const [k,v] of next) data.set(k,v); return value;
      });
      tail = run.catch(()=>{}); return run;
    },
    seed(c,id,value) { data.set(key(c,id),structuredClone(value)); },
    get(c,id) { return structuredClone(data.get(key(c,id)) ?? null); },
    rows(c) { return [...data].filter(([k])=>JSON.parse(k)[0]===c).map(([,v])=>structuredClone(v)); },
  };
}
function fixture({legacy=false}={}) {
  const repository = memoryRepository();
  const scope = {networkId:'testnet',mandateId:'mandate.testnet',purpose:'Compare fictional samples',output:'Evidence-linked brief',
    budgetAtomic:'100',vendorIds:legacy?['records.testnet']:['records.testnet','research.testnet'],expiresAt:'2026-11-15T10:00:00.123Z'};
  const quotes=scope.vendorIds.map((vendorId,i)=>({networkId:'testnet',mandateId:scope.mandateId,vendorId,amountAtomic:'3',orderId:`order_${i}`,content:`Fictional source ${i}`}));
  const approved=legacy?{job:scope,quote:quotes[0]}:{schemaVersion:'haldir.approved.two-source.v1',job:scope,
    sources:quotes.map((quote,i)=>({sourceId:['company-records','background-research'][i],quote}))};
  const sources=approvedSources(approved), refs=sources.map(({sourceId,quoteId})=>({sourceId,quoteId}));
  const job={jobId:'job_1',ownerId:'owner.testnet',quoteId:refs[0].quoteId,scope,state:'LOCAL_ACTIVE',qualification:'PUBLIC_TESTNET_FICTIONAL_VENDOR',
    publicManifest:{manifestId:'manifest_1',ownerId:'owner.testnet',approved,binding:{networkId:'testnet',mandateId:scope.mandateId,ownerId:'owner.testnet'}},
    ...(legacy?{}:{schemaVersion:'haldir.job.two-source.v1',sourceRefs:refs})};
  repository.seed('jobs',job.jobId,job);
  for(const s of sources){
    repository.seed('quotes',s.quoteId,{jobId:job.jobId,ownerId:job.ownerId,quote:s.quote});
    repository.seed('orders',s.quoteId,{jobId:job.jobId,quoteId:s.quoteId,orderId:s.quote.orderId,quote:s.quote,lifecycle:'PAYMENT_PENDING',proof:null,artifact:null,lastCheckCode:null});
  }
  function deliver(index) {
    const {quoteId,quote}=sources[index], evidence=syntheticPayment(quote,1+index*20).evidence;
    const proof=verifyPaymentProof(quote,evidence), artifact=fictionalArtifact({quoteId,quote});
    repository.seed('claims',proof.proofId,{jobId:job.jobId,quoteId,proof});
    repository.seed('deliveries',quoteId,{jobId:job.jobId,quoteId,artifactId:artifact.artifactId,artifact});
    repository.seed('orders',quoteId,{...repository.get('orders',quoteId),lifecycle:'DELIVERED',proof,artifact});
    return artifact;
  }
  const plan={phase:'plan',approvedJobInput:approvedInput(job),...(legacy?{approvedQuote:quotes[0],tools:[{name:'requestquote',approvedQuote:quotes[0]}]}:
    {approvedSources:sources,tools:[{name:'requestquotes',approvedSources:sources}]})};
  const report=()=>({phase:'report',approvedJobInput:approvedInput(job),evidence:sources.map(s=>repository.get('orders',s.quoteId).artifact),tools:[]});
  let transports=0;
  const model=options=>createNearAiModel({repository,apiKey:'synthetic-key-only',authorizationExpiresAt:expiresAt,now:clock,
    transportFactory:()=>{transports++;throw new Error('Unexpected transport');},...options});
  return {repository,job,sources,plan,report,deliver,model,get transports(){return transports;}};
}

for(const [name,mutate] of [
 ['different authenticated owner',(f,r)=>{r.approvedJobInput.ownerId='other.testnet';}],
 ['swapped source order',(f,r)=>{r.approvedSources.reverse();r.tools[0].approvedSources=r.approvedSources;}],
 ['forged second stored quote',(f)=>{const s=f.sources[1],q=f.repository.get('quotes',s.quoteId);q.quote.amountAtomic='4';f.repository.seed('quotes',s.quoteId,q);}],
 ['forged second stored order',(f)=>{const s=f.sources[1],o=f.repository.get('orders',s.quoteId);o.jobId='other_job';f.repository.seed('orders',s.quoteId,o);}],
 ['scope divorced from immutable approval',(f)=>{const j=structuredClone(f.job);j.scope.output='Unapproved output';f.repository.seed('jobs',j.jobId,j);}],
]) test(`stored TS1 binding rejects ${name} before transport`,async()=>{
  const f=fixture(),r=structuredClone(f.plan);mutate(f,r);
  await assert.rejects(f.model().propose(r),{message:'MODEL_INPUT_REJECTED'});
  assert.equal(f.transports,0);
});

test('partial evidence does not spend a report phase',async()=>{
  const f=fixture(); f.deliver(0);
  await assert.rejects(f.model().propose({...f.report(),evidence:[f.repository.get('orders',f.sources[0].quoteId).artifact]}),{message:'MODEL_INPUT_REJECTED'});
  assert.equal(f.repository.rows('modelReservations').length,0); assert.equal(f.transports,0);
});

for(const [name,mutate] of [
 ['second proof recipient',(f,o)=>{o.proof.vendorId='forged.testnet';}],
 ['second proof amount',(f,o)=>{o.proof.amountAtomic='9';}],
 ['second artifact digest',(f,o)=>{o.artifact.contentDigest='0'.repeat(64);}],
 ['second artifact identity',(f,o)=>{o.artifact.artifactId='foreign';}],
 ['claim bound to another job',(f,o)=>{const c=f.repository.get('claims',o.proof.proofId);c.jobId='foreign';f.repository.seed('claims',o.proof.proofId,c);}],
 ['delivery record missing',(f,o)=>{f.repository.data.delete(f.repository.key('deliveries',o.quoteId));}],
 ['duplicate first-source proof',(f,o)=>{o.proof=f.repository.get('orders',f.sources[0].quoteId).proof;}],
]) test(`paid evidence rejects ${name} before model reservation`,async()=>{
 const f=fixture();f.deliver(0);f.deliver(1);
 const o=f.repository.get('orders',f.sources[1].quoteId);mutate(f,o);f.repository.seed('orders',o.quoteId,o);
 await assert.rejects(f.model().propose(f.report()),{message:'MODEL_INPUT_REJECTED'});
 assert.equal(f.transports,0);assert.equal(f.repository.rows('modelReservations').length,0);
});


