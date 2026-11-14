import { approvedInput, paymentOperationId } from '../../src/shared/job-contract.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { KeyPair, KeyPairSigner, baseEncode, SignedTransaction } from 'near-api-js';
import { createOrders, openLocalRepository } from '../../src/server/orders.mjs';

const module = await import('../../src/server/near-mandate.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e;
});
const time = Date.parse('2026-11-12T12:00:00Z');
const hash = baseEncode(new Uint8Array(32).fill(7));
async function fixture(t, two = false) {
  assert.equal(typeof module.createNearMandateExecution, 'function', 'native runner execution adapter is implemented');
  const dir = await mkdtemp(join(process.env.TMPDIR, 'native-journal-'));
  const filename = join(dir, 'orders.sqlite');
  let repository = openLocalRepository({ filename, localTestOnly: true });
  t.after(async () => { repository.close(); await rm(dir, { recursive: true, force: true }); });
  let approved = { job: { networkId: 'testnet', mandateId: 'mandate.testnet', purpose: 'Synthetic qualification',
    output: 'Evidence report', budgetAtomic: '30', vendorIds: ['vendor.testnet'], expiresAt: '2026-11-12T18:00:00Z' },
  quote: { networkId: 'testnet', mandateId: 'mandate.testnet', vendorId: 'vendor.testnet', amountAtomic: '8', orderId: 'native-1', content: 'Fictional sample' } };
  if (two) {
    const second = {...approved.quote,vendorId:'second.testnet',orderId:'native-2',content:'Second fictional sample'};
    approved = {schemaVersion:'haldir.approved.two-source.v1',job:{...approved.job,vendorIds:[approved.quote.vendorId,second.vendorId]},sources:[{sourceId:'company-records',quote:approved.quote},{sourceId:'background-research',quote:second}]};
  }
  const primary = two ? approved.sources[0].quote : approved.quote;
  const orders = createOrders({ repository, localTestOnly: true, now: () => time });
  const job = await orders.createJob({ ownerId: 'owner.testnet', admissionKey: 'native', approved });
  const request = { operationId: createHash('sha256').update(JSON.stringify(['haldir-agent-payment-v1', job.quoteId])).digest('hex'),
    approvedJobInput: { jobId: job.jobId, ownerId: job.ownerId, quoteId: job.quoteId, qualification: job.qualification, ...job.scope, ...(two ? {sourceRefs:job.sourceRefs}: {}) }, quote: primary };
  const key = KeyPair.fromRandom('ed25519'), signer = new KeyPairSigner(key);
  const binding = { networkId: 'testnet', ownerId: job.ownerId, signerId: 'agent.testnet', mandateId: approved.job.mandateId,
    publicKey: key.getPublicKey().toString(), maxAllowanceAtomic: '1000', codeHash: hash };
  let sends = 0, signs = 0, chain = 'testnet', stopped = false, permission = { FunctionCall: { receiver_id: binding.mandateId, method_names: ['pay'], allowance: '900' } };
  let beforeSend = async () => {};
  const provider = {
    viewNodeStatus: async () => ({ chain_id: chain, sync_info: { syncing: false } }),
    viewAccessKeyList: async options => {
      assert.deepEqual(options, { accountId: binding.signerId, finalityQuery: { finality: 'final' } });
      return { keys: [{ public_key: binding.publicKey, access_key: { nonce: 1, permission } }], block_hash: hash, block_height: 1 };
    },
    query: async q => q.request_type === 'view_access_key_list' ? { keys: [], block_hash: hash, block_height: 1 } : { code_hash: hash },
    callFunction: async () => ({ owner: binding.ownerId, agent: binding.signerId, cap: '30', allowlist: approved.job.vendorIds,
      deadline_ns: String(BigInt(Date.parse(approved.job.expiresAt)) * 1000000n), stopped, expired: false, free: '30', in_flight: null, orders: [] }),
    viewBlock: async () => ({ header: { hash, timestamp_nanosec: String(BigInt(time) * 1000000n) } }),
    sendTransactionUntil: async signed => {
      sends++;
      const args = JSON.parse(Buffer.from(signed.transaction.actions[0].functionCall.args).toString());
      const selected = two ? job.sourceRefs[args.order_id === 'native-2' ? 1 : 0].quoteId : job.quoteId;
      const op = await repository.runTransaction(tx => tx.get('nativeOperations', selected));
      assert.equal(op.signedTransaction, Buffer.from(signed.encode()).toString('base64'));
      assert.equal(op.transactionHash, baseEncode(createHash('sha256').update(signed.transaction.encode()).digest()));
      assert.equal(op.phase, 'BROADCAST_INTENT');
      await beforeSend(op); throw new Error('ambiguous send: response lost');
    },
    viewTransactionStatusWithReceipts: async ({ txHash, accountId }) => ({ final_execution_status: 'FINAL', transaction: { hash: txHash, signer_id: accountId } }),
  };
  const options = () => ({ repository, binding, signer: { getPublicKey: () => signer.getPublicKey(), signTransaction: tx => { signs++; return signer.signTransaction(tx); } },
    rpcUrl: 'http://127.0.0.1:12345', provider, localTestOnly: true, now: () => time });
  return { job, orders, request, provider, options, binding, repository, approved,
    adapter: () => module.createNearMandateExecution(options()),
    read: () => repository.runTransaction(tx => tx.get('nativeOperations', job.quoteId)),
    restart() { repository.close(); repository = openLocalRepository({ filename, localTestOnly: true }); },
    stop: () => { stopped = true; }, chain: v => { chain = v; }, permission: v => { permission = v; },
    beforeSend: fn => { beforeSend = fn; }, counts: () => ({ sends, signs }) };
}

