import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOrders, openLocalRepository } from '../../src/server/orders.mjs';

const chainId = 'test-chain-admission', ownerId = 'owner.sandbox';
const now = () => Date.parse('2026-11-12T12:00:00Z');
function approval(networkId = chainId) {
  return {
    job: { networkId, mandateId: 'job.factory.sandbox', purpose: 'Local admission qualification',
      output: 'Fictional report', budgetAtomic: '3000000000000000000000000',
      vendorIds: ['vendor.sandbox'], expiresAt: '2026-11-13T12:00:00Z' },
    quote: { networkId, mandateId: 'job.factory.sandbox', vendorId: 'vendor.sandbox',
      amountAtomic: '3000000000000000000000000', orderId: 'quote-1', content: 'Fictional sample' },
  };
}
function repo(t) {
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => repository.close());
  return repository;
}
const admit = (orders, approved = approval(), extra = {}) => orders.createJob({
  ownerId, admissionKey: 'local-admission', approved, ...extra,
});
// Synthetic status ONLY. Real near-sandbox admission is qualified separately.
async function statusServer(t) {
  const requests = [];
  let result = { chain_id: chainId, sync_info: { syncing: false } };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request);
    assert.equal(req.method, 'POST'); assert.equal(request.method, 'status');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { rpcUrl: `http://127.0.0.1:${server.address().port}/`, requests,
    setStatus: value => { result = value; } };
}

test('default admission remains testnet-only; request fields cannot configure Sandbox or mainnet admission', async t => {
  const repository = repo(t), orders = createOrders({ repository, localTestOnly: true, now });
  for (const networkId of [chainId, 'mainnet']) {
    await assert.rejects(admit(orders, approval(networkId), {
      trustedLocalChain: { networkId, rpcUrl: 'http://127.0.0.1:1/' }, allowedNetworkIds: [networkId],
    }), { code: 'INVALID_APPROVAL' });
  }
  const job = await admit(orders, approval('testnet'));
  assert.equal(job.scope.networkId, 'testnet');
  assert.deepEqual(await orders.getJob({ ownerId, jobId: job.jobId }), job);
});

test('explicit trusted loopback Sandbox configuration admits only the exact verified chain through normal durable admission', async t => {
  const server = await statusServer(t), repository = repo(t);
  const trustedLocalChain = { networkId: chainId, rpcUrl: server.rpcUrl };
  const orders = createOrders({ repository, localTestOnly: true, now, trustedLocalChain });
  const approved = approval();
  const job = await admit(orders, approved);
  assert.equal(server.requests.length, 1, 'actual loopback status read before admission');
  assert.deepEqual(job.scope, approved.job);
  assert.equal(job.qualification, 'LOCAL_SYNTHETIC_ONLY');
  assert.deepEqual(await orders.getJob({ ownerId, jobId: job.jobId }), job);
  const order = await orders.getOrder({ ownerId, jobId: job.jobId });
  assert.deepEqual(order.quote, approved.quote);
  assert.equal(order.lifecycle, 'PAYMENT_PENDING'); assert.equal(order.proof, null);
  const tuple = (...values) => Buffer.from(JSON.stringify(['haldir-local-v1', ...values])).toString('base64url');
  const admission = await repository.runTransaction(tx => tx.get('admissions', tuple(ownerId, 'local-admission')));
  assert.deepEqual(admission, { ownerId, admissionKey: 'local-admission', approved, jobId: job.jobId });
  assert.deepEqual(await repository.runTransaction(tx => tx.get('mandates', tuple(chainId, approved.job.mandateId))),
    { networkId: chainId, mandateId: approved.job.mandateId, ownerId, jobId: job.jobId });
  for (const networkId of ['test-chain-other', 'testnet', 'mainnet']) {
    await assert.rejects(admit(orders, approval(networkId)), { code: 'INVALID_APPROVAL' });
  }
  assert.equal(server.requests.length, 1, 'wrong approval chain rejected before status I/O');
  // Constructor snapshot is trusted config, never a mutable caller allowlist.
  trustedLocalChain.networkId = 'mainnet'; trustedLocalChain.rpcUrl = 'https://rpc.mainnet.near.org';
  assert.deepEqual(await admit(orders), job);
  assert.equal(server.requests.length, 2, 'replay independently rechecks pinned chain');
});

for (const localTestOnly of [undefined, false, 'true', 1]) {
  test(`Sandbox opt-in never bypasses strict LOCAL_TEST_ONLY (${String(localTestOnly)})`, () => {
    assert.throws(() => createOrders({ localTestOnly,
      trustedLocalChain: { networkId: chainId, rpcUrl: 'http://127.0.0.1:12345/' } }), { code: 'LOCAL_TEST_ONLY' });
  });
}

