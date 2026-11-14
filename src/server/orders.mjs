import { approvedSources, jobSourceRefs, quoteKey, approvedInput } from '../shared/job-contract.mjs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PublicKey, baseDecode, baseEncode } from 'near-api-js';
import { verifyPaymentProof } from '../vendor/payment-proof.mjs';
import { fictionalArtifact } from '../vendor/fixture.mjs';
import { prepareCreateJob } from '../../qualification/native-wallet/request.mjs';

/**
 * LOCAL TEST ONLY; never a Cloud Run persistence adapter.
 * Repository port: runTransaction(async tx => result), tx.get(collection, key)
 * -> JSON|null, tx.create/tx.set(collection, key, JSON). All reads before writes.
 * A future Firestore adapter must atomically enforce exact-key create, serialize
 * conflicting reads/writes, retry at most five times, and may rerun callbacks.
 * Callbacks MUST be deterministic/effect-free; no network, random IDs or clocks.
 */
export function openLocalRepository({ filename, localTestOnly } = {}) {
  if (localTestOnly !== true) throw new Error('LOCAL TEST ONLY opt-in required');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  db.exec('CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,key))');
  const read = db.prepare('SELECT value FROM records WHERE collection=? AND key=?');
  const insert = db.prepare('INSERT INTO records(collection,key,value) VALUES (?,?,?)');
  const upsert = db.prepare('INSERT INTO records(collection,key,value) VALUES (?,?,?) ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value');
  let tail = Promise.resolve(), active = false;
  const validateKey = (collection, key) => {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(collection) || typeof key !== 'string' || !key.length || key.length > 2048)
      throw new Error('invalid repository key');
  };
  async function transact(callback) {
    for (let attempt = 0; ; attempt++) {
      try { db.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if (error.errcode !== 5 || attempt >= 4) throw error;
        await delay(5 * (attempt + 1));
      }
    }
    active = true;
    const writes = [];
    const write = (create, collection, key, value) => {
      validateKey(collection, key);
      const json = JSON.stringify(value);
      if (typeof json !== 'string' || Buffer.byteLength(json) > 512 * 1024) throw new Error('document too large or not JSON');
      writes.push({ create, collection, key, json });
    };
    try {
      const result = await callback({
        get: async (collection, key) => {
          validateKey(collection, key);
          if (writes.length) throw new Error('reads must precede writes');
          const row = read.get(collection, key);
          return row ? JSON.parse(row.value) : null;
        },
        create: (collection, key, value) => write(true, collection, key, value),
        set: (collection, key, value) => write(false, collection, key, value),
      });
      for (const w of writes) {
        if (w.create && read.get(w.collection, w.key)) throw new Error('record already exists');
        (w.create ? insert : upsert).run(w.collection, w.key, w.json);
      }
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { active = false; }
  }
  return {
    runTransaction(callback) {
      const result = tail.then(() => transact(callback));
      tail = result.catch(() => {});
      return result;
    },
    close() {
      if (active) throw new Error('cannot close during transaction');
      db.close();
    },
  };
}

export class JourneyError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
const requireValue = (condition, code, status) => { if (!condition) throw new JourneyError(code, status); };
const token = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s);
const account = s => typeof s === 'string' && s.length >= 2 && s.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(s);
const amount = s => typeof s === 'string' && /^[1-9][0-9]{0,38}$/.test(s) && BigInt(s) < 2n ** 128n;
const text = s => typeof s === 'string' && s.length > 0 && s.length <= 2048;
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) &&
  isDeepStrictEqual(Object.keys(o).sort(), keys.split(' ').sort());
