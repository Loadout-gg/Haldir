import { approvedInput, approvedSources, jobSourceRefs, quoteKey, paymentOperationId } from '../shared/job-contract.mjs';
export { approvedInput } from '../shared/job-contract.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const copy = value => structuredClone(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), keys.split(' ').sort());

/**
 * @typedef {Object} ApprovedJobInput
 * @property {string} jobId
 * @property {string} ownerId Authenticated caller identity (resolved by the host).
 * @property {string} quoteId Existing order/quote repository key.
 * @property {string} qualification Retained, never upgraded by the runner.
 * @property {string} networkId
 * @property {string} mandateId
 * @property {string} purpose
 * @property {string} output
 * @property {string} budgetAtomic Canonical integer string, never a float.
 * @property {string[]} vendorIds
 * @property {string} expiresAt Bound UTC deadline from the admitted job.
 *
 * @typedef {Object} ApprovedQuote
 * @property {string} networkId
 * @property {string} mandateId
 * @property {string} vendorId
 * @property {string} amountAtomic
 * @property {string} orderId
 * @property {string} content
 *
 * @typedef {{operationId: string, approvedJobInput: ApprovedJobInput, quote: ApprovedQuote}} PaymentRequest
 * @typedef {{status: 'submitted'|'unknown', reference?: string}} PaymentObservation
 */
/**
 * @typedef {Object} PaymentExecutionPort
 * @property {(request: PaymentRequest) => Promise<PaymentObservation>} submit
 *   Trusted capability: independently enforce the bound mandate/recipient/budget/
 *   deadline and current owner stop at execution. Atomically return an existing
 *   same-order operation rather than broadcasting again, even when no agentRuns
 *   row predates it. Durably bind operationId BEFORE sending; never require or
 *   accept a model signature or owner access key.
 * @property {(request: PaymentRequest) => Promise<PaymentObservation>} lookup
 *   Read-only lookup of that exact operation, including after a lost response.
 *   MUST NOT broadcast, retry submission or allocate another order. No result is
 *   payment proof. orders.checkPayment's trusted receipt collector supplies proof.
 */
function observation(value) {
  // Adapter errors/malformed acknowledgements are uncertainty, never nonpayment.
  if (!value || !['submitted', 'unknown'].includes(value.status)) return { status: 'unknown' };
  return { status: value.status, ...(typeof value.reference === 'string' && value.reference.length <= 512
    ? { reference: value.reference } : {}) };
}

// A projection of trusted admitted records, never a browser/model approval.


function validTwoSourceReport(output, members) {
  const findings = output?.findings, interpretations = output?.interpretations;
  return exact(output,'findings interpretations')&&Array.isArray(findings)&&findings.length>=1&&findings.length<=12&&Array.from(findings).every(f=>exact(f,'artifactId excerpt')&&typeof f.excerpt==='string'&&f.excerpt.length>0&&f.excerpt.length<=4096&&members.some(m=>m.order.artifact.artifactId===f.artifactId&&m.order.artifact.content.includes(f.excerpt)))&&members.every(m=>findings.some(f=>f.artifactId===m.order.artifact.artifactId))&&Array.isArray(interpretations)&&interpretations.length<=2&&new Set(interpretations.map(i=>i?.kind)).size===interpretations.length&&Array.from(interpretations).every(i=>exact(i,'kind findingIndexes')&&['COMPARE_COMPANY_DETAILS','COMPARE_SOURCE_CONSISTENCY'].includes(i.kind)&&Array.isArray(i.findingIndexes)&&i.findingIndexes.length>=1&&i.findingIndexes.length<=12&&new Set(i.findingIndexes).size===i.findingIndexes.length&&Array.from(i.findingIndexes).every(n=>Number.isInteger(n)&&n>=0&&n<findings.length)&&(i.kind!=='COMPARE_SOURCE_CONSISTENCY'||new Set(i.findingIndexes.map(n=>findings[n].artifactId)).size===2));
}

