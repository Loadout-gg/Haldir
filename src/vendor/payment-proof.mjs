import { isDeepStrictEqual } from 'node:util';

function requireProof(condition, code, detail) {
  if (!condition) throw Object.assign(new Error(`${code}: ${detail}`), { code });
}
const accountId = value => typeof value === 'string' && value.length >= 2 && value.length <= 64 &&
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
const amount = value => typeof value === 'string' && /^[1-9][0-9]{0,38}$/.test(value) && BigInt(value) < 2n ** 128n;
const variant = (value, key) => value && typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, key);
const hash = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
function jsonArgs(value) {
  if (typeof value !== 'string' || value.length > 4096 || Buffer.from(value, 'base64').toString('base64') !== value) return null;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'base64'))); }
  catch { return null; }
}

function receiptGraph(tx) {
  requireProof(hash(tx.transaction.hash) && accountId(tx.transaction.signer_id) &&
    typeof tx.transaction.public_key === 'string' && tx.transaction.public_key.length > 0 &&
    Array.isArray(tx.receipts_outcome) && tx.transaction_outcome?.id === tx.transaction.hash &&
    tx.transaction_outcome?.outcome?.executor_id === tx.transaction.signer_id &&
    tx.transaction_outcome.outcome.receipt_ids?.length === 1 &&
    isDeepStrictEqual(tx.transaction_outcome.outcome.status, { SuccessReceiptId: tx.transaction_outcome.outcome.receipt_ids[0] }),
  'GRAPH_INVALID', 'transaction identity or origin mismatch');
  const outcomes = new Map();
  for (const row of [tx.transaction_outcome, ...tx.receipts_outcome]) {
    requireProof(row && hash(row.id) && hash(row.block_hash) && !outcomes.has(row.id) && row.outcome &&
      Array.isArray(row.outcome.receipt_ids), 'GRAPH_INVALID', 'missing or duplicate outcome');
    const { status, receipt_ids: children } = row.outcome;
    requireProof((variant(status, 'SuccessValue') && typeof status.SuccessValue === 'string') ||
      (variant(status, 'SuccessReceiptId') && children.includes(status.SuccessReceiptId)),
    'GRAPH_INVALID', 'failed, pending or unlinked success status');
    outcomes.set(row.id, row);
  }
  const parents = new Map();
  const queue = [tx.transaction.hash];
  const visited = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const child of outcomes.get(id).outcome.receipt_ids) {
      requireProof(outcomes.has(child) && !visited.has(child), 'GRAPH_INVALID', 'missing child, cycle or multiple causal parents');
      visited.add(child); parents.set(child, id); queue.push(child);
    }
  }
  requireProof(visited.size === outcomes.size, 'GRAPH_INVALID', 'unrelated outcome outside transaction graph');
  return { outcomes, parents, rootId: tx.transaction_outcome.outcome.receipt_ids[0] };
}

/**
 * Verify the current Haldir native-mandate pay -> Transfer -> on_payment ABI.
 * Pure: no RPC, signing, state lookup, persistence or receipt claiming.
 *
 * quote is an INDEPENDENTLY APPROVED snapshot:
 *   { networkId, mandateId, vendorId, amountAtomic, orderId }
 * evidence is assembled by a TRUSTED caller, never accepted from the purchaser:
 *   { networkId, finalTransaction, receipts }
 * finalTransaction is the complete FINAL RPC outcome. receipts contains actual
 * full ReceiptView/EXPERIMENTAL_receipt records for EVERY receipts_outcome ID,
 * including the originating pay receipt and runtime gas refunds. Outcomes do
 * not contain action payloads. Do not reconstruct Transfer actions from a quote.
 *
 * The caller establishes RPC provenance, chain identity and finality; field and
 * graph checks are not a cryptographic/light-client proof against a lying RPC.
 * Persist proofId with a UNIQUE constraint and atomically bind it to one quote
 * before releasing data. Repeated calls here intentionally return the same ID;
 * this helper does NOT prevent cross-job reuse or implement delivery/refunds.
 * Rejection is NOT proof of nonpayment and never authorizes another payment.
 * Unsupported/absent evidence throws an Error with a stable `code`.
 */