const manifestTerms = m => { const { chainEvidence, ...terms } = m ?? {}; return terms; };
// Reversible, collision-free canonical tuple encoding; no slash/path normalization.
const key = (...tuple) => Buffer.from(JSON.stringify(['haldir-local-v1', ...tuple])).toString('base64url');
function validateApproval(a, networkId, creationDeadline = false) {
  if (a?.schemaVersion === 'haldir.approved.two-source.v1') {
    try { approvedSources(a); } catch { throw new JourneyError('INVALID_APPROVAL', 400); }
    requireValue(a.job.networkId === networkId && (creationDeadline || !a.job.expiresAt.includes('.')), 'INVALID_APPROVAL', 400);
    return;
  }
  const j = a?.job, q = a?.quote;
  requireValue(exact(a, 'job quote') && exact(j, 'networkId mandateId purpose output budgetAtomic vendorIds expiresAt') &&
    exact(q, 'networkId mandateId vendorId amountAtomic orderId content') &&
    j.networkId === networkId && account(j.mandateId) && text(j.purpose) && text(j.output) && amount(j.budgetAtomic) &&
    Array.isArray(j.vendorIds) && j.vendorIds.length >= 1 && j.vendorIds.length <= 4 &&
    j.vendorIds.every(account) && new Set(j.vendorIds).size === j.vendorIds.length &&
    // Pinned provisioning uses millisecond-aligned U64 nanoseconds. Permit its
    // literal canonical ISO form only in the explicit creation extension; never
    // round approved deadlines or widen legacy/local admission date guards.
    typeof j.expiresAt === 'string' && (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(j.expiresAt) ||
      (creationDeadline && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(j.expiresAt))) &&
    Number.isFinite(Date.parse(j.expiresAt)) && new Date(j.expiresAt).toISOString() ===
      (j.expiresAt.includes('.') ? j.expiresAt : j.expiresAt.replace('Z', '.000Z')) &&
    q.networkId === j.networkId && q.mandateId === j.mandateId && j.vendorIds.includes(q.vendorId) &&
    amount(q.amountAtomic) && BigInt(q.amountAtomic) <= BigInt(j.budgetAtomic) && token(q.orderId) && text(q.content),
  'INVALID_APPROVAL', 400);
}

/**
 * Bounded LOCAL qualification service: one approved job/quote/order per admission.
 * `approved` must originate from a trusted review/approval store, NOT the browser
 * or a candidate's own manifest. No wallet auth, funding/stop chain assertion,
 * signer, broadcaster, model runner or payment-submission port is implemented.
 * Defaults strictly to testnet. `trustedLocalChain` is constructor-only Sandbox
 * qualification config, NEVER browser/model/approval input or an RPC allowlist.
 * Pin one actual test-chain-* identity and literal loopback RPC; independently
 * verify its status on every admission (including replay), outside transactions.
 * This does not enable mainnet or alter the public testnet receipt collector.
 */
export function createOrders({ repository, localTestOnly, now = Date.now,
  trustedReceiptCollector = async () => null, trustedLocalChain } = {}) {
  requireValue(localTestOnly === true, 'LOCAL_TEST_ONLY', 503);
  return ordersCore({ repository, now, trustedReceiptCollector, trustedLocalChain });
}

