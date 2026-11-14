import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPayment } from '../../src/vendor/fixture.mjs';
import { verifyPaymentProof } from '../../src/vendor/payment-proof.mjs';
import { createOrders, openLocalRepository } from '../../src/server/orders.mjs';
import { readFile } from 'node:fs/promises';
import { JsonRpcProvider } from 'near-api-js';
import { createNearReceiptCollector } from '../../src/server/near-receipts.mjs';

const rpcUrl = 'https://receipt-test.invalid/';
const approved = { networkId: 'testnet', mandateId: 'job.testnet', vendorId: 'vendor.testnet',
  amountAtomic: '3000000000000000000000000', orderId: 'quote-1', content: 'Approved independent sample' };
function fixture() {
  const quote = structuredClone(approved);
  const { evidence } = syntheticPayment(quote);
  const operation = { operationId: 'op-1', ownerId: 'owner.testnet', jobId: 'job-1',
    networkId: quote.networkId, transactionHash: evidence.finalTransaction.transaction.hash,
    signerId: evidence.finalTransaction.transaction.signer_id, quote: structuredClone(quote) };
  return { quote, operation, evidence };
}
function rpc(t, f, handler) {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), rpcUrl, 'no external transport or fixture fallthrough');
    const request = JSON.parse(options.body);
    requests.push(request);
    let result;
    if (handler) result = await handler(request, requests);
    if (result === undefined) {
      if (request.method === 'status') result = { chain_id: 'testnet', sync_info: { syncing: false } };
      else if (request.method === 'EXPERIMENTAL_tx_status') result = f.evidence.finalTransaction;
      else if (request.method === 'EXPERIMENTAL_receipt') result = f.evidence.receipts.find(r => r?.receipt_id === request.params.receipt_id) ?? null;
      else assert.fail(`forbidden/unexpected RPC: ${request.method}`);
    }
    if (result instanceof Response) return result;
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  };
  t.after(() => { globalThis.fetch = original; });
  return requests;
}
const collector = options => createNearReceiptCollector({ rpcUrl, allowedRpcUrls: [rpcUrl], ...options });
const input = f => ({ ownerId: f.operation.ownerId, jobId: f.operation.jobId, quote: f.quote, operation: f.operation });

test('collects SDK FINAL outcome and every actual receipt, then unchanged verifier accepts exact durable operation', async t => {
  const f = fixture(), before = structuredClone(f), requests = rpc(t, f);
  const result = await collector().collect(input(f));
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.evidence, f.evidence);
  assert.deepEqual(result.proof, verifyPaymentProof(f.quote, f.evidence));
  assert.deepEqual(f, before);
  assert.deepEqual(requests.map(r => r.method), ['status', 'EXPERIMENTAL_tx_status',
    ...f.evidence.receipts.map(() => 'EXPERIMENTAL_receipt')]);
  assert.deepEqual(requests[1].params, { tx_hash: f.operation.transactionHash,
    sender_account_id: f.operation.signerId, wait_until: 'FINAL' });
  assert.deepEqual(requests.slice(2).map(r => r.params.receipt_id), f.evidence.finalTransaction.receipts_outcome.map(r => r.id));
});

for (const [name, mutate] of [
  ['absent durable operation', f => { f.operation = null; }],
  ['wrong operation owner', f => { f.operation.ownerId = 'other.testnet'; }],
  ['wrong operation job', f => { f.operation.jobId = 'other-job'; }],
  ['unbound quote content', f => { f.operation.quote.content = 'not approved'; }],
  ['wrong quote amount', f => { f.quote.amountAtomic = '1'; }],
  ['wrong operation network', f => { f.operation.networkId = 'mainnet'; }],
  ['non-testnet quote', f => { f.quote.networkId = f.operation.networkId = f.operation.quote.networkId = 'mainnet'; }],
  ['invalid operation identity', f => { f.operation.operationId = ''; }],
  ['invalid transaction hash', f => { f.operation.transactionHash = 'bad/hash'; }],
  ['hash decodes to wrong byte width', f => { f.operation.transactionHash = '1'.repeat(33); }],
  ['invalid signer', f => { f.operation.signerId = 'agent.testnet '; }],
]) test(`binding: ${name} is unresolved before RPC`, async t => {
  const f = fixture(), call = input(f); mutate(f);
  const requests = rpc(t, f);
  const result = await collector().collect({ ...call, quote: f.quote, operation: f.operation });
  assert.deepEqual(result, { status: 'unresolved', code: 'OPERATION_BINDING_INVALID' });
  assert.equal(requests.length, 0);
});

