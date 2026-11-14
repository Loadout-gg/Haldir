import { approvedInput, approvedSources, jobSourceRefs, paymentOperationId as operationId, quoteKey } from '../shared/job-contract.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { JsonRpcProvider, PublicKey, createTransaction, actions, baseDecode, baseEncode, SignedTransaction } from 'near-api-js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const requireValue = (v, code) => { if (!v) fail(code); };
const account = v => typeof v === 'string' && v.length >= 2 && v.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v);
const positive = v => typeof v === 'string' && /^[1-9][0-9]{0,38}$/.test(v) && BigInt(v) < 2n ** 128n;
const validHash = v => { try { return typeof v === 'string' && baseDecode(v).length === 32 && baseEncode(baseDecode(v)) === v; } catch { return false; } };
const unknown = op => ({ status: 'unknown', ...(op?.transactionHash ? { reference: op.transactionHash } : {}) });

// Pin public execution to actual testnet, with bounded, no-redirect transport.
// The SDK supplies transaction/signing and RPC method/parameter serialization.
class ExecutionProvider extends JsonRpcProvider {
  constructor(url, timeoutMs, signal, guard) { super({ url }, { retries: 1 }); this.timeoutMs = timeoutMs; this.signal=signal; this.guard=guard; this.sequence = 0; }
  async sendJsonRpc(method, params) {
    requireValue(['status', 'query', 'block', 'send_tx', 'EXPERIMENTAL_tx_status'].includes(method), 'RPC_METHOD_DENIED');
    this.guard();
    const id = String(++this.sequence);
    const r = await fetch(this.connection.url, { method: 'POST', redirect: 'error', signal: this.signal ? AbortSignal.any([this.signal,AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    requireValue(r.ok, 'RPC_HTTP_UNAVAILABLE');
    const p = await r.json();
    requireValue(p?.jsonrpc === '2.0' && p.id === id && !Object.hasOwn(p, 'error') && Object.hasOwn(p, 'result'), 'RPC_UNAVAILABLE');
    return p.result;
  }
}

/**
 * Native PaymentExecutionPort for the UNCHANGED run-job.mjs ABI:
 * submit/lookup({operationId, approvedJobInput, quote}). No model/owner key port.
 * `binding` and `signer` are trusted server configuration, never request fields.
 * The signer must hold only the configured restricted agent pay key.
 * Reuses orders' repository; nativeOperations is a submission journal, NOT an
 * order/proof/money ledger. It never writes orders, claims, deliveries or runs.
 *
 * Crash policy is deliberately one-way. Reserve before key/signing I/O; persist
 * exact signed Borsh bytes and hash before sending once. Any existing operation,
 * even RESERVED without bytes, is lookup-only. No timeout, restart, nonce error
 * or missing proof authorizes replacement/re-sign/rebroadcast. A crash before
 * sending may strand an operation: operator reconciliation, not automatic pay.
 * Repository must durably serialize conflicting create/set, with reads before
 * writes (the incumbent SQLite local port works; hosted persistence is separate).
 * Public mode requires HTTPS allowlist and actual status.chain_id === testnet.
 * Explicit localTestOnly permits a loopback injected provider and actual local
 * chain identity; it does not relabel Sandbox as testnet or alter its collector.
 */
export function createNearMandateExecution({ repository, binding: configured, signer, rpcUrl, allowedRpcUrls,
  provider: injected, localTestOnly = false, timeoutMs = 10_000, now = Date.now, signal, executionGuard = () => {} } = {}) {
  const binding = structuredClone(configured);
  let url; try { url = new URL(rpcUrl); } catch { /* reject below */ }
  requireValue(typeof repository?.runTransaction === 'function' && typeof signer?.getPublicKey === 'function' &&
    typeof signer?.signTransaction === 'function' && typeof now === 'function' && typeof executionGuard === 'function' &&
    (signal === undefined || signal instanceof AbortSignal), 'INVALID_EXECUTION_PORTS');
  requireValue(typeof localTestOnly === 'boolean' && url && !url.username && !url.password && !url.search && !url.hash &&
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000 &&
    (localTestOnly === true ? injected && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) :
      !injected && url.protocol === 'https:' && Array.isArray(allowedRpcUrls) && allowedRpcUrls.includes(rpcUrl)), 'RPC_CONFIGURATION_INVALID');
  requireValue(binding && account(binding.ownerId) && account(binding.signerId) && account(binding.mandateId) &&
    binding.ownerId !== binding.signerId && binding.signerId !== binding.mandateId &&
    typeof binding.networkId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(binding.networkId) &&
    (localTestOnly === true || binding.networkId === 'testnet') && positive(binding.maxAllowanceAtomic) && validHash(binding.codeHash), 'BINDING_INVALID');
  requireValue(PublicKey.fromString(binding.publicKey).toString() === binding.publicKey, 'KEY_BINDING_INVALID');
  const globalFence = () => { executionGuard(); requireValue(!signal?.aborted,'EXECUTION_TIMEOUT'); };
  const provider = injected ?? new ExecutionProvider(rpcUrl, timeoutMs, signal, globalFence);
  async function admitted(tx, request, purchase = false) {
    const a = request?.approvedJobInput, q = request?.quote;
    requireValue(request && equal(Object.keys(request).sort(), ['approvedJobInput', 'operationId', 'quote']) &&
      a && typeof a.jobId === 'string', 'APPROVAL_MISMATCH');
    const job = await tx.get('jobs', a.jobId);
    let refs; try { refs = jobSourceRefs(job); } catch { fail('APPROVAL_MISMATCH'); }
    requireValue(refs.some(s => s.quoteId === a.quoteId), 'APPROVAL_MISMATCH');
    if (job.publicManifest) {
      let sources; try { sources = approvedSources(job.publicManifest.approved); } catch { fail('APPROVAL_MISMATCH'); }
      requireValue(equal(job.publicManifest.binding,binding) && equal(refs,sources.map(({sourceId,quoteId})=>({sourceId,quoteId}))) && equal(job.scope,job.publicManifest.approved.job) && equal(q,sources.find(s=>s.quoteId===a.quoteId)?.quote), 'APPROVAL_MISMATCH');
    }
    const order = job && await tx.get('orders', a.quoteId);
    const quote = job && await tx.get('quotes', a.quoteId);
    requireValue(job && order && quote?.jobId === job.jobId && quote.ownerId === job.ownerId &&
      equal(a, approvedInput(job,a.quoteId)) && equal(q, order.quote) && equal(q, quote.quote) &&
      order.jobId === job.jobId && order.quoteId === a.quoteId && quoteKey(q) === a.quoteId && request.operationId === operationId(a.quoteId) && a.ownerId === binding.ownerId &&
      a.networkId === binding.networkId && q.networkId === binding.networkId &&
      a.mandateId === binding.mandateId && q.mandateId === binding.mandateId &&
      positive(a.budgetAtomic) && positive(q.amountAtomic) && BigInt(q.amountAtomic) <= BigInt(a.budgetAtomic) &&
      Array.isArray(a.vendorIds) && a.vendorIds.includes(q.vendorId) && account(q.vendorId) &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(q.orderId), 'APPROVAL_MISMATCH');
    if (purchase) {
      globalFence();
      requireValue(job.state === 'LOCAL_ACTIVE', 'OWNER_STOPPED');
      const clock = now();
      requireValue(Number.isFinite(clock) && Date.parse(a.expiresAt) > clock, 'DEADLINE_EXPIRED');
      requireValue(!order.proof, 'ALREADY_PAID');
    }
    return { job, order };
  }
  async function current(request, purchase = false) {
    return repository.runTransaction(async tx => {
      const { job } = await admitted(tx, request, purchase);
      const op = await tx.get('nativeOperations', request.approvedJobInput.quoteId);
      if (op) requireValue(equal(op.request, request) && equal(op.binding, binding), 'OPERATION_CONFLICT');
      return op;
    });
  }
  async function lookup(request) {
    request = structuredClone(request);
    const op = await current(request);
    if (!op?.transactionHash) return unknown(op);
    let timer;
    const until = performance.now() + timeoutMs;
    const expiry = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LOOKUP_TIMEOUT')), timeoutMs); });
    expiry.catch(() => {});
    const read = async fn => {
      globalFence(); requireValue(performance.now() < until, 'LOOKUP_TIMEOUT');
      const result = await Promise.race([Promise.resolve().then(fn), expiry]);
      globalFence(); requireValue(performance.now() < until, 'LOOKUP_TIMEOUT'); return result;
    };
    try {
      const status = await read(() => provider.viewNodeStatus());
      requireValue(status?.chain_id === binding.networkId && status.sync_info?.syncing !== true, 'CHAIN_MISMATCH');
      const tx = await read(() => provider.viewTransactionStatusWithReceipts({ txHash: op.transactionHash, accountId: op.signerId, waitUntil: 'FINAL' }));
      if (tx?.transaction?.hash === op.transactionHash && tx.transaction.signer_id === op.signerId)
        return { status: 'submitted', reference: op.transactionHash }; // acknowledgment, NEVER payment proof
    } catch { /* unavailable or failed is still uncertainty, not replacement permission */ }
    finally { clearTimeout(timer); }
    return unknown(op);
  }
  async function submit(request) {
    request = structuredClone(request);
    globalFence();
    const reserved = await repository.runTransaction(async tx => {
      const { job } = await admitted(tx, request);
      const prior = await tx.get('nativeOperations', request.approvedJobInput.quoteId);
      if (prior) {
        requireValue(equal(prior.request, request) && equal(prior.binding, binding), 'OPERATION_CONFLICT');
        return { op: prior, created: false };
      }
      // Repeat the purchase fence without re-reading after queued writes.
      globalFence();
      requireValue(job.state === 'LOCAL_ACTIVE', 'OWNER_STOPPED');
      requireValue(Number.isFinite(now()) && Date.parse(job.scope.expiresAt) > now(), 'DEADLINE_EXPIRED');
      const order = await tx.get('orders', request.approvedJobInput.quoteId);
      requireValue(!order.proof, 'ALREADY_PAID');
      const op = { operationId: request.operationId, ownerId: job.ownerId, jobId: job.jobId,
        networkId: binding.networkId, signerId: binding.signerId, quote: request.quote, request, binding, phase: 'RESERVED' };
      tx.create('nativeOperations', request.approvedJobInput.quoteId, op);
      return { op, created: true };
    });
    if (!reserved.created) return lookup(request);
    let op = reserved.op;
    const until = performance.now() + timeoutMs;
    const fence = () => { globalFence(); requireValue(performance.now() < until, 'EXECUTION_TIMEOUT'); };
    let timer;
    const expiry = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('EXECUTION_TIMEOUT'), { code: 'EXECUTION_TIMEOUT' })), timeoutMs); });
    expiry.catch(() => {});
    const read = async fn => { fence(); const result = await Promise.race([Promise.resolve().then(fn), expiry]); fence(); return result; };
    try {
      const status = await read(() => provider.viewNodeStatus());
      requireValue(status?.chain_id === binding.networkId && status.sync_info?.syncing !== true, 'CHAIN_MISMATCH');
      const pk = await read(() => signer.getPublicKey());
      requireValue(pk.toString() === binding.publicKey, 'KEY_BINDING_INVALID');
      const keys = await read(() => provider.viewAccessKeyList({ accountId: binding.signerId, finalityQuery: { finality: 'final' } }));
      const key = keys?.keys?.[0], p = key?.access_key?.permission?.FunctionCall;
      requireValue(keys?.keys?.length === 1 && keys.last_key == null && validHash(keys.block_hash) && Number.isSafeInteger(keys.block_height) &&
        key.public_key === binding.publicKey && p && equal(Object.keys(key.access_key.permission), ['FunctionCall']) &&
        equal(Object.keys(p).sort(), ['allowance', 'method_names', 'receiver_id']) && p.receiver_id === binding.mandateId &&
        equal(p.method_names, ['pay']) && positive(p.allowance) && BigInt(p.allowance) <= BigInt(binding.maxAllowanceAtomic), 'KEY_PERMISSION');
      const childKeys = await read(() => provider.query({ request_type: 'view_access_key_list', account_id: binding.mandateId, finality: 'final' }));
      requireValue(childKeys?.keys?.length === 0 && childKeys.last_key == null && validHash(childKeys.block_hash), 'MANDATE_NOT_KEYLESS');
      const code = await read(() => provider.query({ request_type: 'view_account', account_id: binding.mandateId, finality: 'final' }));
      requireValue(code.code_hash === binding.codeHash, 'MANDATE_CODE_MISMATCH');
      const state = await read(() => provider.callFunction({ contractId: binding.mandateId, method: 'get_status', args: {}, blockQuery: { finality: 'final' } }));
      const a = request.approvedJobInput, q = request.quote;
      requireValue(state.owner === binding.ownerId && state.agent === binding.signerId && state.cap === a.budgetAtomic &&
        equal(state.allowlist, a.vendorIds) && state.deadline_ns === String(BigInt(Date.parse(a.expiresAt)) * 1_000_000n), 'MANDATE_SCOPE_MISMATCH');
      requireValue(state.stopped === false && state.expired === false, 'MANDATE_CLOSED');
      requireValue(state.in_flight === null && positive(state.free) && BigInt(state.free) >= BigInt(q.amountAtomic) &&
        Array.isArray(state.orders) && !state.orders.some(o => o.order_id === q.orderId), 'MANDATE_UNAVAILABLE');
      const block = await read(() => provider.viewBlock({ finality: 'final' }));
      requireValue(validHash(block?.header?.hash) && BigInt(block.header.timestamp_nanosec) < BigInt(state.deadline_ns), 'DEADLINE_EXPIRED');
      const rawNonce = key.access_key.nonce;
      requireValue(typeof rawNonce === 'number' ? Number.isSafeInteger(rawNonce) && rawNonce >= 0 :
        typeof rawNonce === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(rawNonce), 'NONCE_INVALID');
      const nonce = BigInt(rawNonce) + 1n;
      requireValue(nonce > 0n && nonce < 2n ** 64n, 'NONCE_INVALID');
      await current(request, true); fence();
      const transaction = createTransaction(binding.signerId, pk, binding.mandateId, nonce,
        [actions.functionCall('pay', { order_id: q.orderId, recipient: q.vendorId, amount: q.amountAtomic }, 100_000_000_000_000n, 0n)], baseDecode(block.header.hash));
      const signed = await read(() => signer.signTransaction(transaction));
      const transactionHash = baseEncode(createHash('sha256').update(transaction.encode()).digest());
      requireValue(baseEncode(signed.txHash) === transactionHash && equal(signed.signedTransaction.transaction.encode(), transaction.encode()) &&
        pk.verify(baseDecode(transactionHash), signed.signedTransaction.signature.data), 'SIGNATURE_INVALID');
      const bytes = Buffer.from(signed.signedTransaction.encode()).toString('base64');
      fence();
      op = await repository.runTransaction(async tx => {
        const { job } = await admitted(tx, request, true);
        const stored = await tx.get('nativeOperations', request.approvedJobInput.quoteId);
        requireValue(equal(stored, reserved.op), 'OPERATION_CONFLICT');
        fence();
        const next = { ...stored, signedTransaction: bytes, transactionHash, phase: 'BROADCAST_INTENT' };
        tx.set('nativeOperations', request.approvedJobInput.quoteId, next); return next;
      });
      fence();
      // No automatic SDK nonce/block refresh/retry. Exactly these durable bytes.
      await read(() => provider.sendTransactionUntil(SignedTransaction.decode(Buffer.from(bytes, 'base64')), 'FINAL'));
      return { status: 'submitted', reference: transactionHash };
    } catch (error) {
      // Validation failures stay durable RESERVED (no bytes, no broadcast). Errors
      // remain explicit for trusted callers; the runner treats them as unknown.
      if (!op.transactionHash && error.code && error.code !== 'EXECUTION_TIMEOUT') throw error;
      return unknown(op);
    } finally { clearTimeout(timer); }
  }
  async function loadOperation({ ownerId, jobId, quote }) {
    return repository.runTransaction(async tx => {
      const job = await tx.get('jobs', jobId);
      if (!job || job.ownerId !== ownerId) return null;
      let refs; try { refs = jobSourceRefs(job); } catch { return null; }
      const matches=[];
      for (const ref of refs) {
        const stored=await tx.get('quotes',ref.quoteId);
        if (stored?.jobId===jobId && stored.ownerId===ownerId && equal(stored.quote,quote)) matches.push(ref);
      }
      if (matches.length!==1) return null;
      const op = await tx.get('nativeOperations', matches[0].quoteId);
      if (!op?.transactionHash || !equal(op.quote, quote) || op.ownerId !== ownerId || op.jobId !== jobId || !equal(op.binding, binding)) return null;
      try { await admitted(tx,op.request); } catch { return null; }
      return structuredClone(op);
    });
  }
  return Object.freeze({ submit, lookup, loadOperation });
}