// Shared incumbent storage/claim/delivery engine; not an admission authority.
// Only the guarded local factory or trusted public factory below can reach it.
function ordersCore({ repository, now, trustedReceiptCollector = async () => null,
  trustedLocalChain, publicAdmission = false }) {
  const localChain = trustedLocalChain === undefined ? null : structuredClone(trustedLocalChain);
  if (localChain !== null || trustedLocalChain !== undefined) {
    let url; try { url = new URL(localChain?.rpcUrl); } catch { /* fail closed below */ }
    requireValue(exact(localChain, 'networkId rpcUrl') && token(localChain.networkId) &&
      /^test-chain-[a-zA-Z0-9_-]+$/.test(localChain.networkId) && url &&
      /^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/?$/.test(localChain.rpcUrl),
    'LOCAL_CHAIN_CONFIGURATION_INVALID', 503);
  }
  const networkId = localChain?.networkId ?? 'testnet';
  async function owned(tx, ownerId, jobId) {
    requireValue(account(ownerId), 'UNAUTHENTICATED', 401);
    requireValue(token(jobId), 'NOT_FOUND', 404);
    const job = await tx.get('jobs', jobId);
    requireValue(job?.ownerId === ownerId, 'NOT_FOUND', 404);
    return job;
  }
  function validateMember(job, quoteId, effect = false) {
    let refs; try { refs = jobSourceRefs(job); } catch { throw new JourneyError('QUOTE_CHANGED'); }
    requireValue(!effect || refs.length === 1 || quoteId !== undefined, 'QUOTE_REQUIRED');
    const selected = quoteId ?? job.quoteId;
    requireValue(refs.some(s => s.quoteId === selected), 'NOT_FOUND', 404);
    return selected;
  }
  async function selectOrder({ownerId,jobId,quoteId}, effect = false, snapshot = false) {
    return repository.runTransaction(async tx => {
      const job = await owned(tx,ownerId,jobId), selected = validateMember(job,quoteId,effect);
      const order = await tx.get('orders',selected), quote = await tx.get('quotes',selected);
      requireValue(order?.jobId === jobId && order.quoteId === selected && quote?.jobId === jobId && quote.ownerId === ownerId &&
        quoteKey(order.quote) === selected && isDeepStrictEqual(order.quote,quote.quote), 'QUOTE_CHANGED');
      if (job.publicManifest) {
        let sources; try { sources = approvedSources(job.publicManifest.approved); } catch { throw new JourneyError('QUOTE_CHANGED'); }
        requireValue(isDeepStrictEqual(job.scope,job.publicManifest.approved.job) && isDeepStrictEqual(jobSourceRefs(job),sources.map(({sourceId,quoteId})=>({sourceId,quoteId}))) &&
          isDeepStrictEqual(sources.find(s=>s.quoteId===selected)?.quote,order.quote), 'QUOTE_CHANGED');
      }
      return snapshot ? {job,order} : order;
    });
  }
  function effectBinding(job, initial, quoteId) {
    validateMember(job,quoteId);
    requireValue(isDeepStrictEqual(approvedInput(job,quoteId),approvedInput(initial,quoteId)) &&
      isDeepStrictEqual(job.publicManifest,initial.publicManifest), 'QUOTE_CHANGED');
  }
  return {
    async createJob({ ownerId, admissionKey, approved, publicManifest, signal }) {
      requireValue(account(ownerId), 'UNAUTHENTICATED', 401);
      requireValue(token(admissionKey), 'INVALID_ADMISSION_KEY', 400);
      const frozen = structuredClone(approved);
      const manifest = publicAdmission ? structuredClone(publicManifest) : null;
      validateApproval(frozen, networkId, publicAdmission && Object.hasOwn(manifest, 'creation'));
      if (localChain) {
        let payload;
        try {
          const response = await fetch(localChain.rpcUrl, { method: 'POST', redirect: 'error',
            signal: AbortSignal.timeout(10_000), headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'haldir-local-admission', method: 'status', params: [] }) });
          requireValue(response.ok, 'LOCAL_CHAIN_UNAVAILABLE', 503);
          payload = await response.json();
        } catch { throw new JourneyError('LOCAL_CHAIN_UNAVAILABLE', 503); }
        requireValue(payload?.jsonrpc === '2.0' && payload.id === 'haldir-local-admission' &&
          !Object.hasOwn(payload, 'error') && payload.result?.chain_id === networkId &&
          payload.result.sync_info?.syncing === false, 'LOCAL_CHAIN_MISMATCH', 503);
      }
      const observedAt = now();
      const admissionId = key(ownerId, admissionKey);
      const sources = approvedSources(frozen), quoteId = sources[0].quoteId;
      const jobId = randomUUID(); // outside a retriable callback
      return repository.runTransaction(async tx => {
        const existing = await tx.get('admissions', admissionId);
        if (existing) {
          requireValue(existing.ownerId === ownerId && existing.admissionKey === admissionKey &&
            isDeepStrictEqual(existing.approved, frozen) && (!publicAdmission ||
              isDeepStrictEqual(manifestTerms(existing.publicManifest), manifestTerms(manifest))), 'IDEMPOTENCY_CONFLICT');
          return owned(tx, ownerId, existing.jobId);
        }
        const quotes = [];
        for (const source of sources) quotes.push(await tx.get('quotes', source.quoteId));
        const mandateId = key(frozen.job.networkId, frozen.job.mandateId);
        const mandate = await tx.get('mandates', mandateId);
        requireValue(quotes.every(q => !q), 'ORDER_ALREADY_BOUND');
        requireValue(!mandate, 'MANDATE_ALREADY_BOUND');
        requireValue(Date.parse(frozen.job.expiresAt) > observedAt, 'INVALID_APPROVAL', 400);
        if (publicAdmission) requireValue(!signal?.aborted, 'EXECUTION_DEADLINE', 503);
        const job = { jobId, ownerId, scope: frozen.job, quoteId, state: 'LOCAL_ACTIVE',
          qualification: publicAdmission ? 'PUBLIC_TESTNET_FICTIONAL_VENDOR' : 'LOCAL_SYNTHETIC_ONLY',
          ...(publicAdmission ? { publicManifest: manifest } : {}),
          ...(sources.length === 2 ? { schemaVersion: 'haldir.job.two-source.v1', sourceRefs: sources.map(({sourceId,quoteId}) => ({sourceId,quoteId})) } : {}) };
        tx.create('admissions', admissionId, { ownerId, admissionKey, approved: frozen, jobId,
          ...(publicAdmission ? { publicManifest: manifest } : {}) });
        tx.create('mandates', mandateId, { networkId: frozen.job.networkId, mandateId: frozen.job.mandateId, ownerId, jobId });
        tx.create('jobs', jobId, job);
        for (const {quoteId,quote} of sources) {
          tx.create('quotes', quoteId, { jobId, ownerId, quote });
          tx.create('orders', quoteId, { jobId, quoteId, orderId: quote.orderId, quote,
            lifecycle: 'PAYMENT_PENDING', proof: null, artifact: null, lastCheckCode: null });
        }
        return job;
      });
    },
    async checkPayment({ ownerId, jobId, quoteId }) {
      const selected = await selectOrder({ownerId, jobId, quoteId}, true, true), current=selected.order;
      quoteId = current.quoteId;
      if (current.proof) return current;
      // Trusted injection is the ONLY evidence source. No client paid/proof input.
      // Awaited outside transactions. The local fixture performs no network I/O.
      let evidence, proof, lastCheckCode;
      try { evidence = await trustedReceiptCollector({ ownerId, jobId, quote: structuredClone(current.quote) }); }
      catch { lastCheckCode = 'COLLECTOR_UNAVAILABLE'; }
      if (!lastCheckCode) {
        if (!evidence) lastCheckCode = 'EVIDENCE_UNAVAILABLE';
        else {
          try { proof = verifyPaymentProof(current.quote, evidence); }
          catch (error) { lastCheckCode = /^[A-Z_]{1,64}$/.test(error.code ?? '') ? error.code : 'INVALID_EVIDENCE'; }
        }
      }
      if (lastCheckCode) {
        // Absence/rejection is NOT verified nonpayment. Keep original reservation
        // identity pending. Never let a late failed check downgrade a paid order.
        return repository.runTransaction(async tx => {
          const job = await owned(tx, ownerId, jobId);
          effectBinding(job, selected.job, quoteId);
          const latest = await tx.get('orders', quoteId);
          requireValue(latest?.jobId === jobId && latest.quoteId === quoteId && isDeepStrictEqual(latest.quote,current.quote), 'QUOTE_CHANGED');
          if (latest.proof) return latest;
          const pending = { ...latest, lastCheckCode };
          tx.set('orders', quoteId, pending);
          return pending;
        });
      }
      return repository.runTransaction(async tx => {
        const job = await owned(tx, ownerId, jobId);
          effectBinding(job, selected.job, quoteId);
        const order = await tx.get('orders', quoteId);
        const quote = await tx.get('quotes', quoteId);
        const claim = await tx.get('claims', proof.proofId);
        const delivery = await tx.get('deliveries', quoteId);
        requireValue(quote?.jobId === jobId && quote.ownerId === ownerId &&
          isDeepStrictEqual(quote.quote, current.quote) && isDeepStrictEqual(order.quote, current.quote), 'QUOTE_CHANGED');
        requireValue(!claim || (claim.jobId === jobId && claim.quoteId === quoteId &&
          isDeepStrictEqual(claim.proof, proof)), 'PROOF_ALREADY_CLAIMED');
        if (order.proof) {
          requireValue(isDeepStrictEqual(order.proof, proof), 'PAYMENT_IDENTITY_CONFLICT');
          return order;
        }
        requireValue(!delivery, 'DELIVERY_IDENTITY_CONFLICT');
        const next = { ...order, proof, lifecycle: 'PAID_NOT_DELIVERED', lastCheckCode: null };
        if (!claim) tx.create('claims', proof.proofId, { jobId, quoteId: quoteId, proof });
        tx.create('deliveries', quoteId, { jobId, quoteId: quoteId,
          artifactId: `fictional:${quoteId}`, artifact: null });
        tx.set('orders', quoteId, next);
        return next;
      });
    },
    async retrieveDelivery({ ownerId, jobId, quoteId }) {
      const selected = await selectOrder({ownerId,jobId,quoteId}, true, true);
      quoteId = selected.order.quoteId;
      return repository.runTransaction(async tx => {
        const job = await owned(tx, ownerId, jobId);
          effectBinding(job, selected.job, quoteId);
        const order = await tx.get('orders', quoteId);
        requireValue(order?.proof, 'PAYMENT_NOT_VERIFIED');
        const claim = await tx.get('claims', order.proof.proofId);
        const delivery = await tx.get('deliveries', quoteId);
        requireValue(claim?.jobId === jobId && claim.quoteId === quoteId &&
          isDeepStrictEqual(claim.proof, order.proof) && delivery?.jobId === jobId &&
          delivery.quoteId === quoteId, 'PAYMENT_NOT_VERIFIED');
        if (order.artifact) return order;
        // No external effect: deterministic fictional content, safe if a future
        // Firestore transaction retries this callback. Stop/expiry do not revoke
        // retrieval of an already paid order, and cannot authorize repayment.
        const artifact = fictionalArtifact({ quoteId: quoteId, quote: order.quote });
        requireValue(artifact.artifactId === delivery.artifactId, 'DELIVERY_IDENTITY_CONFLICT');
        const next = { ...order, artifact, lifecycle: 'DELIVERED' };
        tx.set('deliveries', quoteId, { ...delivery, artifact });
        tx.set('orders', quoteId, next);
        return next;
      });
    },
    // Test fixture disposition only. This does NOT verify/submit an owner stop.
    stopLocalJob({ ownerId, jobId }) {
      return repository.runTransaction(async tx => {
        const job = await owned(tx, ownerId, jobId);
        const stopped = { ...job, state: 'LOCAL_STOPPED' };
        tx.set('jobs', jobId, stopped);
        return stopped;
      });
    },
    getJob({ ownerId, jobId }) { return repository.runTransaction(tx => owned(tx, ownerId, jobId)); },
    getOrder(input) { return selectOrder(input); },
    async getOrders({ownerId,jobId}) {
      const job = await this.getJob({ownerId,jobId});
      return Promise.all(jobSourceRefs(job).map(async ({sourceId,quoteId}) => ({sourceId,order:await selectOrder({ownerId,jobId,quoteId})})));
    },
  };
}