for (const [name, config] of [
  ['null config', null], ['missing endpoint', { networkId: chainId }],
  ['mainnet identity', { networkId: 'mainnet', rpcUrl: 'http://127.0.0.1:12345/' }],
  ['testnet identity', { networkId: 'testnet', rpcUrl: 'http://127.0.0.1:12345/' }],
  ['generic private chain', { networkId: 'private-chain', rpcUrl: 'http://127.0.0.1:12345/' }],
  ['public testnet endpoint', { networkId: chainId, rpcUrl: 'https://rpc.testnet.near.org' }],
  ['public mainnet endpoint', { networkId: chainId, rpcUrl: 'https://rpc.mainnet.near.org' }],
  ['remote HTTP endpoint', { networkId: chainId, rpcUrl: 'http://192.0.2.1:12345/' }],
  ['DNS localhost', { networkId: chainId, rpcUrl: 'http://localhost:12345/' }],
  ['integer loopback alias', { networkId: chainId, rpcUrl: 'http://2130706433:12345/' }],
  ['credentials', { networkId: chainId, rpcUrl: 'http://user:password@127.0.0.1:12345/' }],
  ['query', { networkId: chainId, rpcUrl: 'http://127.0.0.1:12345/?rpc=mainnet' }],
  ['fragment', { networkId: chainId, rpcUrl: 'http://127.0.0.1:12345/#mainnet' }],
  ['path', { networkId: chainId, rpcUrl: 'http://127.0.0.1:12345/mainnet' }],
  ['invalid port', { networkId: chainId, rpcUrl: 'http://127.0.0.1:99999/' }],
  ['chain trailing newline', { networkId: `${chainId}\n`, rpcUrl: 'http://127.0.0.1:12345/' }],
  ['endpoint trailing newline', { networkId: chainId, rpcUrl: 'http://127.0.0.1:12345/\n' }],
  ['extra allowlist', { networkId: chainId, rpcUrl: 'http://127.0.0.1:12345/', allowedNetworkIds: ['mainnet'] }],
]) test(`trusted local configuration refuses ${name} before I/O`, () => {
  assert.throws(() => createOrders({ localTestOnly: true, trustedLocalChain: config }), { code: 'LOCAL_CHAIN_CONFIGURATION_INVALID' });
});

for (const [name, status] of [
  ['different Sandbox', { chain_id: 'test-chain-other', sync_info: { syncing: false } }],
  ['mainnet', { chain_id: 'mainnet', sync_info: { syncing: false } }],
  ['testnet', { chain_id: 'testnet', sync_info: { syncing: false } }],
  ['absent chain', { sync_info: { syncing: false } }],
  ['syncing', { chain_id: chainId, sync_info: { syncing: true } }],
  ['missing sync evidence', { chain_id: chainId }],
]) test(`actual loopback status ${name} cannot admit or allocate records`, async t => {
  const server = await statusServer(t), repository = repo(t);
  let transactions = 0;
  const orders = createOrders({ repository: { runTransaction: fn => { transactions++; return repository.runTransaction(fn); } },
    localTestOnly: true, now, trustedLocalChain: { networkId: chainId, rpcUrl: server.rpcUrl } });
  server.setStatus(status);
  await assert.rejects(admit(orders), { code: 'LOCAL_CHAIN_MISMATCH' });
  assert.equal(server.requests.length, 1); assert.equal(transactions, 0);
  server.setStatus({ chain_id: chainId, sync_info: { syncing: false } });
  const job = await admit(orders);
  assert.deepEqual(await orders.getJob({ ownerId, jobId: job.jobId }), job);
  // Previously admitted records do not let a changed node identity pass replay.
  server.setStatus(status);
  const before = transactions;
  await assert.rejects(admit(orders), { code: 'LOCAL_CHAIN_MISMATCH' });
  assert.equal(transactions, before);
});

test('closed loopback status fails without reserving the admission key', async t => {
  const repository = repo(t);
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const rpcUrl = `http://127.0.0.1:${server.address().port}/`;
  await new Promise(resolve => server.close(resolve));
  let transactions = 0;
  const orders = createOrders({ repository: { runTransaction: fn => { transactions++; return repository.runTransaction(fn); } },
    localTestOnly: true, now, trustedLocalChain: { networkId: chainId, rpcUrl } });
  await assert.rejects(admit(orders), { code: 'LOCAL_CHAIN_UNAVAILABLE' });
  assert.equal(transactions, 0);
});
