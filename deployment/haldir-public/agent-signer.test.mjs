import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, KeyPairSigner, PublicKey, createTransaction, actions, SignedTransaction, baseEncode } from 'near-api-js';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createNearMandateExecution } from '../../src/server/near-mandate.mjs';
import { createOrders, openLocalRepository } from '../../src/server/orders.mjs';
import { createTrustedAgentSignerProvider } from './agent-signer.mjs';

function fixture(t, options = {}) {
  const key = KeyPair.fromRandom('ed25519'); // Synthetic, never exported or logged.
  const binding = { ownerId: 'owner.testnet', signerId: 'agent.testnet', mandateId: 'mandate.testnet',
    networkId: 'testnet', publicKey: key.getPublicKey().toString(), maxAllowanceAtomic: '1000', codeHash: baseEncode(new Uint8Array(32).fill(7)) };
  const manifest = { manifestId: 'fixture', binding, approved: { job: { networkId: 'testnet', mandateId: binding.mandateId,
    vendorIds: ['vendor.testnet'], budgetAtomic: '30', expiresAt: '2099-01-01T00:00:00Z' } } };
  const record = { ownerId: binding.ownerId, jobId: options.jobId ?? 'job-1', manifest, keyVersion: 'synthetic-exact-version-1' };
  let resolves = 0, signs = 0, transport = 0, sdkResult;
  const original = KeyPairSigner.prototype.signTransaction;
  t.mock.method(KeyPairSigner.prototype, 'signTransaction', async function(tx) { signs++; sdkResult = await original.call(this, tx); return sdkResult; });
  t.mock.method(globalThis, 'fetch', async () => { transport++; throw new Error('NETWORK_DENIED'); });
  for (const [object, methods] of [[http, ['request', 'get']], [https, ['request', 'get']], [net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']], [tls, ['connect']]])
    for (const method of methods) t.mock.method(object, method, () => { transport++; throw new Error('NETWORK_DENIED'); });
  const resolver = async input => { resolves++; assert.equal(input.keyVersion, record.keyVersion); assert.ok(input.signal instanceof AbortSignal); return key.toString(); };
  const provider = createTrustedAgentSignerProvider({ catalog: [record], resolveKeyMaterial: options.resolver ?? resolver, timeoutMs: options.timeoutMs ?? 1000 });
  const request = { ownerId: record.ownerId, jobId: record.jobId, manifest: structuredClone(manifest), signal: new AbortController().signal };
  const transaction = () => createTransaction(binding.signerId, PublicKey.fromString(binding.publicKey), binding.mandateId, 1n,
    [actions.functionCall('pay', { order_id: 'order-1', recipient: 'vendor.testnet', amount: '8' }, 100_000_000_000_000n, 0n)], new Uint8Array(32).fill(7));
  t.after(() => assert.equal(transport, 0));
  return { key, record, provider, request, transaction, sdkResult: () => sdkResult, counts: () => ({ resolves, signs }) };
}

for (const [name, mutate] of [
  ['owner', r => { r.ownerId = 'other.testnet'; }],
  ['job', r => { r.jobId = 'other-job'; }],
  ['mandate', r => { r.manifest.binding.mandateId = 'other.testnet'; }],
  ['public key', r => { r.manifest.binding.publicKey = KeyPair.fromRandom('ed25519').getPublicKey().toString(); }],
  ['network', r => { r.manifest.binding.networkId = 'mainnet'; }],
  ['secret input', r => { r.ownerKey = 'FORBIDDEN'; }],
  ['manifest scope', r => { r.manifest.approved.job.budgetAtomic = '99'; }],
]) test(`binding prevalidation denies ${name} before resolution/signing`, async t => {
  const h = fixture(t); mutate(h.request);
  await assert.rejects(h.provider(h.request), { message: 'SIGNER_UNAVAILABLE' });
  assert.deepEqual(h.counts(), { resolves: 0, signs: 0 });
});

test('catalog snapshot cannot be mutated after construction', async t => {
  const h = fixture(t), tx = h.transaction(); h.record.manifest.binding.mandateId = 'other.testnet';
  const signer = await h.provider(h.request);
  assert.ok(await signer.signTransaction(tx));
});

test('wrong resolved secret is rejected before exposing signer without leaking resolver errors', async t => {
  const h = fixture(t, { resolver: async () => KeyPair.fromRandom('ed25519').toString() });
  await assert.rejects(h.provider(h.request), { message: 'SIGNER_UNAVAILABLE' });
  assert.equal(h.counts().signs, 0);
});

for (const [name, mutate] of [
  ['signer', tx => { tx.signerId = 'owner.testnet'; }],
  ['receiver', tx => { tx.receiverId = 'other.testnet'; }],
  ['public key', tx => { tx.publicKey = KeyPair.fromRandom('ed25519').getPublicKey(); }],
  ['transfer', tx => { tx.actions = [actions.transfer(1n)]; }],
  ['deploy', tx => { tx.actions = [actions.deployContract(new Uint8Array([0]))]; }],
  ['add key', tx => { tx.actions = [actions.addFullAccessKey(tx.publicKey)]; }],
  ['two actions', tx => { tx.actions.push(tx.actions[0]); }],
  ['stop', tx => { tx.actions[0].functionCall.methodName = 'stop'; }],
  ['withdraw', tx => { tx.actions[0].functionCall.methodName = 'withdraw'; }],
  ['deposit', tx => { tx.actions[0].functionCall.deposit = 1n; }],
  ['gas', tx => { tx.actions[0].functionCall.gas = 99n; }],
  ['extra ABI field', tx => { tx.actions[0].functionCall.args = Buffer.from('{"order_id":"x","recipient":"vendor.testnet","amount":"8","admin":true}'); }],
  ['unknown vendor', tx => { tx.actions[0].functionCall.args = Buffer.from('{"order_id":"x","recipient":"other.testnet","amount":"8"}'); }],
  ['over budget', tx => { tx.actions[0].functionCall.args = Buffer.from('{"order_id":"x","recipient":"vendor.testnet","amount":"31"}'); }],
  ['noncanonical amount', tx => { tx.actions[0].functionCall.args = Buffer.from('{"order_id":"x","recipient":"vendor.testnet","amount":"08"}'); }],
  ['duplicate ABI field', tx => { tx.actions[0].functionCall.args = Buffer.from('{"order_id":"x","recipient":"vendor.testnet","amount":"1","amount":"8"}'); }],
  ['zero nonce', tx => { tx.nonce = 0n; }],
]) test(`transaction prevalidation denies ${name} without signature or additional resolution`, async t => {
  const h = fixture(t), signer = await h.provider(h.request), tx = h.transaction(); mutate(tx);
  await assert.rejects(signer.signTransaction(tx), { message: 'SIGNER_UNAVAILABLE' });
  assert.deepEqual(h.counts(), { resolves: 1, signs: 0 });
});

test('pre-aborted request never resolves a key', async t => {
  const h = fixture(t); h.request.signal = AbortSignal.abort();
  await assert.rejects(h.provider(h.request), { message: 'SIGNER_UNAVAILABLE' });
  assert.deepEqual(h.counts(), { resolves: 0, signs: 0 });
});

for (const mode of ['timeout', 'abort']) test(`${mode} denies late resolver completion and aborts its signal`, async t => {
  let seen, release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = fixture(t, { timeoutMs: mode === 'timeout' ? 5 : 1000, resolver: async input => { seen = input.signal; await pending; return h.key.toString(); } });
  const controller = new AbortController(); h.request.signal = controller.signal;
  const p = h.provider(h.request);
  const rejection = assert.rejects(p, { message: 'SIGNER_UNAVAILABLE' });
  await Promise.resolve(); assert.ok(seen, 'resolver entered before interruption');
  if (mode === 'abort') controller.abort();
  // Finite fallback ensures the pre-fix RED is a missing rejection, not a hung test.
  const timer = setTimeout(release, 30);
  try { await rejection; assert.ok(seen.aborted); } finally { clearTimeout(timer); release(); }
  assert.equal(h.counts().signs, 0);
});

test('abort after provider return fences public key and signature use', async t => {
  const h = fixture(t), controller = new AbortController(); h.request.signal = controller.signal;
  const signer = await h.provider(h.request); controller.abort();
  await assert.rejects(signer.getPublicKey(), { message: 'SIGNER_UNAVAILABLE' });
  await assert.rejects(signer.signTransaction(h.transaction()), { message: 'SIGNER_UNAVAILABLE' });
  assert.deepEqual(h.counts(), { resolves: 1, signs: 0 });
});

for (const [name, change] of [
  ['owner signer', r => { r.manifest.binding.signerId = r.ownerId; }],
  ['binding owner', r => { r.manifest.binding.ownerId = 'other.testnet'; }],
  ['mainnet', r => { r.manifest.binding.networkId = 'mainnet'; }],
  ['unlimited allowance', r => { r.manifest.binding.maxAllowanceAtomic = null; }],
  ['missing version', r => { r.keyVersion = ''; }],
  ['extra secret', r => { r.ownerKey = 'FORBIDDEN'; }],
  ['invalid budget', r => { r.manifest.approved.job.budgetAtomic = '0'; }],
]) test(`constructor rejects ${name}`, t => {
  const h = fixture(t); change(h.record);
  assert.throws(() => createTrustedAgentSignerProvider({ catalog: [h.record], resolveKeyMaterial: async () => { assert.fail('resolver called'); } }), { message: 'SIGNER_UNAVAILABLE' });
});

test('constructor rejects duplicate job authority', t => {
  const h = fixture(t);
  assert.throws(() => createTrustedAgentSignerProvider({ catalog: [h.record, h.record], resolveKeyMaterial: async () => {} }), { message: 'SIGNER_UNAVAILABLE' });
});

test('late failed resolution stays quarantined and its error never escapes', async t => {
  let reject, calls = 0;
  const pending = new Promise((_, r) => { reject = r; });
  const h = fixture(t, { timeoutMs: 5, resolver: () => { calls++; return pending; } });
  await assert.rejects(h.provider(h.request), { message: 'SIGNER_UNAVAILABLE' });
  await assert.rejects(h.provider(h.request), { message: 'SIGNER_UNAVAILABLE' });
  assert.equal(calls, 1);
  reject(new Error('SYNTHETIC_SENSITIVE_ERROR_DO_NOT_PROPAGATE'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.counts().signs, 0);
});

for (const [label, result] of [['null', null], ['object', {}], ['text', 'invalid-key']]) test(`malformed resolver result ${label} is sanitized`, async t => {
  const h = fixture(t, { resolver: async () => result });
  await assert.rejects(h.provider(h.request), { message: 'SIGNER_UNAVAILABLE' });
});

test('returned signer expires and caller mutation cannot change snapshotted signing bytes', async t => {
  const h = fixture(t, { timeoutMs: 100 }), signer = await h.provider(h.request), tx = h.transaction();
  const expected = tx.encode(), p = signer.signTransaction(tx); tx.receiverId = 'other.testnet';
  assert.deepEqual((await p).signedTransaction.transaction.encode(), expected);
  await new Promise(resolve => setTimeout(resolve, 110));
  await assert.rejects(signer.signTransaction(h.transaction()), { message: 'SIGNER_UNAVAILABLE' });
  assert.deepEqual(h.counts(), { resolves: 1, signs: 1 });
});

test('incumbent execution journal consumes this provider and never re-signs ambiguous send', async t => {
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => repository.close());
  const now = Date.parse('2026-11-13T00:00:00Z');
  const approved = { job: { networkId: 'testnet', mandateId: 'mandate.testnet', purpose: 'Synthetic', output: 'Report',
    vendorIds: ['vendor.testnet'], budgetAtomic: '30', expiresAt: '2099-01-01T00:00:00Z' },
    quote: { networkId: 'testnet', mandateId: 'mandate.testnet', vendorId: 'vendor.testnet', amountAtomic: '8', orderId: 'order-1', content: 'Fictional sample' } };
  const orders = createOrders({ repository, localTestOnly: true, now: () => now });
  const job = await orders.createJob({ ownerId: 'owner.testnet', admissionKey: 'synthetic', approved });
  const h = fixture(t, { jobId: job.jobId }), binding = h.record.manifest.binding;
  const signer = await h.provider(h.request), hash = binding.codeHash;
  let sends = 0;
  const provider = {
    viewNodeStatus: async () => ({ chain_id: 'testnet', sync_info: { syncing: false } }),
    viewAccessKeyList: async input => {
      assert.deepEqual(input, { accountId: binding.signerId, finalityQuery: { finality: 'final' } });
      return { keys: [{ public_key: binding.publicKey, access_key: { nonce: 0, permission: { FunctionCall: {
        receiver_id: binding.mandateId, method_names: ['pay'], allowance: '900' } } } }], block_hash: hash, block_height: 1 };
    },
    query: async input => {
      assert.equal(input.account_id, binding.mandateId); assert.equal(input.finality, 'final');
      if (input.request_type === 'view_access_key_list') return { keys: [], block_hash: hash };
      assert.equal(input.request_type, 'view_account'); return { code_hash: hash };
    },
    callFunction: async input => {
      assert.equal(input.method, 'get_status'); assert.equal(input.contractId, binding.mandateId);
      return { owner: job.ownerId, agent: binding.signerId, cap: '30', allowlist: approved.job.vendorIds,
        deadline_ns: String(BigInt(Date.parse(approved.job.expiresAt)) * 1000000n), stopped: false, expired: false, free: '30', in_flight: null, orders: [] };
    },
    viewBlock: async () => ({ header: { hash, timestamp_nanosec: String(BigInt(now) * 1000000n) } }),
    sendTransactionUntil: async signed => {
      sends++;
      const op = await repository.runTransaction(tx => tx.get('nativeOperations', job.quoteId));
      assert.equal(op.signedTransaction, Buffer.from(signed.encode()).toString('base64'));
      assert.equal(op.phase, 'BROADCAST_INTENT');
      assert.ok(h.key.getPublicKey().verify(createHash('sha256').update(signed.transaction.encode()).digest(), signed.signature.data));
      throw new Error('synthetic accepted send response lost');
    },
    viewTransactionStatusWithReceipts: async ({ txHash, accountId }) => ({ transaction: { hash: txHash, signer_id: accountId } }),
  };
  const execution = createNearMandateExecution({ repository, binding, signer, provider, localTestOnly: true,
    rpcUrl: 'http://127.0.0.1:12345', now: () => now });
  const request = { operationId: createHash('sha256').update(JSON.stringify(['haldir-agent-payment-v1', job.quoteId])).digest('hex'),
    approvedJobInput: { jobId: job.jobId, ownerId: job.ownerId, quoteId: job.quoteId, qualification: job.qualification, ...job.scope }, quote: approved.quote };
  assert.equal((await execution.submit(request)).status, 'unknown');
  assert.equal((await execution.submit(request)).status, 'submitted');
  assert.equal(sends, 1); assert.deepEqual(h.counts(), { resolves: 1, signs: 1 });
});

test('approved binding returns exact incumbent signer and genuine SDK pay bytes', async t => {
  const h = fixture(t), signer = await h.provider(h.request);
  assert.deepEqual(Object.keys(signer).sort(), ['getPublicKey', 'signTransaction']);
  assert.equal((await signer.getPublicKey()).toString(), h.record.manifest.binding.publicKey);
  const tx = h.transaction(), result = await signer.signTransaction(tx);
  assert.strictEqual(result, h.sdkResult(), 'SDK signature result is returned unchanged');
  assert.deepEqual(Object.keys(result).sort(), ['signedTransaction', 'txHash']);
  assert.ok(h.key.getPublicKey().verify(result.txHash, result.signedTransaction.signature.data));
  assert.deepEqual(SignedTransaction.decode(result.signedTransaction.encode()).transaction.encode(), tx.encode());
  assert.deepEqual(h.counts(), { resolves: 1, signs: 1 });
});