// TS1 keeps one durable job run; source states carry no balances or new ledger.
async function runTwoSource({repository,orders,model,paymentExecution,now}, input) {
  async function load(tx) {
    const job = await tx.get('jobs',input.jobId);
    if (!job || job.ownerId !== input.ownerId) fail('NOT_FOUND');
    let refs; try { refs=jobSourceRefs(job); } catch { fail('APPROVAL_CHANGED'); }
    const members=[];
    for (const ref of refs) {
      const order=await tx.get('orders',ref.quoteId), quote=await tx.get('quotes',ref.quoteId);
      if (!order || order.jobId!==job.jobId || order.quoteId!==ref.quoteId || order.orderId!==order.quote.orderId || quote?.jobId!==job.jobId || quote.ownerId!==job.ownerId || quoteKey(order.quote)!==ref.quoteId || !isDeepStrictEqual(order.quote,quote.quote)) fail('QUOTE_CHANGED');
      if (order.proof) {
        const claim=await tx.get('claims',order.proof.proofId), delivery=await tx.get('deliveries',ref.quoteId);
        if (claim?.jobId!==job.jobId || claim.quoteId!==ref.quoteId || !isDeepStrictEqual(claim.proof,order.proof) || delivery?.jobId!==job.jobId || delivery.quoteId!==ref.quoteId || delivery.artifactId!==`fictional:${ref.quoteId}` || !isDeepStrictEqual(delivery.artifact,order.artifact)) fail('QUOTE_CHANGED');
      } else if (order.artifact) fail('QUOTE_CHANGED');
      members.push({...ref,order});
    }
    let sources;
    try { sources=approvedSources(job.publicManifest?.approved ?? {schemaVersion:'haldir.approved.two-source.v1',job:job.scope,sources:members.map(m=>({sourceId:m.sourceId,quote:m.order.quote}))}); } catch { fail('APPROVAL_CHANGED'); }
    if (!isDeepStrictEqual(refs,sources.map(({sourceId,quoteId})=>({sourceId,quoteId}))) || !isDeepStrictEqual(sources.map(s=>s.quote),members.map(m=>m.order.quote)) || (job.publicManifest && !isDeepStrictEqual(job.scope,job.publicManifest.approved.job))) fail('APPROVAL_CHANGED');
    const run=await tx.get('agentRuns',job.jobId);
    if (run && (run.schemaVersion!=='haldir.agent-run.two-source.v1' || !isDeepStrictEqual(run.approvedJobInput,approvedInput(job)) || !isDeepStrictEqual(run.approvedSources,sources) || !isDeepStrictEqual(run.sourceRuns.map(s=>s.quoteId),refs.map(s=>s.quoteId)))) fail('APPROVAL_CHANGED');
    return {job,members,sources,run};
  }
  let snapshot=await repository.runTransaction(async tx=>{
    const s=await load(tx); if(s.run)return s;
    const run={schemaVersion:'haldir.agent-run.two-source.v1',jobId:s.job.jobId,revision:0,approvedJobInput:approvedInput(s.job),approvedSources:s.sources,planState:'NOT_STARTED',sourceRuns:s.sources.map(s=>({quoteId:s.quoteId,stage:'READY',paymentAttempted:false,submission:null})),stage:'READY',report:null};
    tx.create('agentRuns',s.job.jobId,run); return {...s,run};
  });
  let run=snapshot.run;
  const refresh=async()=>{snapshot=await repository.runTransaction(load);if(snapshot.run.revision!==run.revision)fail('RUN_SUPERSEDED');return snapshot;};
  const save=async patch=>{
    run=await repository.runTransaction(async tx=>{const s=await load(tx);if(s.run.revision!==run.revision)fail('RUN_SUPERSEDED');const next={...s.run,...patch,revision:run.revision+1};tx.set('agentRuns',input.jobId,next);return next;});return run;
  };
  const sourceSave=async(i,patch)=>{const states=copy(run.sourceRuns);states[i]={...states[i],...patch};await save({sourceRuns:states});};
  const blocked=job=>job.state!=='LOCAL_ACTIVE'?'OWNER_STOPPED':!Number.isFinite(now())||Date.parse(job.scope.expiresAt)<=now()?'DEADLINE_EXPIRED':null;
  const validArtifact=m=>{const a=m.order.artifact;return !!(m.order.proof && a && exact(a,'artifactId orderId vendorId fictionalSample qualification mediaType content contentDigest') && a.artifactId===`fictional:${m.quoteId}` && a.orderId===m.order.orderId && a.vendorId===m.order.quote.vendorId && a.fictionalSample===true && typeof a.content==='string' && a.content.length>0 && a.content.length<=65536 && a.contentDigest===createHash('sha256').update(a.content).digest('hex'));};
  const report=(s,output=null,unavailable=false)=>{
    const delivered=s.members.filter(validArtifact), missing=[], reason=blocked(s.job);
    for(const m of s.members){const state=run.sourceRuns.find(r=>r.quoteId===m.quoteId);if(!m.order.proof)missing.push(`${m.sourceId}:${state.paymentAttempted?'PAYMENT_EVIDENCE_UNAVAILABLE':reason??'NOT_STARTED'}`);else if(!validArtifact(m))missing.push(`${m.sourceId}:DELIVERY_EVIDENCE_UNAVAILABLE`);}
    if(delivered.length===2&&!output)missing.push(unavailable?'MODEL_REPORT_UNAVAILABLE':'MODEL_REPORT_PENDING');
    const findings=output?.findings??delivered.map(m=>({artifactId:m.order.artifact.artifactId,excerpt:m.order.artifact.content.slice(0,4096)}));
    const facts=findings.map(f=>{const m=delivered.find(m=>m.order.artifact.artifactId===f.artifactId);return {...f,sourceId:m.sourceId,quoteId:m.quoteId,orderId:m.order.orderId,vendorId:m.order.quote.vendorId,amountAtomic:m.order.quote.amountAtomic,proofId:m.order.proof.proofId,contentDigest:m.order.artifact.contentDigest,fictionalSample:true};});
    const pending=s.members.find(m=>!m.order.proof&&run.sourceRuns.find(r=>r.quoteId===m.quoteId).paymentAttempted), delivery=s.members.find(m=>m.order.proof&&!validArtifact(m)), unstarted=s.members.find(m=>!m.order.proof&&!run.sourceRuns.find(r=>r.quoteId===m.quoteId).paymentAttempted);
    const nextCheck=pending?{code:'CHECK_SAME_PAYMENT',sourceId:pending.sourceId}:delivery?{code:'RETRIEVE_SAME_DELIVERY',sourceId:delivery.sourceId}:unstarted?{code:reason?'OWNER_REVIEW':'RESUME_APPROVED_JOB',sourceId:unstarted.sourceId}:{code:output?'COMPARE_SOURCES_WITH_CONTRACT':'REVIEW_REPORT_AVAILABILITY',sourceId:null};
    return {schemaVersion:'haldir.report.two-source.v1',purpose:s.job.scope.purpose,output:s.job.scope.output,status:missing.length?'PARTIAL':'EVIDENCE_REVIEW_REQUIRED',supplierVerified:false,fictionalSample:true,qualification:s.job.qualification,purchases:s.members.map(m=>({sourceId:m.sourceId,quoteId:m.quoteId,orderId:m.order.orderId,vendorId:m.order.quote.vendorId,amountAtomic:m.order.quote.amountAtomic,lifecycle:m.order.lifecycle,proofId:m.order.proof?.proofId??null,artifactId:validArtifact(m)?m.order.artifact.artifactId:null})),facts,interpretations:output?.interpretations??[],limits:['FICTIONAL_SAMPLE','SOURCE_ACCURACY_NOT_VERIFIED','NO_SIGNING_ASSURANCE',...(delivered.length<2?['INCOMPLETE_EVIDENCE']:[]),...(unavailable?['MODEL_REPORT_UNAVAILABLE']:[])],nextCheck,missing,ownerActions:{stop:'OWNER_ACTION_REQUIRED',withdraw:'OWNER_ACTION_REQUIRED',residual:'NOT_OBSERVED'}};
  };
  if(run.stage==='COMPLETE') {
    await refresh();
    const cached=run.report, output={findings:cached?.facts?.map(({artifactId,excerpt})=>({artifactId,excerpt})),interpretations:cached?.interpretations};
    if (!snapshot.members.every(validArtifact) || !validTwoSourceReport(output,snapshot.members) || !isDeepStrictEqual(cached,report(snapshot,output))) fail('APPROVAL_CHANGED');
    return run;
  }
  const checked=new Map(),retrieved=new Set(),looked=new Set();
  const check=async(i)=>{const n=checked.get(i)??0;if(n>=2)return;await refresh();await orders.checkPayment({...input,quoteId:run.sourceRuns[i].quoteId});checked.set(i,n+1);await refresh();};
  const reconcile=async i=>{
    await refresh();const r=run.sourceRuns[i],request={operationId:paymentOperationId(r.quoteId),approvedJobInput:approvedInput(snapshot.job,r.quoteId),quote:copy(snapshot.members[i].order.quote)};
    if(r.paymentAttempted&&!snapshot.members[i].order.proof&&!looked.has(i)){await sourceSave(i,{stage:'PAYMENT_RECONCILING'});let result;try{await refresh();result=await paymentExecution.lookup(request);}catch{result={status:'unknown'};}looked.add(i);await sourceSave(i,{submission:observation(result)});}
    if(!snapshot.members[i].order.proof)await check(i);
    if(snapshot.members[i].order.proof&&!validArtifact(snapshot.members[i])&&!retrieved.has(i)){
      await sourceSave(i,{stage:'DELIVERY_PENDING'});retrieved.add(i);try{await refresh();const delivered=await orders.retrieveDelivery({...input,quoteId:r.quoteId});await refresh();if(!isDeepStrictEqual(delivered,snapshot.members[i].order)||!validArtifact(snapshot.members[i]))fail('DELIVERY_EVIDENCE_INVALID');}catch{await refresh();}
    }
    await refresh();await sourceSave(i,{stage:validArtifact(snapshot.members[i])?'COMPLETE':snapshot.members[i].order.proof?'PARTIAL':run.sourceRuns[i].paymentAttempted?'PAYMENT_UNKNOWN':'READY'});
  };
  // Recovery pass precedes every purchase guard, including stopped/expired jobs.
  for(let i=0;i<2;i++)await reconcile(i);
  await refresh();
  const recovery = model.contractVersion === 'haldir.model.runner-recovery.v1' && typeof model.recover === 'function';
  // Internal proof of a normal facade admission refusal, never a public enum or
  // an inference from cache absence. Clear before every explicit fresh attempt.
  const notAdmitted = phase => recovery && run.modelNotAdmitted?.[phase] === true;
  const admission = (phase, value) => ({modelNotAdmitted:{...run.modelNotAdmitted,[phase]:value}});
  const planInput = () => ({phase:'plan',approvedJobInput:copy(run.approvedJobInput),approvedSources:copy(run.approvedSources),tools:[{name:'requestquotes',approvedSources:copy(run.approvedSources)}]});
  const acceptedPlan = output => isDeepStrictEqual(output,{tool:'requestquotes',arguments:{quoteIds:run.sourceRuns.map(r=>r.quoteId)}});
  if (['PENDING','UNAVAILABLE'].includes(run.planState) && !notAdmitted('plan')) {
    let output;
    if (recovery) { try { await refresh(); output = await model.recover(planInput()); } catch {} }
    await save({planState:acceptedPlan(output)?'ACCEPTED':'UNAVAILABLE'});
  }
  const needsNew=snapshot.members.some((m,i)=>!m.order.proof&&!run.sourceRuns[i].paymentAttempted);
  if(needsNew&&!blocked(snapshot.job)&&(run.planState==='NOT_STARTED'||notAdmitted('plan'))){
    await save({planState:'PENDING',stage:'MODEL_PENDING',...(recovery?admission('plan',false):{})});
    let output;
    try{await refresh();output=await model.propose(planInput());}
    catch(error){await save({planState:'UNAVAILABLE',...(recovery?admission('plan',error?.code==='MODEL_NOT_SENT'): {})});}
    if(run.planState==='PENDING')await save({planState:acceptedPlan(output)?'ACCEPTED':'UNAVAILABLE'});
  }
  for(let i=0;i<2;i++){
    await refresh(); if(i&&!snapshot.members[i-1].order.proof)break;
    if(snapshot.members[i].order.proof)continue;
    if(run.sourceRuns[i].paymentAttempted)break;
    if(blocked(snapshot.job)||run.planState!=='ACCEPTED'){await sourceSave(i,{stage:'BLOCKED'});break;}
    // Revision + immutable bindings and owner/deadline checked in the same write.
    run=await repository.runTransaction(async tx=>{const s=await load(tx);if(s.run.revision!==run.revision)fail('RUN_SUPERSEDED');if(blocked(s.job))return s.run;const states=copy(s.run.sourceRuns);states[i]={...states[i],stage:'PAYMENT_SUBMITTING',paymentAttempted:true};const next={...s.run,sourceRuns:states,stage:'PAYMENT_SUBMITTING',revision:run.revision+1};tx.set('agentRuns',input.jobId,next);return next;});
    if(!run.sourceRuns[i].paymentAttempted)break;
    await refresh();const r=run.sourceRuns[i],request={operationId:paymentOperationId(r.quoteId),approvedJobInput:approvedInput(snapshot.job,r.quoteId),quote:copy(snapshot.members[i].order.quote)};
    let result;try{result=await paymentExecution.submit(request);}catch{result={status:'unknown'};}await sourceSave(i,{submission:observation(result),stage:'PAYMENT_RECONCILING'});
    await reconcile(i);await refresh();if(!snapshot.members[i].order.proof)break;
  }
  await refresh();
  const both=snapshot.members.every(validArtifact), attempted=run.stage==='REPORT_PENDING'||run.report?.limits.includes('MODEL_REPORT_UNAVAILABLE');
  if(!both){await save({stage:blocked(snapshot.job)?'BLOCKED':run.sourceRuns.some(r=>r.stage==='PAYMENT_UNKNOWN')?'PAYMENT_UNKNOWN':'PARTIAL',report:report(snapshot)});return run;}
  const reportInput = () => ({phase:'report',approvedJobInput:copy(run.approvedJobInput),evidence:snapshot.members.map(m=>copy(m.order.artifact)),tools:[]});
  if(attempted && !notAdmitted('report')){
    let output;
    if (recovery) { try { await refresh(); output = await model.recover(reportInput()); } catch {} }
    await refresh();
    const valid=validTwoSourceReport(output,snapshot.members);
    await save({stage:valid?'COMPLETE':'PARTIAL',report:report(snapshot,valid?output:null,!valid)});return run;
  }
  // Persist consumption before inference. Recovery may only read the same result;
  // it never retries an unknown provider attempt or starts a new model phase.
  await save({stage:'REPORT_PENDING',report:report(snapshot,null,true),...(recovery?admission('report',false):{})});
  let output;
  try{await refresh();output=await model.propose(reportInput());}
  catch(error){output=null;if(recovery)await save(admission('report',error?.code==='MODEL_NOT_SENT'));}
  await refresh();
  const valid=validTwoSourceReport(output,snapshot.members);
  await save({stage:valid?'COMPLETE':'PARTIAL',report:report(snapshot,valid?output:null,!valid)});return run;
}