test('runner request reserves durable identity and exact SDK signed bytes before ambiguous broadcast; restart is read-only', async t => {
  const h = await fixture(t);
  const result = await h.adapter().submit(h.request);
  assert.equal(result.status, 'unknown');
  const op = await h.read();
  assert.ok(op.transactionHash); assert.ok(op.signedTransaction);
  assert.equal(SignedTransaction.decode(Buffer.from(op.signedTransaction, 'base64')).transaction.receiverId, h.binding.mandateId);
  h.restart();
  const recovered = await h.adapter().lookup(h.request);
  assert.deepEqual(recovered, { status: 'submitted', reference: op.transactionHash });
  await h.adapter().submit(h.request);
  assert.deepEqual(h.counts(), { sends: 1, signs: 1 });
  assert.equal((await h.read()).transactionHash, op.transactionHash);
  assert.equal((await h.adapter().loadOperation({ ownerId: h.job.ownerId, jobId: h.job.jobId, quote: h.request.quote })).transactionHash, op.transactionHash);
});

for (const [label, change, code] of [
  ['wrong scope', h => { h.request.quote.amountAtomic = '9'; }, 'APPROVAL_MISMATCH'],
  ['wrong key permission', h => h.permission('FullAccess'), 'KEY_PERMISSION'],
  ['unlimited key', h => h.permission({ FunctionCall: { receiver_id: h.binding.mandateId, method_names: ['pay'], allowance: null } }), 'KEY_PERMISSION'],
  ['all methods key', h => h.permission({ FunctionCall: { receiver_id: h.binding.mandateId, method_names: [], allowance: '1' } }), 'KEY_PERMISSION'],
  ['wrong chain', h => h.chain('mainnet'), 'CHAIN_MISMATCH'],
  ['on-chain owner stop', h => h.stop(), 'MANDATE_CLOSED'],
  ['repository owner stop', async h => h.orders.stopLocalJob({ ownerId: h.job.ownerId, jobId: h.job.jobId }), 'OWNER_STOPPED'],
]) test(`fail closed: ${label} never signs or broadcasts`, async t => {
  const h = await fixture(t); await change(h);
  await assert.rejects(h.adapter().submit(h.request), { code });
  assert.deepEqual(h.counts(), { sends: 0, signs: 0 });
});