export function verifyPaymentProof(quote, evidence) {
  requireProof(quote && typeof quote.networkId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(quote.networkId) &&
    accountId(quote.mandateId) && accountId(quote.vendorId) && amount(quote.amountAtomic) &&
    typeof quote.orderId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(quote.orderId), 'INVALID_QUOTE', 'expected independent exact atomic quote');
  requireProof(evidence?.networkId === quote.networkId, 'NETWORK_MISMATCH', 'trusted caller chain differs from quote');
  const tx = evidence.finalTransaction;
  requireProof(tx?.final_execution_status === 'FINAL' && variant(tx.status, 'SuccessValue') && jsonArgs(tx.status.SuccessValue) === true,
    'NOT_FINAL', 'require FINAL successful pay/callback result');
  const call = tx.transaction?.actions?.[0];
  requireProof(tx.transaction?.receiver_id === quote.mandateId && Array.isArray(tx.transaction.actions) && tx.transaction.actions.length === 1 &&
    variant(call, 'FunctionCall') && call.FunctionCall?.method_name === 'pay' && call.FunctionCall.deposit === '0' &&
    isDeepStrictEqual(jsonArgs(call.FunctionCall.args), { order_id: quote.orderId, recipient: quote.vendorId, amount: quote.amountAtomic }),
  'PAY_CALL_MISMATCH', 'require one exact zero-deposit mandate pay call');
  const { outcomes, parents, rootId } = receiptGraph(tx);
  const records = evidence.receipts;
  requireProof(Array.isArray(records), 'MISSING_ACTION_EVIDENCE', 'full RPC receipt records are required; tx outcomes do not contain native actions');
  const byId = new Map();
  for (const r of records) {
    requireProof(r && outcomes.has(r.receipt_id) && r.receipt_id !== tx.transaction.hash && !byId.has(r.receipt_id),
      'RECEIPT_MISMATCH', 'unknown or duplicate full receipt ID');
    byId.set(r.receipt_id, r);
  }
  requireProof(byId.size === outcomes.size - 1, 'MISSING_ACTION_EVIDENCE', 'retrieve a full record for every causal receipt outcome');
  for (const r of records) {
    const row = outcomes.get(r.receipt_id);
    const action = r.receipt?.Action;
    requireProof(variant(r.receipt, 'Action') && Array.isArray(action?.actions) &&
      r.receiver_id === row.outcome.executor_id && action.signer_id === tx.transaction.signer_id &&
      action.signer_public_key === tx.transaction.public_key, 'RECEIPT_MISMATCH', 'receipt executor/action/signer mismatch');
    const parent = outcomes.get(parents.get(r.receipt_id));
    if (r.predecessor_id === 'system') {
      // Runtime gas refunds are real native transfers, but are never vendor payments.
      requireProof(r.receiver_id === tx.transaction.signer_id && action.actions.length === 1 &&
        variant(action.actions[0], 'Transfer') && amount(action.actions[0].Transfer.deposit) &&
        action.input_data_ids?.length === 0 && action.output_data_receivers?.length === 0 &&
        row.outcome.receipt_ids.length === 0 && row.outcome.status.SuccessValue === '',
      'RECEIPT_MISMATCH', 'unsupported system refund shape');
    } else {
      requireProof(r.predecessor_id === parent.outcome.executor_id, 'RECEIPT_MISMATCH', 'predecessor differs from causal parent executor');
    }
  }
  const root = byId.get(rootId);
  requireProof(root.receiver_id === quote.mandateId && root.predecessor_id === tx.transaction.signer_id &&
    isDeepStrictEqual(root.receipt.Action.actions, tx.transaction.actions), 'RECEIPT_MISMATCH', 'origin receipt differs from transaction pay');
  const candidates = records.filter(r => r.predecessor_id === quote.mandateId &&
    (r.receiver_id === quote.vendorId || r.receipt.Action.actions.some(a => a && typeof a === 'object' && Object.hasOwn(a, 'Transfer'))));
  requireProof(candidates.length <= 1, 'AMBIGUOUS_PAYMENT', 'multiple candidate native payment receipts');
  const transfer = candidates[0];
  const nativeActions = transfer?.receipt.Action.actions;
  requireProof(transfer && transfer.receiver_id === quote.vendorId && parents.get(transfer.receipt_id) === rootId &&
    nativeActions.length === 1 && variant(nativeActions[0], 'Transfer') && nativeActions[0].Transfer?.deposit === quote.amountAtomic &&
    isDeepStrictEqual(outcomes.get(transfer.receipt_id).outcome.status, { SuccessValue: '' }),
  'TRANSFER_MISMATCH', 'require one successful exact native Transfer directly created by pay');
  const callbackId = outcomes.get(rootId).outcome.status.SuccessReceiptId;
  const callback = byId.get(callbackId);
  const callbackActions = callback?.receipt.Action.actions;
  const callbackCall = callbackActions?.[0]?.FunctionCall;
  const output = transfer.receipt.Action.output_data_receivers;
  requireProof(callback && parents.get(callbackId) === rootId && callback.receiver_id === quote.mandateId &&
    callback.predecessor_id === quote.mandateId && callbackActions.length === 1 &&
    variant(callbackActions[0], 'FunctionCall') && callbackCall?.method_name === 'on_payment' && callbackCall.deposit === '0' &&
    isDeepStrictEqual(jsonArgs(callbackCall.args), { order_id: quote.orderId }) &&
    jsonArgs(outcomes.get(callbackId).outcome.status.SuccessValue) === true &&
    Array.isArray(output) && output.length === 1 && output[0]?.receiver_id === quote.mandateId &&
    isDeepStrictEqual(callback.receipt.Action.input_data_ids, [output[0].data_id]),
  'CALLBACK_MISMATCH', 'require successful same-order callback dependent on this native Transfer');
  return { proofId: JSON.stringify(['near-native-transfer-v1', quote.networkId, transfer.receipt_id]),
    networkId: quote.networkId, transactionHash: tx.transaction.hash,
    payReceiptId: tx.transaction_outcome.outcome.receipt_ids[0], transferReceiptId: transfer.receipt_id,
    mandateId: quote.mandateId, vendorId: quote.vendorId, amountAtomic: quote.amountAtomic, orderId: quote.orderId };
}