for (const chainId of ['mainnet', 'test-chain-sandbox', undefined]) {
  test(`actual status chain ${chainId} never becomes testnet evidence`, async t => {
    const f = fixture(), requests = rpc(t, f, r => r.method === 'status' ? { chain_id: chainId } : undefined);
    assert.deepEqual(await collector().collect(input(f)), { status: 'unresolved', code: 'CHAIN_MISMATCH' });
    assert.deepEqual(requests.map(r => r.method), ['status']);
  });
}

test('actual syncing node remains unresolved', async t => {
  const f = fixture(), requests = rpc(t, f, r => r.method === 'status' ? { chain_id: 'testnet', sync_info: { syncing: true } } : undefined);
  assert.deepEqual(await collector().collect(input(f)), { status: 'unresolved', code: 'RPC_SYNCING' });
  assert.equal(requests.length, 1);
});

for (const field of ['hash', 'signer_id']) test(`response transaction ${field} must match durable operation exactly`, async t => {
  const f = fixture();
  if (field === 'hash') f.operation.transactionHash = '11111111111111111111111111111111';
  else f.operation.signerId = 'other.testnet';
  const requests = rpc(t, f);
  assert.deepEqual(await collector().collect(input(f)), { status: 'unresolved', code: 'TRANSACTION_BINDING_MISMATCH' });
  assert.equal(requests.length, 2);
});

for (const config of [
  {}, { rpcUrl }, { rpcUrl, allowedRpcUrls: [] }, { rpcUrl: 'http://receipt-test.invalid/', allowedRpcUrls: ['http://receipt-test.invalid/'] },
  { rpcUrl: 'https://user:password@receipt-test.invalid/', allowedRpcUrls: ['https://user:password@receipt-test.invalid/'] },
  { rpcUrl: `${rpcUrl}?token=x`, allowedRpcUrls: [`${rpcUrl}?token=x`] },
  { rpcUrl: `${rpcUrl}#fragment`, allowedRpcUrls: [`${rpcUrl}#fragment`] },
]) test(`rejects unsafe/unallowlisted RPC configuration ${JSON.stringify(config)}`, () => {
  assert.throws(() => createNearReceiptCollector(config), e => e.code === 'RPC_CONFIGURATION_INVALID');
});

for (const stage of ['status', 'EXPERIMENTAL_tx_status', 'EXPERIMENTAL_receipt']) {
  for (const [name, error] of [
    ['unknown transaction', { code: -32000, message: 'Server error', data: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } }],
    ['pruned receipt', { code: -32000, message: 'Server error', data: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_RECEIPT' } } }],
    ['unsupported method', { code: -32601, message: 'Method not found' }],
    ['server timeout', { code: -32000, message: 'Server error', data: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } }],
  ]) test(`${stage}: ${name} is unresolved, never failed or not-paid`, async t => {
    const f = fixture(), before = structuredClone(f);
    rpc(t, f, r => r.method === stage ? Response.json({ jsonrpc: '2.0', id: r.id, error }) : undefined);
    assert.deepEqual(await collector().collect(input(f)), { status: 'unresolved', code: 'RPC_UNAVAILABLE' });
    assert.deepEqual(f, before);
  });
  test(`${stage}: transport failure is unresolved with only one SDK attempt`, async t => {
    const f = fixture(), requests = rpc(t, f, r => { if (r.method === stage) throw new Error('network unavailable'); });
    assert.deepEqual(await collector().collect(input(f)), { status: 'unresolved', code: 'RPC_UNAVAILABLE' });
    assert.equal(requests.filter(r => r.method === stage).length, 1);
  });
}