test('caller cannot attach an owner/model key to execution request', async t => {
  const h = await fixture(t);
  await assert.rejects(h.adapter().submit({ ...h.request, ownerKey: 'SYNTHETIC_FORBIDDEN_INPUT' }), { code: 'APPROVAL_MISMATCH' });
  assert.equal(await h.read(), null);
  assert.deepEqual(h.counts(), { sends: 0, signs: 0 });
});

test('unsafe RPC nonce cannot be rounded into a signed transaction', async t => {
  const h = await fixture(t), healthy = h.provider.viewAccessKeyList;
  h.provider.viewAccessKeyList = async args => {
    const keys = await healthy(args); keys.keys[0].access_key.nonce = Number.MAX_SAFE_INTEGER + 1; return keys;
  };
  await assert.rejects(h.adapter().submit(h.request), { code: 'NONCE_INVALID' });
  assert.deepEqual(h.counts(), { sends: 0, signs: 0 });
});

test('wrong signer identity is rejected independently of RPC key permissions', async t => {
  const h = await fixture(t), wrong = new KeyPairSigner(KeyPair.fromRandom('ed25519'));
  await assert.rejects(module.createNearMandateExecution({ ...h.options(), signer: wrong }).submit(h.request), { code: 'KEY_BINDING_INVALID' });
  assert.deepEqual(h.counts(), { sends: 0, signs: 0 });
});

test('concurrent same-order calls sign and send once; conflicting identity cannot replace journal', async t => {
  const h = await fixture(t);
  await Promise.all([h.adapter().submit(h.request), h.adapter().submit(h.request)]);
  assert.deepEqual(h.counts(), { sends: 1, signs: 1 });
  await assert.rejects(h.adapter().submit({ ...h.request, operationId: 'f'.repeat(64) }), { code: 'APPROVAL_MISMATCH' });
});

test('crash before signed journal commit remains reserved across restart and never signs again', async t => {
  const h = await fixture(t), opts = h.options(), original = opts.repository;
  opts.repository = { runTransaction: callback => original.runTransaction(tx => callback({ ...tx, set(collection, key, value) {
    if (collection === 'nativeOperations') throw new Error('synthetic process crash before signed commit');
    tx.set(collection, key, value);
  } })) };
  await module.createNearMandateExecution(opts).submit(h.request);
  assert.equal((await h.read()).phase, 'RESERVED');
  assert.equal((await h.read()).transactionHash, undefined);
  h.restart();
  await h.adapter().submit(h.request); await h.adapter().lookup(h.request);
  assert.deepEqual(h.counts(), { sends: 0, signs: 1 });
});

test('crash after signed commit but before broadcast retains bytes/hash and never retries a send', async t => {
  const h = await fixture(t), opts = h.options(), original = opts.repository;
  opts.repository = { async runTransaction(callback) {
    let signedCommit = false;
    const result = await original.runTransaction(tx => callback({ ...tx, set(collection, key, value) {
      if (collection === 'nativeOperations' && value.signedTransaction) signedCommit = true;
      tx.set(collection, key, value);
    } }));
    if (signedCommit) throw new Error('synthetic crash after COMMIT before broadcast');
    return result;
  } };
  await module.createNearMandateExecution(opts).submit(h.request);
  const persisted = await h.read();
  assert.ok(persisted.transactionHash); assert.ok(persisted.signedTransaction);
  h.restart();
  await h.adapter().submit(h.request); await h.adapter().lookup(h.request);
  assert.equal((await h.read()).transactionHash, persisted.transactionHash);
  assert.deepEqual(h.counts(), { sends: 0, signs: 1 });
});

