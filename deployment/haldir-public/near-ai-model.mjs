import { isDeepStrictEqual as equal } from 'node:util';
import { createHash } from 'node:crypto';
import * as genericModel from '../../src/agent/model-provider.mjs';
import * as publicBudget from '../../src/server/public-journey.mjs';
import { approvedInput, approvedSources, jobSourceRefs } from '../../src/shared/job-contract.mjs';
const fail = code => { throw Object.assign(new Error(code), {code}); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && equal(Object.keys(v).sort(), keys.split(' ').sort());
const demand = ok => { if (!ok) fail('MODEL_INPUT_REJECTED'); };

async function stored(tx, request) {
  try {
    const input=request?.approvedJobInput;
    demand(input && typeof input.jobId==='string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.jobId));
    const job=await tx.get('jobs',input.jobId);
    demand(job?.jobId===input.jobId && job.ownerId===input.ownerId && job.qualification==='PUBLIC_TESTNET_FICTIONAL_VENDOR');
    const manifest=job.publicManifest;
    demand(manifest && manifest.ownerId===job.ownerId && manifest.binding?.ownerId===job.ownerId &&
      manifest.binding.networkId==='testnet' && manifest.binding.mandateId===job.scope?.mandateId &&
      equal(job.scope,manifest.approved?.job) && equal(input,approvedInput(job)));
    const sources=approvedSources(manifest.approved), refs=jobSourceRefs(job);
    demand(equal(refs,sources.map(({sourceId,quoteId})=>({sourceId,quoteId}))));
    const orders=[];
    for(const source of sources){
      const quote=await tx.get('quotes',source.quoteId),order=await tx.get('orders',source.quoteId);
      demand(quote?.ownerId===job.ownerId && quote.jobId===job.jobId && equal(quote.quote,source.quote) &&
        order?.jobId===job.jobId && order.quoteId===source.quoteId && order.orderId===source.quote.orderId && equal(order.quote,source.quote));
      orders.push(order);
    }
    if(request.phase==='plan') {
      if(sources.length===2) demand(exact(request,'phase approvedJobInput approvedSources tools') &&
        equal(request.approvedSources,sources) && equal(request.tools,[{name:'requestquotes',approvedSources:sources}]));
      else demand(exact(request,'phase approvedJobInput approvedQuote tools') && equal(request.approvedQuote,sources[0].quote) &&
        equal(request.tools,[{name:'requestquote',approvedQuote:sources[0].quote}]));
    } else {
      demand(request.phase==='report' && exact(request,'phase approvedJobInput evidence tools') && equal(request.tools,[]) &&
        orders.every(o=>o.proof && o.artifact && o.lifecycle==='DELIVERED') && equal(request.evidence,orders.map(o=>o.artifact)));
      const proofIds=new Set();
      for(const order of orders) {
        const {proof:p,artifact:a,quote:q,quoteId}=order;
        demand(exact(p,'proofId networkId transactionHash payReceiptId transferReceiptId mandateId vendorId amountAtomic orderId') &&
          ['transactionHash','payReceiptId','transferReceiptId'].every(k=>typeof p[k]==='string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p[k])) &&
          ['networkId','mandateId','vendorId','amountAtomic','orderId'].every(k=>p[k]===q[k]) &&
          p.proofId===JSON.stringify(['near-native-transfer-v1',q.networkId,p.transferReceiptId]) && !proofIds.has(p.proofId));
        proofIds.add(p.proofId);
        demand(exact(a,'artifactId orderId vendorId fictionalSample qualification mediaType content contentDigest') &&
          a.artifactId===`fictional:${quoteId}` && a.artifactId.length<=2060 && a.orderId===q.orderId && a.vendorId===q.vendorId &&
          a.fictionalSample===true && a.qualification==='LOCAL_SYNTHETIC_ONLY' && a.mediaType==='text/plain' &&
          typeof a.content==='string' && a.content.length>0 && a.content.length<=65536 &&
          a.contentDigest===createHash('sha256').update(a.content).digest('hex'));
        const claim=await tx.get('claims',p.proofId),delivery=await tx.get('deliveries',quoteId);
        demand(equal(claim,{jobId:job.jobId,quoteId,proof:p}) &&
          equal(delivery,{jobId:job.jobId,quoteId,artifactId:a.artifactId,artifact:a}));
      }
    }
    return job;
  } catch { fail('MODEL_INPUT_REJECTED'); }
}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
function checkSignal(signal) { if(signal?.aborted) fail('MODEL_ABORTED'); }
function safeReceipt(value,model) {
  if(!value || value.signatureKind!=='provider_tee' || value.model!==model || value.sdkVersion!=='0.3.0' ||
    value.httpStatus!==200 || value.e2ee!==true || typeof value.id!=='string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value.id)) fail('MODEL_UNVERIFIED');
  const usage=value.usage;
  if(!usage || !['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isSafeInteger(usage[k]) && usage[k]>=0) ||
    usage.prompt_tokens+usage.completion_tokens!==usage.total_tokens || usage.completion_tokens>2048) fail('MODEL_UNVERIFIED');
  const reasoning=value.reasoningTokens??null,lookups=value.signatureLookups;
  if((reasoning!==null && (!Number.isSafeInteger(reasoning) || reasoning<0 || reasoning>usage.completion_tokens)) ||
    !Number.isInteger(lookups) || lookups<1 || lookups>4) fail('MODEL_UNVERIFIED');
  return {id:value.id,signatureKind:value.signatureKind,model:value.model,sdkVersion:value.sdkVersion,httpStatus:value.httpStatus,e2ee:true,
    usage:{prompt_tokens:usage.prompt_tokens,completion_tokens:usage.completion_tokens,total_tokens:usage.total_tokens},
    signatureLookups:lookups,reasoningTokens:reasoning,reasoningBudgetExceeded:reasoning!==null && reasoning>512,
    inferenceId:typeof value.inferenceId==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.inferenceId)?value.inferenceId:null};
}

/** Trusted server-only factory. The budget patch and source closure are required;
 * missing composition never falls back to an unbounded or synthetic budget. */
export function createNearAiModel({ repository,apiKey,authorizationExpiresAt,now=Date.now,transportFactory,
  budgetFactory=publicBudget.createPublicModelBudget,reservationKey=publicBudget.publicModelReservationKey } = {}) {
  if(typeof repository?.runTransaction!=='function' || typeof apiKey!=='string' || !/^[\x21-\x7e]{8,4096}$/.test(apiKey) ||
    typeof now!=='function' || typeof authorizationExpiresAt!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(authorizationExpiresAt) ||
    !Number.isFinite(Date.parse(authorizationExpiresAt)) || new Date(authorizationExpiresAt).toISOString()!==authorizationExpiresAt.replace('Z','.000Z')) fail('MODEL_CONFIGURATION_INVALID');
  return Object.freeze({async propose(input) {
    let signal,request;
    try { ({signal,...request}=input??{}); if(signal!==undefined && !(signal instanceof AbortSignal)) fail('MODEL_INPUT_REJECTED'); request=structuredClone(request); }
    catch {fail('MODEL_INPUT_REJECTED');}
    checkSignal(signal);
    // Validate both stored source bindings even when the budget patch is absent.
    await repository.runTransaction(tx=>stored(tx,request));
    checkSignal(signal);
    if(typeof reservationKey!=='function' || typeof budgetFactory!=='function') fail('MODEL_BUDGET_INTEGRATION_REQUIRED');
    const j=request.approvedJobInput,id=digest(['haldir-near-ai-v1',j.ownerId,j.jobId]);
    const key=reservationKey(id,j.jobId,request.phase),requestDigest=digest(canonical(request));
    const prior=await repository.runTransaction(async tx=>{await stored(tx,request);return tx.get('modelReservations',key);});
    checkSignal(signal);
    const policy=await import('./near-ai-policy.mjs');
    const {NEAR_AI_MODEL,NEAR_AI_ENDPOINT,NEAR_AI_PROFILE,NEAR_AI_RELEASE,modelAuthorization}=policy;
    if(prior){
      if(prior.state!=='COMPLETED_VERIFIED' || prior.authorizationId!==id || prior.ownerId!==j.ownerId || prior.jobId!==j.jobId ||
        prior.phase!==request.phase || prior.requestDigest!==requestDigest) fail('MODEL_OUTCOME_UNKNOWN');
      try {
        safeReceipt(prior.verification,NEAR_AI_MODEL);
        const result=genericModel.validateModelResult(request,prior.result,{apiKey});
        checkSignal(signal);return structuredClone(result);
      } catch {fail('MODEL_OUTCOME_UNKNOWN');}
    }
    const configuration={protocol:'chat-completions',endpoint:NEAR_AI_ENDPOINT,model:NEAR_AI_MODEL,apiKey};
    const authorization=modelAuthorization(id,authorizationExpiresAt);
    let wire;
    try {
      const budget=budgetFactory({repository,ownerId:j.ownerId,jobId:j.jobId,configuration,authorization,now,signal,releaseBudget:NEAR_AI_RELEASE,requestDigest});
      if(budget?.contractVersion!=='haldir.model-budget.atomic-release.v1' || typeof budget.reserve!=='function' ||
        typeof budget.reservationKey!=='function' || budget.reservationKey(request.phase)!==key) fail('MODEL_BUDGET_INTEGRATION_REQUIRED');
      checkSignal(signal);
      const factory=transportFactory??(await import('./near-ai-transport.mjs')).createNearAiTransport;
      wire=factory({apiKey,signal});
      const transport=async (url,init)=>{
        checkSignal(signal);checkSignal(init.signal);
        await repository.runTransaction(async tx=>{
          await stored(tx,request);
          const row=await tx.get('modelReservations',key);
          if(row?.state!=='RESERVED_NO_AUTOMATIC_REFUND' || row.requestDigest!==requestDigest || row.ownerId!==j.ownerId ||
            row.jobId!==j.jobId || row.authorizationId!==id || row.phase!==request.phase) fail('MODEL_OUTCOME_UNKNOWN');
        });
        checkSignal(signal);checkSignal(init.signal);
        return wire.transport(url,init);
      };
      const provider=genericModel.createModelProvider({configuration,authorization,now,budget,transport,profile:NEAR_AI_PROFILE});
      const result=await provider.propose(request);
      checkSignal(signal);
      const verification=safeReceipt(wire.getReceipt(),NEAR_AI_MODEL);
      await repository.runTransaction(async tx=>{
        await stored(tx,request);
        const row=await tx.get('modelReservations',key);
        if(row?.state!=='RESERVED_NO_AUTOMATIC_REFUND' || row.authorizationId!==id || row.ownerId!==j.ownerId ||
          row.jobId!==j.jobId || row.phase!==request.phase || row.requestDigest!==requestDigest) fail('MODEL_OUTCOME_UNKNOWN');
        checkSignal(signal);
        tx.set('modelReservations',key,{...row,state:'COMPLETED_VERIFIED',result:structuredClone(result),verification});
      });
      checkSignal(signal);return structuredClone(result);
    } catch(error) {
      if(error?.code==='MODEL_BUDGET_INTEGRATION_REQUIRED') throw error;
      if(error?.code==='MODEL_BUDGET_REJECTED') {
        const row=await repository.runTransaction(tx=>tx.get('modelReservations',key));
        fail(row?'MODEL_OUTCOME_UNKNOWN':'MODEL_NOT_SENT');
      }
      if(signal?.aborted) fail('MODEL_ABORTED');
      fail('MODEL_UNAVAILABLE');
    } finally {
      if(wire) {try {await wire.drain();}catch{fail('MODEL_UNAVAILABLE');}}
      checkSignal(signal);
    }
  }});
}
