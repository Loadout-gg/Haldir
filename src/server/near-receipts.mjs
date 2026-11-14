import { JsonRpcProvider, baseDecode } from 'near-api-js';
import { isDeepStrictEqual } from 'node:util';
import { verifyPaymentProof } from '../vendor/payment-proof.mjs';

const unresolved = code => ({ status: 'unresolved', code });
const token = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s);
const account = s => typeof s === 'string' && s.length >= 2 && s.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(s);
function hash(s) {
  try { return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && baseDecode(s).length === 32; }
  catch { return false; }
}

// Retain the installed first-party SDK's three read methods and parameter
// mapping, but narrow its transport: 7.4.0's default fetch follows redirects,
// omits AbortSignal and accepts several non-2xx bodies as results. No provider
// instance or generic RPC/broadcast surface is exposed to callers.
class ReceiptProvider extends JsonRpcProvider {
  constructor(url, signal) {
    super({ url }, { retries: 1 });
    this.signal = signal;
    this.sequence = 0;
  }
  async sendJsonRpc(method, params) {
    if (!['status', 'EXPERIMENTAL_tx_status', 'EXPERIMENTAL_receipt'].includes(method)) throw new Error('READ_ONLY_RPC');
    const id = String(++this.sequence);
    const response = await fetch(this.connection.url, { method: 'POST', redirect: 'error', signal: this.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (!response.ok) throw new Error('RPC_HTTP_UNAVAILABLE');
    const payload = await response.json();
    if (payload?.jsonrpc !== '2.0' || payload.id !== id || Object.hasOwn(payload, 'error') ||
        !Object.hasOwn(payload, 'result')) throw new Error('RPC_RESPONSE_UNAVAILABLE');
    return payload.result;
  }
}
function deadline(timeoutMs) {
  const until = performance.now() + timeoutMs;
  const timeout = Object.assign(new Error('COLLECTION_TIMEOUT'), { code: 'COLLECTION_TIMEOUT' });
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(timeout); reject(timeout); }, timeoutMs); });
  // Consume late rejection even for a test/loader that ignores AbortSignal.
  expired.catch(() => {});
  return {
    signal: controller.signal,
    async read(fn) {
      if (performance.now() >= until) throw timeout;
      const value = await Promise.race([Promise.resolve().then(fn), expired]);
      if (performance.now() >= until) throw timeout;
      return value;
    },
    close() { clearTimeout(timer); },
  };
}

/**
 * Read-only trusted-server boundary. Never expose collect() as a browser API.
 * `quote` is the independently approved snapshot; `operation` is an existing
 * durable record, not a purchaser's proposed tx identity:
 * { operationId, ownerId, jobId, networkId, transactionHash, signerId, quote }.
 * Exact equality includes quote content/extra approved fields. Caller/loader
 * establishes durable provenance; matching two attacker objects proves nothing.
 *
 * collect() -> {status:'accepted', evidence, proof} OR {status:'unresolved',code}.
 * No rejection proves nonpayment or authorizes a new payment. This module has
 * no signer, broadcaster, key, contract-state, payment-creation or write port.
 * The unchanged verifier checks the entire causal graph and actual payloads.
 * Durable proof claiming/delivery remain the responsibility of orders.mjs.
 *
 * trustedReceiptCollector matches the incumbent orders interface. Its optional
 * loadOperation({ownerId,jobId,quote}) MUST read the server's durable operation
 * store; request.operation is never used by this adapter. Missing/unavailable
 * identity/evidence -> null, preserving the incumbent pending reservation.
 * Config and allowlist are operator-owned, never derived from request URLs.
 */
export function createNearReceiptCollector({ rpcUrl, allowedRpcUrls, maxReceipts = 64,
  timeoutMs = 10_000, loadOperation } = {}) {
  let url;
  try { url = new URL(rpcUrl); } catch { /* invalid configuration below */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !Array.isArray(allowedRpcUrls) || !allowedRpcUrls.includes(rpcUrl) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      !Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > 256) {
    throw Object.assign(new Error('RPC_CONFIGURATION_INVALID'), { code: 'RPC_CONFIGURATION_INVALID' });
  }
  async function collect(input = {}, sharedClock) {
    let quote, operation, ownerId, jobId;
    try { ({ quote, operation, ownerId, jobId } = structuredClone(input)); }
    catch { return unresolved('OPERATION_BINDING_INVALID'); }
    if (!operation || !token(operation.operationId) || !account(ownerId) || !token(jobId) ||
        operation.ownerId !== ownerId || operation.jobId !== jobId || quote?.networkId !== 'testnet' ||
        operation.networkId !== quote.networkId || !isDeepStrictEqual(operation.quote, quote) ||
        !hash(operation.transactionHash) || !account(operation.signerId)) return unresolved('OPERATION_BINDING_INVALID');
    const clock = sharedClock ?? deadline(timeoutMs);
    const provider = new ReceiptProvider(rpcUrl, clock.signal);
    let status, finalTransaction;
    try {
      try {
        // Do not use cached getNetworkId(), a supplied network string or the
        // hostname as chain evidence: read actual status on EVERY collection.
        status = await clock.read(() => provider.viewNodeStatus());
        if (status?.chain_id !== 'testnet') return unresolved('CHAIN_MISMATCH');
        if (status.sync_info?.syncing === true) return unresolved('RPC_SYNCING');
        finalTransaction = await clock.read(() => provider.viewTransactionStatusWithReceipts({
          txHash: operation.transactionHash, accountId: operation.signerId, waitUntil: 'FINAL',
        }));
      } catch (error) { return unresolved(error?.code === 'COLLECTION_TIMEOUT' ? error.code : 'RPC_UNAVAILABLE'); }
      if (finalTransaction?.transaction?.hash !== operation.transactionHash ||
          finalTransaction.transaction.signer_id !== operation.signerId) return unresolved('TRANSACTION_BINDING_MISMATCH');
      if (finalTransaction.final_execution_status !== 'FINAL') return unresolved('FINALITY_UNAVAILABLE');
      if (!Array.isArray(finalTransaction.receipts_outcome)) return unresolved('GRAPH_INVALID');
      if (finalTransaction.receipts_outcome.length > maxReceipts) return unresolved('RECEIPT_LIMIT');
      const receipts = [];
      try {
        for (const row of finalTransaction.receipts_outcome) {
          receipts.push(await clock.read(() => provider.viewTransactionReceipt(row.id)));
        }
      } catch (error) { return unresolved(error?.code === 'COLLECTION_TIMEOUT' ? error.code : 'RPC_UNAVAILABLE'); }
      const evidence = { networkId: status.chain_id, finalTransaction, receipts };
      try {
        const proof = verifyPaymentProof(quote, evidence);
        return { status: 'accepted', evidence, proof };
      } catch (error) {
        return unresolved(/^[A-Z_]{1,64}$/.test(error.code ?? '') ? error.code : 'INVALID_EVIDENCE');
      }
    } finally { if (!sharedClock) clock.close(); }
  }
  async function trustedReceiptCollector({ ownerId, jobId, quote } = {}) {
    if (typeof loadOperation !== 'function') return null;
    const clock = deadline(timeoutMs);
    try {
      const request = structuredClone({ ownerId, jobId, quote });
      const operation = await clock.read(() => loadOperation(structuredClone(request)));
      const result = await collect({ ...request, operation }, clock);
      return result.status === 'accepted' ? result.evidence : null;
    } catch { return null; }
    finally { clock.close(); }
  }
  return Object.freeze({ collect: input => collect(input), trustedReceiptCollector });
}