test('timeout before signing fences a late provider completion from ever signing/sending', async t => {
  const h = await fixture(t);
  const healthy = h.provider.viewNodeStatus;
  let release;
  h.provider.viewNodeStatus = () => new Promise(resolve => { release = resolve; });
  assert.deepEqual(await module.createNearMandateExecution({ ...h.options(), timeoutMs: 10 }).submit(h.request), { status: 'unknown' });
  release(await healthy());
  await new Promise(resolve => setImmediate(resolve));
  h.provider.viewNodeStatus = healthy;
  await h.adapter().submit(h.request);
  assert.equal((await h.read()).phase, 'RESERVED');
  assert.deepEqual(h.counts(), { sends: 0, signs: 0 });
});

test('broadcast timeout retains signed identity and late completion cannot authorize another send after restart', async t => {
  const h = await fixture(t);
  let release, sends = 0;
  h.provider.sendTransactionUntil = () => { sends++; return new Promise(resolve => { release = resolve; }); };
  const result = await module.createNearMandateExecution({ ...h.options(), timeoutMs: 250 }).submit(h.request);
  assert.equal(result.status, 'unknown');
  const persisted = await h.read(); assert.equal(result.reference, persisted.transactionHash);
  assert.ok(persisted.signedTransaction); assert.equal(sends, 1);
  release({}); await new Promise(resolve => setImmediate(resolve));
  h.restart(); await h.adapter().submit(h.request); await h.adapter().lookup(h.request);
  assert.equal(sends, 1); assert.equal(h.counts().signs, 1);
  assert.equal((await h.read()).transactionHash, persisted.transactionHash);
});

test('public mode uses installed SDK wire methods, exact durable bytes and actual chain pin with no transport retry', async t => {
  const h = await fixture(t), originalFetch = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://offline-native.invalid');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    const wire = JSON.parse(init.body); requests.push(wire);
    let result;
    if (wire.method === 'status') result = await h.provider.viewNodeStatus();
    else if (wire.method === 'query') {
      assert.equal(wire.params.finality, 'final');
      if (wire.params.request_type === 'view_access_key_list' && wire.params.account_id === h.binding.signerId)
        result = await h.provider.viewAccessKeyList({ accountId: h.binding.signerId, finalityQuery: { finality: 'final' } });
      else if (wire.params.request_type === 'call_function') result = { result: [...Buffer.from(JSON.stringify(await h.provider.callFunction()))] };
      else result = await h.provider.query(wire.params);
    } else if (wire.method === 'block') result = await h.provider.viewBlock();
    else if (wire.method === 'send_tx') {
      assert.equal(wire.params.wait_until, 'FINAL');
      const op = await h.read(); assert.equal(wire.params.signed_tx_base64, op.signedTransaction);
      throw new Error('SYNTHETIC transport loss after durable send intent');
    } else if (wire.method === 'EXPERIMENTAL_tx_status') {
      result = { final_execution_status: 'FINAL', transaction: { hash: wire.params.tx_hash, signer_id: wire.params.sender_account_id } };
    } else assert.fail(`unexpected RPC ${wire.method}`);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: wire.id, result }) };
  };
  try {
    const opts = { ...h.options(), provider: undefined, localTestOnly: false, rpcUrl: 'https://offline-native.invalid', allowedRpcUrls: ['https://offline-native.invalid'] };
    const adapter = module.createNearMandateExecution(opts);
    assert.equal((await adapter.submit(h.request)).status, 'unknown');
    const recovered = await adapter.lookup(h.request);
    assert.equal(recovered.status, 'submitted');
    assert.equal(requests.filter(r => r.method === 'send_tx').length, 1);
    await adapter.submit(h.request);
    assert.equal(requests.filter(r => r.method === 'send_tx').length, 1);
    assert.equal(h.counts().signs, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('public chain is pinned to testnet and loopback injection cannot silently enable public mode', async t => {
  const h = await fixture(t), opts = h.options();
  assert.throws(() => module.createNearMandateExecution({ ...opts, localTestOnly: false }), { code: 'RPC_CONFIGURATION_INVALID' });
  assert.throws(() => module.createNearMandateExecution({ ...opts, provider: undefined, localTestOnly: 'yes',
    rpcUrl: 'https://offline-native.invalid', allowedRpcUrls: ['https://offline-native.invalid'], binding: { ...h.binding, networkId: 'mainnet' } }), { code: 'RPC_CONFIGURATION_INVALID' });
  assert.throws(() => module.createNearMandateExecution({ ...opts, provider: undefined, localTestOnly: false,
    rpcUrl: 'https://offline-native.invalid', allowedRpcUrls: ['https://offline-native.invalid'], binding: { ...h.binding, networkId: 'mainnet' } }), { code: 'BINDING_INVALID' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://offline-native.invalid');
    const wire = JSON.parse(init.body); assert.equal(wire.method, 'status');
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: wire.id, result: { chain_id: 'mainnet' } }) };
  };
  try {
    await assert.rejects(module.createNearMandateExecution({ ...opts, provider: undefined, localTestOnly: false,
      rpcUrl: 'https://offline-native.invalid', allowedRpcUrls: ['https://offline-native.invalid'] }).submit(h.request), { code: 'CHAIN_MISMATCH' });
    assert.deepEqual(h.counts(), { sends: 0, signs: 0 });
  } finally { globalThis.fetch = originalFetch; }
});

