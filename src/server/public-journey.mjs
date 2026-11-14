import { approvedSources, jobSourceRefs, approvedInput, paymentOperationId } from '../shared/job-contract.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { baseDecode, baseEncode } from 'near-api-js';
import { createWalletSessions, WalletSessionError } from './wallet-session.mjs';
import { createPublicOrders, JourneyError, validatePublicManifest } from './orders.mjs';
import { createJobRunner } from '../agent/run-job.mjs';
import { createModelProvider } from '../agent/model-provider.mjs';
import { createNearMandateExecution } from './near-mandate.mjs';
import { createNearReceiptCollector } from './near-receipts.mjs';
import { OWNER_ACTION_GAS } from './near-owner-operations.mjs';

// Independent of any unsigned candidate or wallet result: project only the
// immutable terms admitted by the trusted manifest provider, plus fixed gas policy.
function ownerApproval(job) {
  const m = job.publicManifest, scope = m.approved.job;
  const common = { network: 'testnet', owner: job.ownerId, mandate: scope.mandateId };
  const create = m.creation ? { ...common, kind: 'create', gas: m.creation.create_gas,
    factory: m.creation.factory, job_label: m.creation.job_label, agent: m.binding.signerId,
    allowlist: [...scope.vendorIds], cap: scope.budgetAtomic,
    deadline_ns: String(BigInt(Date.parse(scope.expiresAt)) * 1_000_000n), operating_float: m.creation.operating_float } : null;
  return { manifestId: m.manifestId, jobId: job.jobId, ownerId: job.ownerId, mandateId: scope.mandateId,
    actions: { create, stop: { ...common, kind: 'stop', gas: OWNER_ACTION_GAS },
      withdraw: { ...common, kind: 'withdraw', gas: OWNER_ACTION_GAS } } };
}

const version = 'haldir.public.v1';
const demand = (ok, code, status = 400) => { if (!ok) throw new JourneyError(code, status); };
const token = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s);
const validHash = s => { try { return typeof s === 'string' && baseDecode(s).length === 32 && baseEncode(baseDecode(s)) === s; } catch { return false; } };
const operationKey = (jobId, action) => createHash('sha256').update(JSON.stringify(['haldir-owner-v1', jobId, action])).digest('hex');
const canonicalAttempt = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
const ownerManifestDigest = job => createHash('sha256').update(JSON.stringify([job.publicManifest, job.scope])).digest('hex');
const sameJobTerms = (a,b) => a?.jobId===b.jobId && a.ownerId===b.ownerId && a.qualification===b.qualification && a.quoteId===b.quoteId && a.schemaVersion===b.schemaVersion && equal(a.sourceRefs,b.sourceRefs) && equal(a.scope,b.scope) && equal(a.publicManifest,b.publicManifest);
const unissued = row => row.request === null && row.transactionHash === null && row.receipt === null;
function count(req, name) { let n = 0; for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) n++; return n; }
function cookieToken(req) {
  if (count(req, 'cookie') !== 1) return undefined;
  const cookies = req.headers.cookie.split(';').map(x => x.trim()).filter(x => x.startsWith('__Host-haldir_session='));
  if (cookies.length !== 1) return undefined;
  const value = cookies[0].slice('__Host-haldir_session='.length);
  return /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value ? value : undefined;
}
async function body(req, keys, timeoutMs) {
  demand(count(req, 'content-type') === 1 && /^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') &&
    !count(req, 'content-encoding'), 'JSON_REQUIRED', 415);
  demand(!req.headers['content-length'] || Number(req.headers['content-length']) <= 4096, 'BODY_TOO_LARGE', 413);
  const bytes = await new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const finish = (error, result) => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', abort); req.off('aborted', abort);
      if (error) { req.pause(); reject(error); } else resolve(result); };
    const data = chunk => { size += chunk.length; if (size > 4096) return finish(new JourneyError('BODY_TOO_LARGE', 413)); chunks.push(chunk); };
    const end = () => finish(null, Buffer.concat(chunks));
    const abort = () => finish(new JourneyError('INVALID_BODY', 400));
    const timer = setTimeout(() => finish(new JourneyError('BODY_TIMEOUT', 408)), timeoutMs);
    req.on('data', data); req.on('end', end); req.on('error', abort); req.on('aborted', abort);
  });
  let text, parsed;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); parsed = JSON.parse(text); }
  catch { throw new JourneyError('INVALID_JSON', 400); }
  demand(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && equal(Object.keys(parsed).sort(), [...keys].sort()) &&
    keys.every(k => typeof parsed[k] === 'string'), 'INVALID_BODY');
  // Flat strings permit an exact token grammar, including escaped duplicate keys.
  const pieces = text.match(/"(?:\\[\s\S]|[^"\\])*"|[^\s]/g); const seen = new Set();
  demand(pieces?.[0] === '{' && pieces.at(-1) === '}', 'INVALID_BODY');
  for (let i = 1; i < pieces.length - 1;) {
    const k = JSON.parse(pieces[i++]); demand(typeof k === 'string' && !seen.has(k) && pieces[i++] === ':', 'INVALID_BODY'); seen.add(k);
    demand(typeof JSON.parse(pieces[i++]) === 'string', 'INVALID_BODY');
    if (i < pieces.length - 1) demand(pieces[i++] === ',', 'INVALID_BODY');
  }
  demand(seen.size === keys.length, 'INVALID_BODY'); return parsed;
}

/** Public composition only, no listener, environment discovery, key defaults or
 * localTestOnly path. Mount handle explicitly in a successor host; the incumbent
 * authentication preview/packager is intentionally unchanged. Trusted adapters
 * must be qualified separately; configuration booleans are NOT that evidence.
 */