for (const finality of ['NONE', 'INCLUDED', 'EXECUTED_OPTIMISTIC', 'EXECUTED', undefined]) {
  test(`non-FINAL ${finality} returns unresolved before receipt reads`, async t => {
    const f = fixture(); f.evidence.finalTransaction.final_execution_status = finality;
    const requests = rpc(t, f);
    assert.deepEqual(await collector().collect(input(f)), { status: 'unresolved', code: 'FINALITY_UNAVAILABLE' });
    assert.equal(requests.length, 2);
  });
}

for (const [name, mutate, code] of [
  ['wrong actual Transfer amount', f => { f.evidence.receipts[1].receipt.Action.actions[0].Transfer.deposit = '1'; }, 'TRANSFER_MISMATCH'],
  ['missing actual receipt', f => { f.evidence.receipts[1] = null; }, 'RECEIPT_MISMATCH'],
  ['missing Action payload', f => { delete f.evidence.receipts[1].receipt.Action; }, 'RECEIPT_MISMATCH'],
  ['wrong order in pay', f => { f.evidence.finalTransaction.transaction.actions[0].FunctionCall.args = Buffer.from('{}').toString('base64'); }, 'PAY_CALL_MISMATCH'],
  ['orphan Transfer', f => { f.evidence.finalTransaction.receipts_outcome[0].outcome.receipt_ids.shift(); }, 'GRAPH_INVALID'],
  ['failed descendant despite successful aggregate', f => { f.evidence.finalTransaction.receipts_outcome[1].outcome.status = { Failure: {} }; }, 'GRAPH_INVALID'],
  ['duplicate outcome', f => { f.evidence.finalTransaction.receipts_outcome.push(f.evidence.finalTransaction.receipts_outcome[1]); }, 'GRAPH_INVALID'],
  ['wrong callback dependency', f => { f.evidence.receipts[2].receipt.Action.input_data_ids = []; }, 'CALLBACK_MISMATCH'],
]) test(`unchanged verifier rejects ${name} without inferring nonpayment`, async t => {
  const f = fixture(); mutate(f); rpc(t, f);
  assert.deepEqual(await collector().collect(input(f)), { status: 'unresolved', code });
});

test('receipt read bound cannot authorize acceptance of a partial graph', async t => {
  const f = fixture(), requests = rpc(t, f);
  assert.deepEqual(await collector({ maxReceipts: 2 }).collect(input(f)), { status: 'unresolved', code: 'RECEIPT_LIMIT' });
  assert.equal(requests.length, 2);
});

for (const stage of ['status', 'EXPERIMENTAL_tx_status', 'EXPERIMENTAL_receipt']) test(`bounded timeout at ${stage} cannot accept late evidence or start further reads`, async t => {
  const f = fixture(), before = structuredClone(f);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const requests = rpc(t, f, async r => { if (r.method === stage) { await gate; } });
  const pending = collector({ timeoutMs: 15 }).collect(input(f));
  const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve({ status: 'HUNG' }), 150))]);
  const count = requests.length;
  release(); await pending; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(result, { status: 'unresolved', code: 'COLLECTION_TIMEOUT' });
  assert.equal(requests.length, count, 'late resolution must not start subsequent reads');
  assert.deepEqual(f, before);
});

test('quote and durable transaction identity are snapshotted before provider awaits', async t => {
  const f = fixture(), original = structuredClone(f);
  rpc(t, f, r => {
    if (r.method === 'status') {
      f.quote.content = 'tampered after admission';
      f.operation.quote.content = f.quote.content;
      f.operation.transactionHash = '11111111111111111111111111111111';
      f.operation.signerId = 'other.testnet';
    }
  });
  const result = await collector().collect(input(f));
  assert.equal(result.status, 'accepted');
  assert.equal(result.proof.transactionHash, original.operation.transactionHash);
});