/** Exact persisted public schema, shared with the trusted read-only manifest adapter. */
export function validatePublicManifest(manifest, ownerId, clock) {
  const b = manifest?.binding, e = manifest?.chainEvidence;
  let rpc, pk, hashesValid = false;
  try {
    rpc = new URL(manifest.rpcUrl);
    pk = PublicKey.fromString(b.publicKey);
    hashesValid = [b.codeHash, e.blockHash].every(h => typeof h === 'string' &&
      baseDecode(h).length === 32 && baseEncode(baseDecode(h)) === h);
  } catch { /* fail closed below */ }
  requireValue((exact(manifest, 'manifestId ownerId approved binding rpcUrl allowedRpcUrls chainEvidence') ||
      exact(manifest, 'manifestId ownerId approved binding rpcUrl allowedRpcUrls chainEvidence creation')) &&
    token(manifest.manifestId) && manifest.ownerId === ownerId &&
    manifest.approved?.job?.networkId === 'testnet' &&
    exact(b, 'networkId ownerId signerId mandateId publicKey maxAllowanceAtomic codeHash') &&
    b.networkId === 'testnet' && b.ownerId === ownerId && account(b.signerId) && account(b.mandateId) &&
    b.mandateId === manifest.approved.job.mandateId && b.signerId !== ownerId &&
    b.mandateId !== ownerId && b.mandateId !== b.signerId && amount(b.maxAllowanceAtomic) &&
    pk?.keyType === 0 && pk.toString() === b.publicKey && hashesValid &&
    rpc?.protocol === 'https:' && !rpc.username && !rpc.password && !rpc.search && !rpc.hash &&
    (manifest.rpcUrl === rpc.origin || manifest.rpcUrl === `${rpc.origin}/`) &&
    Array.isArray(manifest.allowedRpcUrls) && manifest.allowedRpcUrls.length >= 1 &&
    manifest.allowedRpcUrls.length <= 4 && manifest.allowedRpcUrls.includes(manifest.rpcUrl) &&
    manifest.allowedRpcUrls.every(value => { try { const u = new URL(value); return u.protocol === 'https:' &&
      !u.username && !u.password && !u.search && !u.hash && (u.pathname === '/'); } catch { return false; } }) &&
    (exact(e, 'networkId finality blockHash blockHeight observedAt') ||
      (exact(e, 'networkId finality blockHash blockHeight observedAt deployment') &&
        ['FACTORY_READY', 'MANDATE_READY'].includes(e.deployment))) &&
    (e.deployment !== 'FACTORY_READY' || Object.hasOwn(manifest, 'creation')) && e.networkId === 'testnet' && e.finality === 'final' &&
    Number.isSafeInteger(e.blockHeight) && e.blockHeight > 0 && Number.isSafeInteger(clock) &&
    Number.isSafeInteger(e.observedAt) && e.observedAt <= clock && clock - e.observedAt <= 30_000,
  'PUBLIC_MANIFEST_INVALID', 503);
  validateApproval(manifest.approved, 'testnet', Object.hasOwn(manifest, 'creation'));
  if (Object.hasOwn(manifest, 'creation')) {
    const c = manifest.creation;
    requireValue(exact(c, 'factory job_label operating_float create_gas factoryCodeHash'), 'PUBLIC_MANIFEST_INVALID', 503);
    try {
      requireValue(typeof c.factoryCodeHash === 'string' && baseDecode(c.factoryCodeHash).length === 32 &&
        baseEncode(baseDecode(c.factoryCodeHash)) === c.factoryCodeHash, 'PUBLIC_MANIFEST_INVALID', 503);
      prepareCreateJob({ network: 'testnet', owner: ownerId, agent: b.signerId, mandate: b.mandateId,
        allowlist: manifest.approved.job.vendorIds, cap: manifest.approved.job.budgetAtomic,
        deadline_ns: String(BigInt(Date.parse(manifest.approved.job.expiresAt)) * 1_000_000n), ...c });
    } catch { throw new JourneyError('PUBLIC_MANIFEST_INVALID', 503); }
  }
  return manifest;
}