function reportFor(run, order, findings = [], missing = []) {
  const a = order.artifact;
  return { purpose: run.approvedJobInput.purpose, output: run.approvedJobInput.output,
    status: missing.length ? 'PARTIAL' : 'EVIDENCE_REVIEW_REQUIRED', supplierVerified: false,
    fictionalSample: a?.fictionalSample === true || run.approvedJobInput.qualification === 'LOCAL_SYNTHETIC_ONLY',
    qualification: run.approvedJobInput.qualification,
    purchase: { orderId: order.orderId, vendorId: order.quote.vendorId, amountAtomic: order.quote.amountAtomic,
      lifecycle: order.lifecycle, proofId: order.proof?.proofId ?? null, artifactId: a?.artifactId ?? null },
    findings: findings.map(f => ({ ...f, orderId: order.orderId, vendorId: order.quote.vendorId,
      amountAtomic: order.quote.amountAtomic, proofId: order.proof?.proofId ?? null,
      contentDigest: a?.contentDigest ?? null, fictionalSample: a?.fictionalSample === true })),
    missing,
    ownerActions: { stop: 'OWNER_ACTION_REQUIRED', withdraw: 'OWNER_ACTION_REQUIRED', residual: 'NOT_OBSERVED' } };
}

/**
 * Bounded orchestration for ONE already admitted job/quote (orders' current ABI).
 * No default model, signer, fetch, owner operations, money ledger or admission.
 * Repository is the same runTransaction/get/create/set port used by orders.mjs.
 * `model.propose` is a trusted provider adapter returning parsed JSON proposals:
 * plan -> {tool:'requestquote', arguments: ApprovedQuote};
 * report -> {findings: [{artifactId: string, excerpt: string}]}.
 * The provider must disable its own autonomous tool execution. The runner alone
 * resolves the allowlisted proposal; copied email/vendor text is never authority.
 * At most two model calls, one submit, one lookup, two payment checks and one
 * delivery call per invocation. No internal retry loops. Adapters own bounded
 * I/O timeouts.
 * `runJob({ownerId,jobId})` requires host-authenticated ownerId; it is not auth.
 * COMPLETE means an evidence-linked report exists, not verified supplier/funds.
 * RUN_SUPERSEDED means another invocation advanced the durable revision: a caller
 * may explicitly resume; it must not fabricate success or create another order.
 * @param {{repository: object, orders: object, model: {propose: Function}, paymentExecution: PaymentExecutionPort, now?: () => number}} ports
 */