for (const config of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxReceipts: 0 }, { maxReceipts: 10000 }, { maxReceipts: 1.5 }]) {
  test(`requires bounded positive collector limits ${JSON.stringify(config)}`, () => {
    assert.throws(() => collector(config), e => e.code === 'RPC_CONFIGURATION_INVALID');
  });
}

test('orders adapter loads durable operation by trusted owner/job and returns only verified evidence', async t => {
  const f = fixture(), requests = rpc(t, f), lookups = [];
  const c = collector({ loadOperation: async request => { lookups.push(request); return f.operation; } });
  const request = { ownerId: f.operation.ownerId, jobId: f.operation.jobId, quote: f.quote,
    operation: { ...f.operation, transactionHash: 'attacker-substitution' } };
  assert.deepEqual(await c.trustedReceiptCollector(request), f.evidence);
  assert.deepEqual(lookups, [{ ownerId: request.ownerId, jobId: request.jobId, quote: f.quote }]);
  assert.equal(requests[1].params.tx_hash, f.operation.transactionHash);
});

test('orders adapter never accepts an absent, foreign or unavailable durable operation', async t => {
  const f = fixture(), requests = rpc(t, f);
  for (const loadOperation of [undefined, async () => null, async () => { throw new Error('store unavailable'); },
    async () => ({ ...f.operation, jobId: 'other-job' })]) {
    const c = collector({ loadOperation });
    assert.equal(await c.trustedReceiptCollector(input(f)), null);
  }
  assert.equal(requests.length, 0);
});

test('incumbent orders keep same durable operation pending on RPC loss, then claim exact proof once on recovery', async t => {
  const f = fixture(), before = structuredClone(f.operation);
  let unavailable = true, lookups = 0;
  const requests = rpc(t, f, r => {
    if (unavailable && r.method === 'EXPERIMENTAL_receipt') throw new Error('pruned or unavailable');
  });
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => repository.close());
  const loadOperation = ({ ownerId, jobId }) => repository.runTransaction(async tx => {
    lookups++;
    const operation = await tx.get('operations', jobId);
    return operation?.ownerId === ownerId ? operation : null;
  });
  const c = collector({ loadOperation });
  const orders = createOrders({ repository, localTestOnly: true, now: () => Date.parse('2026-11-12T12:00:00Z'),
    trustedReceiptCollector: c.trustedReceiptCollector });
  const job = await orders.createJob({ ownerId: f.operation.ownerId, admissionKey: 'receipt-admission', approved: {
    job: { networkId: 'testnet', mandateId: f.quote.mandateId, purpose: 'Receipt qualification', output: 'Sample',
      budgetAtomic: f.quote.amountAtomic, vendorIds: [f.quote.vendorId], expiresAt: '2026-11-13T12:00:00Z' }, quote: f.quote,
  } });
  f.operation.jobId = job.jobId;
  await repository.runTransaction(tx => tx.create('operations', job.jobId, f.operation));
  const request = { ownerId: f.operation.ownerId, jobId: job.jobId };
  const pending = await orders.checkPayment(request);
  assert.equal(pending.lifecycle, 'PAYMENT_PENDING'); assert.equal(pending.proof, null);
  assert.equal(pending.lastCheckCode, 'EVIDENCE_UNAVAILABLE');
  const retained = await repository.runTransaction(tx => tx.get('operations', job.jobId));
  assert.deepEqual(retained, { ...before, jobId: job.jobId });
  unavailable = false;
  const paid = await orders.checkPayment(request);
  assert.equal(paid.lifecycle, 'PAID_NOT_DELIVERED');
  assert.equal(paid.proof.transactionHash, retained.transactionHash);
  assert.deepEqual(await orders.checkPayment(request), paid);
  assert.equal(lookups, 2, 'already-paid check does not collect or create another payment');
  assert.deepEqual(await repository.runTransaction(tx => tx.get('operations', job.jobId)), retained);
  assert.ok(requests.every(r => ['status', 'EXPERIMENTAL_tx_status', 'EXPERIMENTAL_receipt'].includes(r.method)));
});