/** Separate public authority; never localTestOnly=true online. ownerId MUST
 * originate from the host's verified wallet session, not a request field.
 * Legacy LOCAL_ACTIVE storage enum stays for incumbent runner compatibility;
 * qualification is public testnet with fictional vendor, not local proof.
 */
export function createPublicOrders({ repository, trustedManifestProvider,
  trustedReceiptCollector, now = Date.now } = {}) {
  requireValue(typeof repository?.runTransaction === 'function' &&
    typeof trustedManifestProvider === 'function' && typeof now === 'function', 'PUBLIC_CONFIGURATION_INVALID', 503);
  const core = ordersCore({ repository, now, trustedReceiptCollector, publicAdmission: true });
  const { createJob: admit, stopLocalJob: _localStop, ...readers } = core;
  return Object.freeze({ ...readers,
    async createJob({ ownerId, admissionKey, approvalId, signal } = {}) {
      requireValue(account(ownerId), 'UNAUTHENTICATED', 401);
      requireValue(token(admissionKey) && token(approvalId), 'INVALID_ADMISSION_KEY', 400);
      let manifest;
      try { manifest = structuredClone(await trustedManifestProvider({ ownerId, approvalId, signal })); }
      catch { throw new JourneyError('MANIFEST_UNAVAILABLE', 503); }
      validatePublicManifest(manifest, ownerId, now());
      requireValue(!signal?.aborted, 'EXECUTION_DEADLINE', 503);
      return admit({ ownerId, admissionKey, approved: manifest.approved, publicManifest: manifest, signal });
    },
  });
}