export function createJobRunner({ repository, orders, model, paymentExecution, now = Date.now } = {}) {
  if (typeof repository?.runTransaction !== 'function' || typeof orders?.checkPayment !== 'function' ||
    typeof orders?.retrieveDelivery !== 'function' || typeof model?.propose !== 'function' ||
    typeof paymentExecution?.submit !== 'function' || typeof paymentExecution?.lookup !== 'function' ||
    typeof now !== 'function') fail('INVALID_RUNNER_PORTS');
  async function load(tx, input) {
    const job = await tx.get('jobs', input.jobId);
    if (!job || job.ownerId !== input.ownerId) fail('NOT_FOUND');
    const order = await tx.get('orders', job.quoteId);
    const quote = await tx.get('quotes', job.quoteId);
    const run = await tx.get('agentRuns', input.jobId);
    if (!order || quote?.jobId !== job.jobId || quote.ownerId !== job.ownerId ||
      !isDeepStrictEqual(quote.quote, order.quote)) fail('QUOTE_CHANGED');
    if (run && (!isDeepStrictEqual(run.approvedJobInput, approvedInput(job)) ||
      !isDeepStrictEqual(run.quote, order.quote))) fail('APPROVAL_CHANGED');
    return { job, order, run };
  }
  return { async runJob(input) {
    const candidate = await repository.runTransaction(tx => tx.get('jobs',input.jobId));
    if (candidate?.schemaVersion || candidate?.sourceRefs) return runTwoSource({repository,orders,model,paymentExecution,now},input);
    let { run } = await repository.runTransaction(async tx => {
      const snapshot = await load(tx, input);
      if (snapshot.run) return snapshot;
      const initial = { jobId: input.jobId, revision: 0, stage: snapshot.order.proof ? 'DELIVERY_PENDING' : 'READY',
        approvedJobInput: approvedInput(snapshot.job), quote: copy(snapshot.order.quote),
        operationId: paymentOperationId(snapshot.job.quoteId),
        paymentAttempted: false, report: null };
      tx.create('agentRuns', input.jobId, initial);
      return { ...snapshot, run: initial };
    });
    const save = async (patch, { purchase = false } = {}) => {
      const observedAt = now(); // outside retryable callbacks
      const next = await repository.runTransaction(async tx => {
        const snapshot = await load(tx, input);
        if (snapshot.run.revision !== run.revision) fail('RUN_SUPERSEDED');
        let change = patch;
        if (purchase) {
          const reason = snapshot.job.state !== 'LOCAL_ACTIVE' ? 'OWNER_STOPPED' :
            !Number.isFinite(observedAt) || Date.parse(snapshot.job.scope.expiresAt) <= observedAt ? 'DEADLINE_EXPIRED' : null;
          if (snapshot.order.proof) change = { stage: 'DELIVERY_PENDING' };
          else if (reason) change = { stage: 'BLOCKED', blockReason: reason,
            report: reportFor(run, snapshot.order, [], [reason]) };
        }
        const updated = { ...snapshot.run, ...change, revision: run.revision + 1 };
        tx.set('agentRuns', input.jobId, updated);
        return updated;
      });
      run = next;
      return run;
    };
    if (['COMPLETE', 'BLOCKED'].includes(run.stage)) return run;
    const paymentRequest = () => ({ operationId: run.operationId,
      approvedJobInput: copy(run.approvedJobInput), quote: copy(run.quote) });
    if (['READY', 'PAYMENT_PRECHECK'].includes(run.stage)) {
      await save({ stage: 'PAYMENT_PRECHECK' });
      // Existing independently collected proof wins even if no runner record ever
      // existed. Missing proof is not nonpayment; submit's trusted operation port
      // must also deduplicate/locate any earlier same-order operation atomically.
      const current = await orders.checkPayment(input);
      await save({ stage: current.proof ? 'DELIVERY_PENDING' : 'READY' });
    }
    if (['READY', 'MODEL_PENDING'].includes(run.stage)) {
      await save({ stage: 'MODEL_PENDING' }, { purchase: true });
      if (run.stage === 'BLOCKED') return run;
      if (run.stage === 'MODEL_PENDING') {
        const proposed = await model.propose({ phase: 'plan', approvedJobInput: copy(run.approvedJobInput),
          approvedQuote: copy(run.quote), tools: [{ name: 'requestquote', approvedQuote: copy(run.quote) }] });
        if (!exact(proposed, 'tool arguments') || proposed.tool !== 'requestquote' ||
          !isDeepStrictEqual(proposed.arguments, run.quote)) fail('MODEL_REQUEST_REJECTED');
        // requestquote resolves only the immutable approved quote, not new terms.
        await save({ stage: 'QUOTE_READY' });
      }
    }
    if (run.stage === 'QUOTE_READY' && !run.paymentAttempted) {
      await save({ stage: 'PAYMENT_SUBMITTING', paymentAttempted: true }, { purchase: true });
      if (run.stage === 'BLOCKED') return run;
      if (run.stage === 'PAYMENT_SUBMITTING') {
        let submission;
        try { submission = await paymentExecution.submit(paymentRequest()); }
        catch { submission = { status: 'unknown' }; }
        await save({ stage: 'PAYMENT_RECONCILING', submission: observation(submission) });
      }
    }
    if (['PAYMENT_SUBMITTING', 'PAYMENT_RECONCILING', 'PAYMENT_UNKNOWN'].includes(run.stage)) {
      // A durable submit intent is one-way: even a crash BEFORE actual submission
      // is uncertain. Only locate that same operation; never resubmit it.
      await save({ stage: 'PAYMENT_RECONCILING' });
      let submission;
      try { submission = await paymentExecution.lookup(paymentRequest()); }
      catch { submission = { status: 'unknown' }; }
      await save({ stage: 'PAYMENT_RECONCILING', submission: observation(submission) });
      const order = await orders.checkPayment(input);
      if (!order.proof) {
        await save({ stage: 'PAYMENT_UNKNOWN', report: reportFor(run, order, [], ['PAYMENT_EVIDENCE_UNAVAILABLE']) });
        return run;
      }
    }
    await save({ stage: 'DELIVERY_PENDING' });
    let delivered;
    try { delivered = await orders.retrieveDelivery(input); }
    catch {
      const { order } = await repository.runTransaction(tx => load(tx, input));
      await save({ stage: 'PARTIAL', report: reportFor(run, order, [], ['DELIVERY_EVIDENCE_UNAVAILABLE']) });
      return run;
    }
    const { order: stored } = await repository.runTransaction(tx => load(tx, input));
    const a = delivered?.artifact;
    if (!isDeepStrictEqual(delivered, stored) || !stored.proof || !a ||
      typeof a.artifactId !== 'string' || a.orderId !== stored.orderId || a.vendorId !== stored.quote.vendorId ||
      typeof a.fictionalSample !== 'boolean' ||
      (run.approvedJobInput.qualification === 'LOCAL_SYNTHETIC_ONLY' && a.fictionalSample !== true) ||
      typeof a.content !== 'string' || a.content.length === 0 || a.content.length > 65536 ||
      a.contentDigest !== createHash('sha256').update(a.content).digest('hex')) {
      await save({ stage: 'PARTIAL', report: reportFor(run, stored, [], ['DELIVERY_EVIDENCE_INVALID']) });
      return run;
    }
    await save({ stage: 'REPORT_PENDING' });
    let proposedReport;
    try {
      proposedReport = await model.propose({ phase: 'report', approvedJobInput: copy(run.approvedJobInput),
        evidence: [copy(delivered.artifact)], tools: [] });
    } catch {
      await save({ stage: 'PARTIAL', report: reportFor(run, delivered, [], ['MODEL_REPORT_UNAVAILABLE']) });
      return run;
    }
    const findings = proposedReport?.findings;
    if (!exact(proposedReport, 'findings') || !Array.isArray(findings) || findings.length < 1 || findings.length > 12 ||
      !Array.from(findings).every(f => exact(f, 'artifactId excerpt') && f.artifactId === delivered.artifact.artifactId &&
        typeof f.excerpt === 'string' && f.excerpt.length > 0 && f.excerpt.length <= 4096 &&
        delivered.artifact.content.includes(f.excerpt))) {
      await save({ stage: 'PARTIAL', report: reportFor(run, delivered, [], ['MODEL_REPORT_REJECTED']) });
      return run;
    }
    await save({ stage: 'COMPLETE', report: reportFor(run, delivered, findings) });
    return run;
  } };
}