export function createPublicJourney(options = {}) {
  const { repository, approvedOrigin, approvedRecipient, trustedAccessKeyReader, now = Date.now,
    trustedManifestProvider, trustedSignerProvider, trustedMandateStatusReader, model, ownerOperations, capabilities = {},
    maxRunMs = 45_000, bodyTimeoutMs = 2_000 } = options;
  demand(!Object.hasOwn(options, 'localTestOnly') && !Object.hasOwn(options, 'testOnlySession') &&
    !Object.hasOwn(options, 'provider'), 'PUBLIC_CONFIGURATION_INVALID', 503);
  demand(typeof repository?.runTransaction === 'function' && Number.isSafeInteger(maxRunMs) && maxRunMs > 0 && maxRunMs <= 60_000 &&
    Number.isSafeInteger(bodyTimeoutMs) && bodyTimeoutMs > 0 && bodyTimeoutMs <= 10_000, 'PUBLIC_CONFIGURATION_INVALID', 503);
  const sessions = createWalletSessions({ repository, approvedOrigin, approvedRecipient, trustedAccessKeyReader, now });
  const host = new URL(approvedOrigin).host;
  const gates = Object.freeze({ financialActions: capabilities.financialActions === true, publicTestnet: capabilities.publicTestnet === true,
    qualifiedModel: capabilities.qualifiedModel === true, qualifiedSigning: capabilities.qualifiedSigning === true,
    trustedManifestProvider: typeof trustedManifestProvider === 'function', trustedSignerProvider: typeof trustedSignerProvider === 'function',
    model: typeof model?.propose === 'function' });
  const missingConfiguration = Object.entries(gates).filter(([, ok]) => !ok).map(([key]) => key);
  const financialGate = () => demand(missingConfiguration.length === 0, 'FINANCIAL_NOT_CONFIGURED', 503);
  const orders = typeof trustedManifestProvider === 'function' ? createPublicOrders({ repository, trustedManifestProvider, now }) : null;
  async function limit(ownerId, route) {
    const clock = now(); demand(Number.isSafeInteger(clock) && clock >= 0, 'PROVIDER_UNAVAILABLE', 503);
    const window = Math.floor(clock / 60_000), bound = route === 'admission' ? 10 : 20;
    const key = createHash('sha256').update(JSON.stringify(['haldir-public-rate-v1', ownerId, route])).digest('hex');
    await repository.runTransaction(async tx => {
      const prior = await tx.get('publicRateLimits', key);
      demand(!prior || clock >= prior.observedAt, 'PROVIDER_UNAVAILABLE', 503);
      const count = prior?.window === window ? prior.count : 0;
      demand(count < bound, 'RATE_LIMITED', 429);
      tx.set('publicRateLimits', key, { ownerId, route, window, count: count + 1, observedAt: clock });
    });
  }
  async function owned(ownerId, jobId) {
    demand(token(jobId), 'NOT_FOUND', 404);
    return repository.runTransaction(async tx => {
      const job = await tx.get('jobs', jobId);
      demand(job?.ownerId === ownerId && job.qualification === 'PUBLIC_TESTNET_FICTIONAL_VENDOR' && job.publicManifest, 'NOT_FOUND', 404);
      let refs,sources;
      try { refs=jobSourceRefs(job);sources=approvedSources(job.publicManifest.approved); } catch { throw new JourneyError('APPROVAL_CHANGED',409); }
      demand(equal(job.scope,job.publicManifest.approved.job) && equal(refs,sources.map(({sourceId,quoteId})=>({sourceId,quoteId}))), 'APPROVAL_CHANGED',409);
      for (const source of sources) {
        const quote=await tx.get('quotes',source.quoteId),order=await tx.get('orders',source.quoteId);
        demand(quote?.jobId===jobId && quote.ownerId===ownerId && order?.jobId===jobId && order.quoteId===source.quoteId && equal(quote.quote,source.quote) && equal(order.quote,source.quote), 'QUOTE_CHANGED',409);
      }
      return job;
    });
  }
  async function view(ownerId, jobId) {
    const snapshot = await repository.runTransaction(async tx => {
      const stored = await tx.get('jobs', jobId);
      demand(stored?.ownerId === ownerId && stored.qualification === 'PUBLIC_TESTNET_FICTIONAL_VENDOR', 'NOT_FOUND', 404);
      let refs, sources;
      try { refs=jobSourceRefs(stored); sources=approvedSources(stored.publicManifest.approved); } catch { throw new JourneyError('APPROVAL_CHANGED',409); }
      demand(equal(stored.scope,stored.publicManifest.approved.job) && equal(refs,sources.map(({sourceId,quoteId})=>({sourceId,quoteId}))), 'APPROVAL_CHANGED',409);
      const members=[]; let uncertain = false;
      for (const ref of refs) {
        const order=await tx.get('orders',ref.quoteId), quote=await tx.get('quotes',ref.quoteId), op=await tx.get('nativeOperations',ref.quoteId);
        demand(order?.jobId===jobId && order.quoteId===ref.quoteId && quote?.jobId===jobId && quote.ownerId===ownerId && equal(order.quote,quote.quote) && equal(order.quote,sources.find(s=>s.quoteId===ref.quoteId)?.quote), 'QUOTE_CHANGED',409);
        if (stored.schemaVersion && order.proof) {
          const claim=await tx.get('claims',order.proof.proofId),delivery=await tx.get('deliveries',ref.quoteId),a=order.artifact;
          demand(claim?.jobId===jobId && claim.quoteId===ref.quoteId && equal(claim.proof,order.proof) && delivery?.jobId===jobId && delivery.quoteId===ref.quoteId && delivery.artifactId===`fictional:${ref.quoteId}` && equal(delivery.artifact,a), 'QUOTE_CHANGED',409);
          if (a) demand(a.artifactId===delivery.artifactId && a.orderId===order.orderId && a.vendorId===order.quote.vendorId && a.fictionalSample===true && typeof a.content==='string' && a.content.length>0 && a.content.length<=65536 && a.contentDigest===createHash('sha256').update(a.content).digest('hex'), 'QUOTE_CHANGED',409);
        } else if(stored.schemaVersion) demand(!order.artifact,'QUOTE_CHANGED',409);
        if (stored.schemaVersion && op) demand(op.ownerId===ownerId && op.jobId===jobId && equal(op.binding,stored.publicManifest.binding) && equal(op.request,{operationId:paymentOperationId(ref.quoteId),approvedJobInput:approvedInput(stored,ref.quoteId),quote:order.quote}), 'APPROVAL_CHANGED',409);
        if (op && !order.proof) uncertain = true;
        members.push({sourceId:ref.sourceId,order,payment:{status:op?(op.transactionHash?'SUBMITTED':'ATTENTION_REQUIRED'):'NOT_STARTED',transactionHash:op?.transactionHash??null}});
      }
      const order=members[0].order, run=await tx.get('agentRuns',jobId);
      let publicReport=run?.report ?? null;
      if (stored.schemaVersion && run) {
        demand(run.schemaVersion==='haldir.agent-run.two-source.v1' && equal(run.approvedJobInput,approvedInput(stored)) && equal(run.approvedSources,sources) && equal(run.sourceRuns?.map(s=>s.quoteId),refs.map(s=>s.quoteId)), 'APPROVAL_CHANGED',409);
        if(run.report) {
          const r=run.report, facts=r.facts, interpretations=r.interpretations;
          const purchases=members.map(({sourceId,order:o})=>({sourceId,quoteId:o.quoteId,orderId:o.orderId,vendorId:o.quote.vendorId,amountAtomic:o.quote.amountAtomic,lifecycle:o.lifecycle,proofId:o.proof?.proofId??null,artifactId:o.artifact?.artifactId??null}));
          demand(r.schemaVersion==='haldir.report.two-source.v1' && r.purpose===stored.scope.purpose && r.output===stored.scope.output && r.qualification===stored.qualification && r.supplierVerified===false && r.fictionalSample===true && (r.status!=='EVIDENCE_REVIEW_REQUIRED'||equal(r.purchases,purchases)) && ['PARTIAL','EVIDENCE_REVIEW_REQUIRED'].includes(r.status) && Array.isArray(facts) && facts.length<=12 && Array.from(facts).every(f=>{
            const m=members.find(m=>m.order.artifact?.artifactId===f?.artifactId),o=m?.order,a=o?.artifact;
            return a && o.proof && typeof f.excerpt==='string' && f.excerpt.length>0 && f.excerpt.length<=4096 && a.content.includes(f.excerpt) && equal(f,{artifactId:a.artifactId,excerpt:f.excerpt,sourceId:m.sourceId,quoteId:o.quoteId,orderId:o.orderId,vendorId:o.quote.vendorId,amountAtomic:o.quote.amountAtomic,proofId:o.proof.proofId,contentDigest:a.contentDigest,fictionalSample:true});
          }) && (r.status!=='EVIDENCE_REVIEW_REQUIRED'||members.every(m=>m.order.artifact&&facts.some(f=>f.artifactId===m.order.artifact.artifactId))), 'APPROVAL_CHANGED',409);
          demand(Array.isArray(interpretations) && interpretations.length<=2 && new Set(interpretations.map(i=>i?.kind)).size===interpretations.length && Array.from(interpretations).every(i=>i && equal(Object.keys(i).sort(),['findingIndexes','kind']) && ['COMPARE_COMPANY_DETAILS','COMPARE_SOURCE_CONSISTENCY'].includes(i.kind) && Array.isArray(i.findingIndexes) && i.findingIndexes.length>=1 && i.findingIndexes.length<=12 && new Set(i.findingIndexes).size===i.findingIndexes.length && Array.from(i.findingIndexes).every(n=>Number.isInteger(n)&&n>=0&&n<facts.length) && (i.kind!=='COMPARE_SOURCE_CONSISTENCY'||new Set(i.findingIndexes.map(n=>facts[n].sourceId)).size===2)), 'APPROVAL_CHANGED',409);
          // Reads reproject current durable evidence. A stale partial cache must
          // neither hide recovered delivery nor consume the full report phase.
          const complete=r.status==='EVIDENCE_REVIEW_REQUIRED';
          const unavailable=!complete && Array.isArray(r.limits) && r.limits.includes('MODEL_REPORT_UNAVAILABLE');
          const reason=stored.state!=='LOCAL_ACTIVE'?'OWNER_STOPPED':Date.parse(stored.scope.expiresAt)<=now()?'DEADLINE_EXPIRED':null;
          const attempted=m=>run.sourceRuns.find(s=>s.quoteId===m.order.quoteId).paymentAttempted;
          const missing=[];
          for(const m of members) {
            if(!m.order.proof)missing.push(`${m.sourceId}:${attempted(m)?'PAYMENT_EVIDENCE_UNAVAILABLE':reason??'NOT_STARTED'}`);
            else if(!m.order.artifact)missing.push(`${m.sourceId}:DELIVERY_EVIDENCE_UNAVAILABLE`);
          }
          if(!complete&&members.every(m=>m.order.artifact))missing.push(unavailable?'MODEL_REPORT_UNAVAILABLE':'MODEL_REPORT_PENDING');
          const pending=members.find(m=>!m.order.proof&&attempted(m)),delivery=members.find(m=>m.order.proof&&!m.order.artifact),unstarted=members.find(m=>!m.order.proof&&!attempted(m));
          const nextCheck=pending?{code:'CHECK_SAME_PAYMENT',sourceId:pending.sourceId}:delivery?{code:'RETRIEVE_SAME_DELIVERY',sourceId:delivery.sourceId}:unstarted?{code:reason?'OWNER_REVIEW':'RESUME_APPROVED_JOB',sourceId:unstarted.sourceId}:{code:complete?'COMPARE_SOURCES_WITH_CONTRACT':'REVIEW_REPORT_AVAILABILITY',sourceId:null};
          const fallback=members.filter(m=>m.order.artifact).map(({sourceId,order:o})=>({artifactId:o.artifact.artifactId,excerpt:o.artifact.content.slice(0,4096),sourceId,quoteId:o.quoteId,orderId:o.orderId,vendorId:o.quote.vendorId,amountAtomic:o.quote.amountAtomic,proofId:o.proof.proofId,contentDigest:o.artifact.contentDigest,fictionalSample:true}));
          publicReport={schemaVersion:'haldir.report.two-source.v1',purpose:stored.scope.purpose,output:stored.scope.output,status:complete?'EVIDENCE_REVIEW_REQUIRED':'PARTIAL',supplierVerified:false,fictionalSample:true,qualification:stored.qualification,purchases,facts:complete?facts:fallback,interpretations:complete?interpretations:[],limits:['FICTIONAL_SAMPLE','SOURCE_ACCURACY_NOT_VERIFIED','NO_SIGNING_ASSURANCE',...(members.some(m=>!m.order.artifact)?['INCOMPLETE_EVIDENCE']:[]),...(unavailable?['MODEL_REPORT_UNAVAILABLE']:[])],nextCheck,missing,ownerActions:{stop:'OWNER_ACTION_REQUIRED',withdraw:'OWNER_ACTION_REQUIRED',residual:'NOT_OBSERVED'}};
        }
      }
      const ownerRows = [];
      for (const action of ['create', 'stop', 'withdraw']) { const row = await tx.get('ownerOperations', operationKey(jobId, action)); if (row) ownerRows.push(row); }
      uncertain ||= ownerRows.some(row => row.ownerId === ownerId && row.jobId === jobId && ['PREPARING', 'AWAITING_WALLET', 'SUBMITTED', 'UNKNOWN'].includes(row.status));
      return { manifest: stored.publicManifest, uncertain, value: { contractVersion: stored.schemaVersion ? 'haldir.public.v2' : version,
        job: { jobId: stored.jobId, ownerId: stored.ownerId, scope: stored.scope, state: stored.state === 'LOCAL_ACTIVE' ? 'ACTIVE' : 'STOPPED',
          qualification: stored.qualification, manifestId: stored.publicManifest.manifestId,
          ownerCreationRequired: stored.publicManifest.chainEvidence.deployment === 'FACTORY_READY',
          ...(stored.schemaVersion ? {schemaVersion:stored.schemaVersion,sourceRefs:refs}: {}) },
        order, run: run ? { stage: run.stage, report: publicReport } : null,
        payment: members[0].payment, ...(stored.schemaVersion ? {orders:members}: {}),
        ownerOperations: ownerRows.map(publicOperation), ownerApproval: ownerApproval(stored),
        disclosures: { vendorData: 'FICTIONAL_SAMPLE', supplierVerified: false,
          principalReturn: 'Only a confirmed withdraw receipt establishes returned principal; free balance is not a refund' } } };
    });
    // The durable snapshot finishes before this bounded chain observation; the
    // later FINAL block is not an atomic snapshot across the two systems.
    const manifest = snapshot.manifest;
    let economics = { schemaVersion: 'haldir.mandate-economics.v1', state: 'unavailable',
      networkId: 'testnet', ownerId, mandateId: manifest.binding.mandateId,
      source: { rpcUrl: manifest.rpcUrl, method: 'get_status', finality: 'final' },
      observation: null, amounts: null, reason: 'NOT_CONFIGURED' };
    if (typeof trustedMandateStatusReader === 'function') {
      try {
        const result = await bounded(Math.min(maxRunMs, 5000), scope => scope.step(() =>
          trustedMandateStatusReader({ ownerId, jobId, manifest: structuredClone(manifest), signal: scope.signal })));
        economics = validEconomics(result, economics, manifest.approved.job.budgetAtomic, now())
          ? structuredClone(result) : { ...economics, reason: 'BINDING_MISMATCH' };
      }
      catch { economics = { ...economics, reason: 'RPC_UNAVAILABLE' }; }
    }
    if (snapshot.uncertain) economics = { ...economics, state: 'uncertain', reason: 'OPERATION_UNCERTAIN' };
    return { ...snapshot.value, economics };
  }
  async function run(job) {
    const attemptId = randomUUID();
    await repository.runTransaction(async tx => {
      const current = await tx.get('jobs', job.jobId), guard = await tx.get('publicRunGuards', job.jobId);
      demand(sameJobTerms(current,job), 'NOT_FOUND', 404);
      if (current.publicManifest.chainEvidence.deployment === 'FACTORY_READY') {
        const creation = await tx.get('ownerOperations', operationKey(job.jobId, 'create'));
        const receipt = creation?.receipt;
        demand(creation?.jobId === job.jobId && creation.ownerId === job.ownerId && creation.action === 'create' &&
          creation.status === 'CONFIRMED' && receipt?.status === 'CONFIRMED' && receipt.finality === 'final' &&
          receipt.networkId === 'testnet' && receipt.ownerId === job.ownerId && receipt.signerId === job.ownerId &&
          receipt.action === 'create' && receipt.mandateId === current.publicManifest.binding.mandateId &&
          validHash(creation.transactionHash) && receipt.transactionHash === creation.transactionHash,
        'OWNER_CREATION_REQUIRED', 409);
      }
      demand(guard?.status !== 'ACTIVE', 'RUN_IN_PROGRESS', 409);
      tx.set('publicRunGuards', job.jobId, { attemptId, ownerId: job.ownerId, status: 'ACTIVE' });
    });
    try { return await bounded(maxRunMs, async scope => {
      const manifest = structuredClone(job.publicManifest);
      let signer;
      try {
        signer = await scope.step(() => trustedSignerProvider({ ownerId: job.ownerId, jobId: job.jobId, manifest: structuredClone(manifest), signal: scope.signal }));
        demand(typeof signer?.getPublicKey === 'function' && typeof signer?.signTransaction === 'function', 'PROVIDER_UNAVAILABLE', 503);
        const pk = await scope.step(() => signer.getPublicKey());
        demand(pk?.toString() === manifest.binding.publicKey, 'PROVIDER_UNAVAILABLE', 503);
      } catch (error) { scope.check(); throw new JourneyError('PROVIDER_UNAVAILABLE', 503); }
      const execution = createNearMandateExecution({ repository, binding: manifest.binding,
        rpcUrl: manifest.rpcUrl, allowedRpcUrls: manifest.allowedRpcUrls, now, timeoutMs: scope.remaining(), signal: scope.signal, executionGuard: scope.check,
        signer: { getPublicKey: () => scope.step(() => signer.getPublicKey()),
          signTransaction: transaction => scope.step(() => signer.signTransaction(transaction)) } });
      const collector = createNearReceiptCollector({ rpcUrl: manifest.rpcUrl, allowedRpcUrls: manifest.allowedRpcUrls,
        timeoutMs: scope.remaining(), loadOperation: execution.loadOperation });
      const runOrders = createPublicOrders({ repository, trustedManifestProvider, now,
        trustedReceiptCollector: input => scope.step(() => collector.trustedReceiptCollector(input)) });
      const runner = createJobRunner({ repository, orders: runOrders, now,
        model: { propose: async input => {
          try { return await scope.step(() => model.propose({ ...input, signal: scope.signal })); }
          catch (error) {
            scope.check();
            if (model.contractVersion === 'haldir.model.runner-recovery.v1' && typeof model.recover === 'function' && error?.code === 'MODEL_NOT_SENT')
              throw Object.assign(new Error('MODEL_NOT_SENT'), { code: 'MODEL_NOT_SENT' });
            throw new JourneyError('PROVIDER_UNAVAILABLE', 503);
          }
        }, ...(model.contractVersion === 'haldir.model.runner-recovery.v1' && typeof model.recover === 'function' ? {
          contractVersion: model.contractVersion,
          recover: async input => {
            try { return await scope.step(() => model.recover({ ...input, signal: scope.signal })); }
            catch { scope.check(); throw new JourneyError('PROVIDER_UNAVAILABLE', 503); }
          },
        } : {}) },
        paymentExecution: { submit: input => scope.step(() => execution.submit(input)),
          lookup: input => scope.step(() => execution.lookup(input)) } });
      await runner.runJob({ ownerId: job.ownerId, jobId: job.jobId });
      scope.check();
      return view(job.ownerId, job.jobId);
    }); } finally {
      // No time-based takeover: a slow/uncancellable provider must not overlap a
      // successor. A crashed ACTIVE guard needs operator reconciliation.
      await repository.runTransaction(async tx => {
        const guard = await tx.get('publicRunGuards', job.jobId);
        demand(guard?.attemptId === attemptId, 'RUN_SUPERSEDED', 409);
        tx.set('publicRunGuards', job.jobId, { ...guard, status: 'IDLE' });
      });
    }
  }
  async function ownerAction(job, kind, data) {
    demand(typeof ownerOperations?.prepare === 'function' && typeof ownerOperations?.reconcile === 'function', 'FINANCIAL_NOT_CONFIGURED', 503);
    return bounded(maxRunMs, async scope => {
      const input = row => ({ operationId: row.operationId, action: row.action, ownerId: job.ownerId,
        job: structuredClone(job), manifest: structuredClone(job.publicManifest), signal: scope.signal,
        ...(row.transactionHash ? { transactionHash: row.transactionHash, signerId: job.ownerId } : {}) });
      if (kind === 'owner/prepare' || kind === 'owner/retry-prepare') {
        const retry = kind === 'owner/retry-prepare';
        demand((retry ? ['stop', 'withdraw'] : ['create', 'stop', 'withdraw']).includes(data.action), 'INVALID_BODY');
        const operationId = operationKey(job.jobId, data.action);
        if (retry) demand(data.operationId === operationId &&
          (data.attemptId === 'unreserved' || canonicalAttempt(data.attemptId)), 'INVALID_BODY');
        // Randomness is outside the retriable callback. Its returned claim, not
        // a mutable closure flag, determines which caller may issue a request.
        const attemptId = randomUUID(), manifestDigest = ownerManifestDigest(job);
        const { row, created } = await repository.runTransaction(async tx => {
          const latest = await tx.get('jobs', job.jobId), existing = await tx.get('ownerOperations', operationId);
          demand(sameJobTerms(latest,job), 'OPERATION_CONFLICT', 409);
          if (existing) {
            demand(existing.operationId === operationId && existing.jobId === job.jobId &&
              existing.ownerId === job.ownerId && existing.action === data.action, 'OPERATION_CONFLICT', 409);
            if (!retry || data.attemptId === 'unreserved' || existing.preparation?.attemptId !== data.attemptId ||
              existing.preparation.state !== 'UNISSUED_FAILED' || existing.status !== 'UNKNOWN' ||
              !unissued(existing) || existing.preparationManifest !== manifestDigest)
              return { row: existing, created: false };
            const prior = await tx.get('ownerPreparationAttempts', data.attemptId);
            demand(prior?.operationId === operationId && prior.state === 'UNISSUED_FAILED', 'OPERATION_CONFLICT', 409);
          } else demand(!retry || data.attemptId === 'unreserved', 'OPERATION_CONFLICT', 409);
          scope.check();
          const row = { ...(existing ?? {}), operationId, jobId: job.jobId, ownerId: job.ownerId, action: data.action,
            status: 'PREPARING', request: null, transactionHash: null, receipt: null,
            preparation: { attemptId, state: 'PREPARING' }, preparationManifest: manifestDigest };
          // One small immutable-lineage audit per attempt avoids a growing row,
          // retains predecessors, and never rewrites a prior financial ledger.
          tx.create('ownerPreparationAttempts', attemptId, { operationId, attemptId, state: 'PREPARING',
            previousAttemptId: existing?.preparation.attemptId ?? null });
          if (existing) tx.set('ownerOperations', operationId, row); else tx.create('ownerOperations', operationId, row);
          return { row, created: true };
        });
        if (!created) return { operation: publicOperation(row), walletEligible: false };
        let request, json;
        try {
          // Qualified prepare is PURE: repository reads and unsigned-call
          // construction only. It cannot sign, broadcast or save a request.
          request = await scope.step(() => ownerOperations.prepare(input(row)));
          json = JSON.stringify(request, (key, value) => {
            demand(!/^(?:privateKey|secretKey|seedPhrase|mnemonic|signature|signedTransaction|localTestOnly|testOnlySession|sessionToken|tokenHash)$/i.test(key), 'PROVIDER_UNAVAILABLE', 503);
            return value;
          });
          demand(json && Buffer.byteLength(json) <= 65_536 && equal(JSON.parse(json), request) && request &&
            typeof request === 'object' && !Array.isArray(request), 'PROVIDER_UNAVAILABLE', 503);
        }
        catch (error) {
          // This catch ends BEFORE any request-save transaction is started.
          // A throwing/uncertain claim or save is NEVER relabelled retryable.
          await repository.runTransaction(async tx => {
            const current = await tx.get('ownerOperations', operationId), latest = await tx.get('jobs', job.jobId);
            const audit = await tx.get('ownerPreparationAttempts', attemptId);
            if (!equal(current, row) || !sameJobTerms(latest,job) ||
              audit?.state !== 'PREPARING' || audit.operationId !== operationId) return;
            tx.set('ownerOperations', operationId, { ...current, status: 'UNKNOWN', preparation: { attemptId, state: 'UNISSUED_FAILED' } });
            tx.set('ownerPreparationAttempts', attemptId, { ...audit, state: 'UNISSUED_FAILED' });
          });
          scope.check(); throw new JourneyError('PROVIDER_UNAVAILABLE', 503);
        }
        const saved = await repository.runTransaction(async tx => {
          const current = await tx.get('ownerOperations', operationId), latest = await tx.get('jobs', job.jobId);
          const audit = await tx.get('ownerPreparationAttempts', attemptId);
          demand(equal(current, row) && sameJobTerms(latest,job) &&
            audit?.state === 'PREPARING' && audit.operationId === operationId, 'OPERATION_CONFLICT', 409); scope.check();
          const next = { ...current, request: JSON.parse(json), status: 'AWAITING_WALLET', preparation: { attemptId, state: 'ISSUED' } };
          tx.set('ownerOperations', operationId, next);
          tx.set('ownerPreparationAttempts', attemptId, { ...audit, state: 'ISSUED' }); return next;
        });
        // A successful callback is not a commit or a live response. A late commit
        // can retain ISSUED but may never return walletEligible:true.
        scope.check(); return { operation: publicOperation(saved), walletEligible: true };
      }
      demand(/^[a-f0-9]{64}$/.test(data.operationId) && validHash(data.transactionHash) && data.signerId === job.ownerId, 'INVALID_BODY');
      const row = await repository.runTransaction(async tx => {
        const current = await tx.get('ownerOperations', data.operationId);
        const claimKey = createHash('sha256').update(JSON.stringify(['haldir-owner-receipt-v1', 'testnet', data.transactionHash])).digest('hex');
        const claim = await tx.get('ownerReceiptClaims', claimKey);
        demand(!claim || claim.operationId === data.operationId, 'OPERATION_CONFLICT', 409);
        demand(current?.ownerId === job.ownerId && current.jobId === job.jobId &&
          current.operationId === operationKey(job.jobId, current.action), 'NOT_FOUND', 404);
        demand(current.request && current.status !== 'PREPARING' &&
          (!current.transactionHash || current.transactionHash === data.transactionHash), 'OPERATION_CONFLICT', 409);
        if (current.transactionHash) return current;
        const next = { ...current, transactionHash: data.transactionHash, status: 'SUBMITTED' };
        if (!claim) tx.create('ownerReceiptClaims', claimKey, { operationId: data.operationId, ownerId: job.ownerId, jobId: job.jobId });
        tx.set('ownerOperations', data.operationId, next); return next;
      });
      if (['CONFIRMED', 'FAILED'].includes(row.status)) return { operation: publicOperation(row) };
      let receipt;
      try { receipt = await scope.step(() => ownerOperations.reconcile(input(row))); }
      catch (error) {
        await repository.runTransaction(async tx => {
          const current = await tx.get('ownerOperations', row.operationId);
          if (current?.transactionHash === row.transactionHash && equal(current.preparation, row.preparation) &&
            current.ownerId === row.ownerId && current.jobId === row.jobId &&
            current.status === row.status) tx.set('ownerOperations', row.operationId, { ...current, status: 'UNKNOWN' });
        });
        scope.check(); throw new JourneyError('PROVIDER_UNAVAILABLE', 503);
      }
      demand(receipt && receipt.networkId === 'testnet' && receipt.ownerId === job.ownerId &&
        receipt.mandateId === job.publicManifest.binding.mandateId && receipt.action === row.action &&
        receipt.transactionHash === row.transactionHash && receipt.signerId === job.ownerId &&
        ['CONFIRMED', 'FAILED', 'UNKNOWN'].includes(receipt.status) &&
        (receipt.status === 'UNKNOWN' || receipt.finality === 'final') &&
        (receipt.status !== 'CONFIRMED' || row.action !== 'withdraw' || (validHash(receipt.receiptId) &&
          typeof receipt.amountAtomic === 'string' && /^[1-9][0-9]{0,38}$/.test(receipt.amountAtomic) && BigInt(receipt.amountAtomic) < 2n ** 128n)),
      'PROVIDER_UNAVAILABLE', 503);
      // Only explicitly bound qualified observation fields reach the public view.
      const observed = Object.fromEntries(['networkId', 'ownerId', 'mandateId', 'action', 'transactionHash', 'signerId',
        'finality', 'status', 'receiptId', 'amountAtomic'].filter(k => receipt[k] !== undefined).map(k => [k, receipt[k]]));
      if (observed.status !== 'CONFIRMED' || row.action !== 'withdraw') delete observed.amountAtomic;
      const saved = await repository.runTransaction(async tx => {
        const current = await tx.get('ownerOperations', row.operationId), latest = await tx.get('jobs', job.jobId);
        demand(current?.transactionHash === row.transactionHash && equal(current.preparation, row.preparation) &&
          sameJobTerms(latest,job), 'OPERATION_CONFLICT', 409);
        if (['CONFIRMED', 'FAILED'].includes(current.status)) return current;
        demand(current.status === row.status, 'OPERATION_CONFLICT', 409);
        scope.check(); const next = { ...current, status: observed.status, receipt: observed.status === 'UNKNOWN' ? null : observed };
        tx.set('ownerOperations', row.operationId, next);
        if (row.action === 'stop' && observed.status === 'CONFIRMED') tx.set('jobs', job.jobId, { ...latest, state: 'LOCAL_STOPPED' });
        return next;
      });
      return { operation: publicOperation(saved) };
    });
  }
  return Object.freeze({ handle: async (req, res) => {
    const send = (status, value) => { if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' }); res.end(JSON.stringify(value)); };
    try {
      demand(count(req, 'host') === 1 && req.headers.host === host && count(req, 'origin') === 1 && req.headers.origin === approvedOrigin &&
        count(req, 'x-haldir-csrf') === 1 && req.headers['x-haldir-csrf'] === '1' &&
        (!count(req, 'sec-fetch-site') || (count(req, 'sec-fetch-site') === 1 && req.headers['sec-fetch-site'] === 'same-origin')), 'ORIGIN_CSRF_REQUIRED', 403);
      const configRoute = req.method === 'POST' && req.url === '/api/public/config';
      const createRoute = req.method === 'POST' && req.url === '/api/public/jobs';
      const previewRoute = req.method === 'POST' && req.url === '/api/public/approvals/read';
      const route = /^\/api\/public\/jobs\/([a-zA-Z0-9_-]{1,64})(?:\/(run|resume|owner\/prepare|owner\/retry-prepare|owner\/receipt))?$/.exec(req.url);
      // Native browser GET may omit Origin. POST read preserves the exact same
      // origin/CSRF contract without trusting fabricated client Origin headers.
      demand(configRoute || previewRoute || createRoute || (route && ((req.method === 'GET' && !route[2]) || req.method === 'POST')), 'NOT_FOUND', 404);
      const data = req.method === 'POST' ? await body(req, previewRoute ? ['approvalId'] : createRoute ? ['approvalId', 'admissionKey'] :
        route?.[2] === 'owner/prepare' ? ['action'] : route?.[2] === 'owner/retry-prepare' ? ['action', 'operationId', 'attemptId'] :
          route?.[2] === 'owner/receipt' ? ['operationId', 'transactionHash', 'signerId'] : [], bodyTimeoutMs) : {};
      const principal = await sessions.authenticate({ origin: approvedOrigin, networkId: 'testnet', token: cookieToken(req) });
      const ownerId = principal.accountId; // ONLY verified wallet-session identity.
      if (configRoute) return send(200, { contractVersion: version, networkId: 'testnet', financialActions: !missingConfiguration.length,
        missingConfiguration, vendorData: 'FICTIONAL_SAMPLE', maxRunMs, supportedJobSchemas:['haldir.job.two-source.v1'] });
      if (previewRoute) {
        demand(token(data.approvalId),'INVALID_BODY'); await limit(ownerId,'admission');
        demand(typeof trustedManifestProvider==='function','MANIFEST_UNAVAILABLE',503);
        let m;
        try { m=await bounded(maxRunMs,scope=>scope.step(async()=>{
          const manifest=structuredClone(await trustedManifestProvider({ownerId,approvalId:data.approvalId,signal:scope.signal}));
          validatePublicManifest(manifest,ownerId,now()); return manifest;
        })); } catch { throw new JourneyError('MANIFEST_UNAVAILABLE',503); }
        return send(200,{contractVersion:m.approved.schemaVersion?'haldir.public.v2':version,approvalId:data.approvalId,manifestId:m.manifestId,ownerId,approved:m.approved,ownerCreationRequired:m.chainEvidence.deployment==='FACTORY_READY'});
      }
      if (createRoute) {
        financialGate(); await limit(ownerId, 'admission');
        const job = await bounded(maxRunMs, scope => scope.step(() => orders.createJob({ ownerId, ...data, signal: scope.signal })));
        return send(201, await view(ownerId, job.jobId));
      }
      const job = await owned(ownerId, route[1]);
      if (!route[2]) return send(200, await view(ownerId, job.jobId));
      // A disabled model/agent cannot prevent the authenticated owner from
      // stopping a prior mandate or recovering funds/receipts. New creation and
      // agent execution still require the complete financial capability gate.
      const ownerRecovery = route[2] === 'owner/receipt' || route[2] === 'owner/retry-prepare' ||
        (route[2] === 'owner/prepare' && ['stop', 'withdraw'].includes(data.action));
      if (ownerRecovery) demand(gates.publicTestnet && typeof ownerOperations?.prepare === 'function' &&
        typeof ownerOperations?.reconcile === 'function', 'FINANCIAL_NOT_CONFIGURED', 503);
      else financialGate();
      await limit(ownerId, route[2] === 'run' || route[2] === 'resume' ? 'run' : route[2]);
      if (route[2] === 'run' || route[2] === 'resume') return send(200, await run(job));
      return send(200, await ownerAction(job, route[2], data));
    } catch (error) {
      if (error instanceof WalletSessionError) return send(401, { error: 'UNAUTHENTICATED', contractVersion: version });
      send(error instanceof JourneyError ? error.status : error?.code === 'RUN_SUPERSEDED' ? 409 : 500,
        { error: error instanceof JourneyError || error?.code === 'RUN_SUPERSEDED' ? error.code : 'INTERNAL_ERROR', contractVersion: version });
    }
  } });
}
// Validate the injected observation at the HTTP trust boundary. This is not
// admission, an RPC status parser, a replacement balance, or spending authority.
function validEconomics(value, binding, cap, clock) {
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && equal(Object.keys(v).sort(), keys.split(' ').sort());
  const uint = (v, bits) => typeof v === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(v) && BigInt(v) < 2n ** BigInt(bits);
  try {
    if (!exact(value, 'schemaVersion state networkId ownerId mandateId source observation amounts reason') ||
      value.schemaVersion !== binding.schemaVersion || value.networkId !== binding.networkId || value.ownerId !== binding.ownerId ||
      value.mandateId !== binding.mandateId || !equal(value.source, binding.source)) return false;
    if (value.state === 'unavailable') return value.observation === null && value.amounts === null &&
      ['RPC_UNAVAILABLE', 'BINDING_MISMATCH', 'NOT_DEPLOYED', 'NOT_CONFIGURED'].includes(value.reason);
    if (!['known', 'stale', 'uncertain'].includes(value.state) || value.reason !==
      (value.state === 'known' ? null : value.state === 'stale' ? 'STALE_BLOCK' : 'OPERATION_UNCERTAIN')) return false;
    if (value.state === 'uncertain' && value.observation === null && value.amounts === null) return true;
    const o = value.observation, a = value.amounts;
    if (!exact(o, 'blockHash blockHeight blockTimestampNs observedAt') || !validHash(o.blockHash) ||
      !Number.isSafeInteger(o.blockHeight) || o.blockHeight <= 0 || !uint(o.blockTimestampNs, 64) ||
      !Number.isSafeInteger(o.observedAt) || o.observedAt < 0 || !Number.isSafeInteger(clock) || o.observedAt > clock ||
      BigInt(o.blockTimestampNs) > BigInt(o.observedAt) * 1000000n ||
      !exact(a, 'capAtomic spentAtomic reservedAtomic availableAtomic refundedAtomic') ||
      !Object.values(a).every(v => uint(v, 128)) || a.capAtomic !== cap ||
      BigInt(a.spentAtomic) + BigInt(a.reservedAtomic) + BigInt(a.availableAtomic) + BigInt(a.refundedAtomic) !== BigInt(a.capAtomic)) return false;
    const stale = BigInt(o.observedAt) * 1000000n - BigInt(o.blockTimestampNs) > 30000000000n;
    return value.state === 'uncertain' || (value.state === 'stale') === stale;
  } catch { return false; }
}
export function publicModelReservationKey(authorizationId, jobId, phase) {
  return createHash('sha256').update(JSON.stringify(['haldir-model-reservation-v1', authorizationId, jobId, phase])).digest('hex');
}
export function createPublicModelBudget({ repository, ownerId, jobId, configuration, authorization, now = Date.now, signal, releaseBudget, requestDigest } = {}) {
  demand(typeof repository?.runTransaction === 'function' && token(jobId) && typeof ownerId === 'string', 'PUBLIC_CONFIGURATION_INVALID', 503);
  // Reuse the adapter's exact grant validation; this deny-only probe never makes
  // a reservation or HTTP request. Credential material is never persisted.
  createModelProvider({ configuration, authorization, now, budget: { reserve: async () => false } });
  const shared = releaseBudget !== undefined || requestDigest !== undefined;
  demand(!shared || (releaseBudget && typeof releaseBudget === 'object' && !Array.isArray(releaseBudget) &&
    equal(Object.keys(releaseBudget).sort(), ['key', 'maxCostMicros']) &&
    typeof releaseBudget.key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(releaseBudget.key) &&
    typeof releaseBudget.maxCostMicros === 'string' && /^[1-9][0-9]{0,17}$/.test(releaseBudget.maxCostMicros) &&
    typeof requestDigest === 'string' && /^[a-f0-9]{64}$/.test(requestDigest)), 'PUBLIC_CONFIGURATION_INVALID', 503);
  const ceiling = shared ? structuredClone(releaseBudget) : null;
  const grant = structuredClone(authorization);
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const grantKey = digest(['haldir-model-grant-v1', grant.authorizationId]);
  const tariff = (n, rate) => (BigInt(n) * BigInt(rate) + 999999n) / 1000000n;
  return Object.freeze({ contractVersion: 'haldir.model-budget.atomic-release.v1',
    reservationKey: phase => publicModelReservationKey(grant.authorizationId, jobId, phase),
    async reserve(intent) {
    const clock = now();
    if (!intent || !equal(Object.keys(intent).sort(), ['authorizationId', 'jobId', 'phase', 'endpoint', 'model',
      'inputTokensUpperBound', 'maxCompletionTokens', 'reservedTokens', 'reservedCostMicros'].sort()) ||
      intent.authorizationId !== grant.authorizationId || intent.jobId !== jobId ||
      intent.endpoint !== grant.endpoint || intent.model !== grant.model || !['plan', 'report'].includes(intent.phase) ||
      !Number.isSafeInteger(intent.inputTokensUpperBound) || intent.inputTokensUpperBound < 1025 ||
      intent.inputTokensUpperBound > grant.maxPromptBytes + 1024 || intent.maxCompletionTokens !== grant.maxCompletionTokens ||
      intent.reservedTokens !== intent.inputTokensUpperBound + intent.maxCompletionTokens ||
      typeof intent.reservedCostMicros !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(intent.reservedCostMicros) ||
      BigInt(intent.reservedCostMicros) !== tariff(intent.inputTokensUpperBound, grant.inputRateMicrosPerMillion) +
        tariff(intent.maxCompletionTokens, grant.outputRateMicrosPerMillion) ||
      !Number.isSafeInteger(clock) || clock < 0 || Date.parse(grant.expiresAt) <= clock || signal?.aborted) return false;
    const reservationKey = publicModelReservationKey(grant.authorizationId, jobId, intent.phase);
    const frozen = structuredClone(intent);
    return repository.runTransaction(async tx => {
      const job = await tx.get('jobs', jobId), prior = await tx.get('modelGrants', grantKey), reservation = await tx.get('modelReservations', reservationKey);
      const release = shared ? await tx.get('modelReleaseSpend', ceiling.key) : null;
      if (job?.ownerId !== ownerId || job.qualification !== 'PUBLIC_TESTNET_FICTIONAL_VENDOR' || !job.publicManifest || reservation || signal?.aborted ||
        (prior && (prior.ownerId !== ownerId || prior.jobId !== jobId || !equal(prior.authorization, grant)))) return false;
      if (prior != null && (prior.authorizationId !== grant.authorizationId || !Number.isSafeInteger(prior.calls) || prior.calls < 1 ||
        !Number.isSafeInteger(prior.reservedTokens) || prior.reservedTokens < 1 || typeof prior.reservedCostMicros !== 'string' ||
        !/^(0|[1-9][0-9]{0,17})$/.test(prior.reservedCostMicros))) return false;
      let sources;
      try {
        sources = approvedSources(job.publicManifest.approved);
        if (job.jobId !== jobId || job.publicManifest.ownerId !== ownerId || !equal(job.scope, job.publicManifest.approved.job) ||
          !equal(jobSourceRefs(job), sources.map(({ sourceId, quoteId }) => ({ sourceId, quoteId })))) return false;
      } catch { return false; }
      for (const source of sources) {
        const order = await tx.get('orders', source.quoteId), quote = await tx.get('quotes', source.quoteId);
        if (order?.jobId !== jobId || order.quoteId !== source.quoteId || order.orderId !== source.quote.orderId ||
          quote?.jobId !== jobId || quote.ownerId !== ownerId || !equal(order.quote, source.quote) || !equal(quote.quote, source.quote)) return false;
      }
      const calls = (prior?.calls ?? 0) + 1, reservedTokens = (prior?.reservedTokens ?? 0) + frozen.reservedTokens;
      const reservedCostMicros = String(BigInt(prior?.reservedCostMicros ?? '0') + BigInt(frozen.reservedCostMicros));
      if (calls > grant.maxCalls || reservedTokens > grant.maxTotalTokens || BigInt(reservedCostMicros) > BigInt(grant.maxCostMicros)) return false;
      if (shared && release != null && (!equal(Object.keys(release).sort(), ['maxCostMicros', 'reservedCostMicros']) ||
        release.maxCostMicros !== ceiling.maxCostMicros || typeof release.reservedCostMicros !== 'string' ||
        !/^(0|[1-9][0-9]{0,17})$/.test(release.reservedCostMicros))) return false;
      const releaseTotal = shared ? BigInt(release?.reservedCostMicros ?? '0') + BigInt(frozen.reservedCostMicros) : 0n;
      if (shared && ((release && release.maxCostMicros !== ceiling.maxCostMicros) || releaseTotal > BigInt(ceiling.maxCostMicros))) return false;
      const admittedAt = now();
      if (!Number.isSafeInteger(admittedAt) || admittedAt < clock || Date.parse(grant.expiresAt) <= admittedAt || signal?.aborted) return false;
      // All admission checks precede all writes in the SAME transaction.
      tx.create('modelReservations', reservationKey, { ...frozen, ownerId, state: 'RESERVED_NO_AUTOMATIC_REFUND', observedAt: admittedAt,
        ...(shared ? { requestDigest } : {}) });
      if (shared) tx.set('modelReleaseSpend', ceiling.key, { maxCostMicros: ceiling.maxCostMicros, reservedCostMicros: String(releaseTotal) });
      tx.set('modelGrants', grantKey, { authorizationId: grant.authorizationId, ownerId, jobId, authorization: grant,
        calls, reservedTokens, reservedCostMicros });
      return true; // ONLY a new durable debit, never an idempotent acknowledgment.
    });
  } });
}
// Never race-and-abandon adapters: abort admission of new effects, then drain
// every started step (including signer work raced internally by the executor).
// Qualified adapters must settle on abort; JavaScript cannot kill a promise.
async function bounded(ms, callback) {
  const controller = new AbortController(), until = performance.now() + ms, pending = new Set();
  const expire = () => controller.abort(new JourneyError('EXECUTION_DEADLINE', 503));
  const timer = setTimeout(expire, ms);
  const check = () => { if (performance.now() >= until) expire(); if (controller.signal.aborted) throw controller.signal.reason; };
  const scope = { signal: controller.signal, check,
    remaining() { check(); return Math.max(1, Math.floor(until - performance.now())); },
    async step(fn) {
      check(); const p = Promise.resolve().then(() => { check(); return fn(); });
      pending.add(p);
      try { const value = await p; check(); return value; }
      catch (error) { check(); throw error; }
      finally { pending.delete(p); }
    } };
  try { const value = await callback(scope); check(); return value; }
  finally {
    // Close retained capabilities on every outcome before draining started work.
    // Abort is cleanup only: do not re-check or replace the callback's result/error.
    controller.abort();
    await Promise.allSettled([...pending]); clearTimeout(timer);
  }
}
function publicOperation(row) {
  return { operationId: row.operationId, action: row.action, status: row.status, request: row.request ?? null,
    preparation: row.preparation && canonicalAttempt(row.preparation.attemptId) &&
      ['PREPARING', 'UNISSUED_FAILED', 'ISSUED'].includes(row.preparation.state) ?
      { attemptId: row.preparation.attemptId, state: row.preparation.state } : null,
    transactionHash: row.transactionHash ?? null, signerId: row.ownerId, receipt: row.receipt ?? null };
}