test('lookup has a bounded deadline even when injected RPC never settles', { timeout: 1000 }, async t => {
  const h = await fixture(t); await h.adapter().submit(h.request);
  h.provider.viewNodeStatus = () => new Promise(() => {});
  const result = await module.createNearMandateExecution({ ...h.options(), timeoutMs: 10 }).lookup(h.request);
  assert.equal(result.status, 'unknown');
});

test('TS1 admitted public binding mutation during signer await cannot persist bytes or broadcast',async t=>{
 const h=await fixture(t,true), opts=h.options(),real=opts.signer;
 await h.repository.runTransaction(async tx=>{const job=await tx.get('jobs',h.job.jobId);tx.set('jobs',job.jobId,{...job,publicManifest:{approved:h.approved,binding:h.binding}});});
 opts.signer={getPublicKey:real.getPublicKey,signTransaction:async tx=>{const signed=await real.signTransaction(tx);await h.repository.runTransaction(async t=>{const job=await t.get('jobs',h.job.jobId);job.publicManifest.binding.codeHash=baseEncode(new Uint8Array(32).fill(9));t.set('jobs',job.jobId,job);});return signed;}};
 await assert.rejects(module.createNearMandateExecution(opts).submit(h.request),{code:'APPROVAL_MISMATCH'});
 const op=await h.read();assert.equal(op.phase,'RESERVED');assert.equal(op.transactionHash,undefined);assert.equal(h.counts().sends,0);
});

test('TS1 native second member signs exact SDK bytes into its own journal and loader never aliases first', async t => {
  const h=await fixture(t,true), adapter=h.adapter(), second=h.approved.sources[1].quote, quoteId=h.job.sourceRefs[1].quoteId;
  const request={operationId:paymentOperationId(quoteId),approvedJobInput:approvedInput(h.job,quoteId),quote:second};
  await adapter.submit(h.request);
  await adapter.submit(request);
  const op=await adapter.loadOperation({ownerId:h.job.ownerId,jobId:h.job.jobId,quote:second});
  assert.equal(op.request.approvedJobInput.quoteId,quoteId);
  assert.deepEqual(op.quote,second);
  assert.deepEqual(h.counts(),{signs:2,sends:2});
  await adapter.submit(request); assert.deepEqual(h.counts(),{signs:2,sends:2});
  assert.equal(await adapter.loadOperation({ownerId:'foreign.testnet',jobId:h.job.jobId,quote:second}),null);
  await assert.rejects(adapter.submit({...request,approvedJobInput:approvedInput(h.job)}),{code:'APPROVAL_MISMATCH'});
});