test('real historical Sandbox FINAL pay outcome without retained action records remains unresolved; actions are never invented', async t => {
  const log = await readFile(new URL('../../target/mandate-factory/storage-fix/final-sandbox.log', import.meta.url), 'utf8');
  const transactions = log.split('\n').filter(line => line.includes('transaction ')).map(line => JSON.parse(line.split('transaction ')[1]));
  const tx = transactions.find(tx => tx.transaction.actions.some(a => a.FunctionCall?.method_name === 'pay') && tx.status.SuccessValue === 'dHJ1ZQ==');
  assert.ok(tx); assert.equal(Object.hasOwn(tx, 'receipts'), false);
  const args = JSON.parse(Buffer.from(tx.transaction.actions[0].FunctionCall.args, 'base64'));
  const quote = { networkId: 'testnet', mandateId: tx.transaction.receiver_id, vendorId: args.recipient,
    amountAtomic: args.amount, orderId: args.order_id };
  const f = fixture();
  f.quote = quote; f.operation.quote = structuredClone(quote);
  f.operation.transactionHash = tx.transaction.hash; f.operation.signerId = tx.transaction.signer_id;
  f.evidence = { networkId: 'testnet', finalTransaction: tx, receipts: [] };
  // Only outcome bytes are historical. Testnet status and missing-record RPC are
  // synthetic replay boundaries, NOT claims about the historical Sandbox chain.
  const requests = rpc(t, f);
  assert.deepEqual(await collector().collect(input(f)), { status: 'unresolved', code: 'RECEIPT_MISMATCH' });
  assert.equal(requests.filter(r => r.method === 'EXPERIMENTAL_receipt').length, tx.receipts_outcome.length);
});

test('deadline is checked after last receipt resolution even before wall-clock timeout callback runs', async t => {
  const f = fixture(); let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  rpc(t, f, r => { if (r.params.receipt_id === f.evidence.receipts.at(-1).receipt_id) elapsed = 100; });
  assert.deepEqual(await collector({ timeoutMs: 100 }).collect(input(f)), { status: 'unresolved', code: 'COLLECTION_TIMEOUT' });
});

test('orders adapter has one total deadline including its durable operation read', async t => {
  const f = fixture(); let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  rpc(t, f, r => { if (r.method === 'EXPERIMENTAL_receipt') elapsed = 110; });
  const c = collector({ timeoutMs: 100, loadOperation: async () => { elapsed = 80; return f.operation; } });
  assert.equal(await c.trustedReceiptCollector(input(f)), null);
});

for (const [field, mutate] of [
  ['owner', f => { f.operation.ownerId += '\n'; }],
  ['job', f => { f.operation.jobId += '\n'; }],
  ['operation ID', f => { f.operation.operationId += '\n'; }],
]) test(`literal ${field} trailing newline is rejected instead of normalized`, async t => {
  const f = fixture(); mutate(f); const requests = rpc(t, f);
  assert.deepEqual(await collector().collect(input(f)), { status: 'unresolved', code: 'OPERATION_BINDING_INVALID' });
  assert.equal(requests.length, 0);
});

test('RPC transport forbids redirects away from configured allowlist instead of trusting another source', async t => {
  const f = fixture(); let options;
  rpc(t, f);
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => { options = init; return original(url, init); };
  assert.equal((await collector().collect(input(f))).status, 'accepted');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
});

for (const httpStatus of [301, 302, 307, 400, 401, 403, 429, 500, 503]) {
  test(`HTTP ${httpStatus} cannot smuggle an otherwise-valid result into accepted evidence`, async t => {
    const f = fixture(); rpc(t, f, r => r.method === 'status' ? Response.json({ jsonrpc: '2.0', id: r.id,
      result: { chain_id: 'testnet', sync_info: { syncing: false } } }, { status: httpStatus }) : undefined);
    assert.deepEqual(await collector().collect(input(f)), { status: 'unresolved', code: 'RPC_UNAVAILABLE' });
  });
}

for (const reason of [null, undefined, 'transport rejected']) test(`non-Error RPC rejection ${reason} remains unresolved`, async t => {
  const f = fixture(); rpc(t, f, () => { throw reason; });
  assert.deepEqual(await collector().collect(input(f)), { status: 'unresolved', code: 'RPC_UNAVAILABLE' });
});

// Explicit opt-in only. No wallet/keys/signing/broadcast, transaction discovery
// or unbounded crawl. This single already-observed transaction has a runtime
// gas-refund Transfer, NOT a vendor payment. Pruning/availability can change.
test('public read-only official testnet status and native runtime-refund receipt payload; NOT Haldir payment acceptance', {
  skip: process.env.HALDIR_PUBLIC_RECEIPT_CHECK !== '1', timeout: 60_000,
}, async t => {
  const endpoint = 'https://archival-rpc.testnet.near.org';
  const txHash = '74TSaKXd7tv91xtTbgFU3MesVpzGpjRLwk9kkN2Seztz';
  const accountId = 'aura-perps.testnet';
  const original = globalThis.fetch;
  const methods = [];
  globalThis.fetch = (url, init) => {
    assert.equal(String(url), endpoint);
    const body = JSON.parse(init.body);
    assert.ok(['status', 'EXPERIMENTAL_tx_status', 'EXPERIMENTAL_receipt'].includes(body.method));
    methods.push(body.method);
    return original(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(15_000) });
  };
  t.after(() => { globalThis.fetch = original; });
  const provider = new JsonRpcProvider({ url: endpoint }, { retries: 1 });
  const status = await provider.viewNodeStatus();
  assert.equal(status.chain_id, 'testnet');
  const tx = await provider.viewTransactionStatusWithReceipts({ txHash, accountId, waitUntil: 'FINAL' });
  assert.equal(tx.final_execution_status, 'FINAL'); assert.equal(tx.transaction.hash, txHash);
  assert.equal(tx.transaction.signer_id, accountId); assert.ok(tx.receipts_outcome.length <= 12);
  const receipts = [];
  for (const row of tx.receipts_outcome) {
    const receipt = await provider.viewTransactionReceipt(row.id);
    assert.equal(receipt.receipt_id, row.id); receipts.push(receipt);
  }
  const refund = receipts.find(r => r.predecessor_id === 'system' && r.receiver_id === accountId &&
    r.receipt?.Action?.actions?.[0]?.Transfer?.deposit === '50722873906624600000000');
  assert.ok(refund, 'actual Transfer payload must be retrieved before capability can pass');
  const quote = { networkId: 'testnet', mandateId: tx.transaction.receiver_id, vendorId: accountId,
    orderId: 'capability-only-NOT-approved-payment', amountAtomic: '50722873906624600000000' };
  const result = await createNearReceiptCollector({ rpcUrl: endpoint, allowedRpcUrls: [endpoint], timeoutMs: 30_000 }).collect({
    ownerId: accountId, jobId: 'capability-only', quote, operation: { operationId: 'capability-only', ownerId: accountId,
      jobId: 'capability-only', networkId: 'testnet', quote, transactionHash: txHash, signerId: accountId },
  });
  assert.deepEqual(result, { status: 'unresolved', code: 'NOT_FINAL' });
  assert.equal(methods.length, 4 + receipts.length * 2);
  t.diagnostic(JSON.stringify({ observedAt: new Date().toISOString(), endpoint, chainId: status.chain_id,
    nodeVersion: status.version.version, transactionHash: txHash, signerId: accountId, finality: tx.final_execution_status,
    receiptsRetrieved: receipts.length, actualRuntimeRefund: refund, collectorResult: result,
    qualification: 'RPC_PAYLOAD_CAPABILITY_ONLY_NOT_VENDOR_PAYMENT', readRequests: methods.length }));
});
