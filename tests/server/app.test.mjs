import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createOrders, openLocalRepository } from '../../src/server/orders.mjs';
import { createLocalApp } from '../../src/server/app.mjs';
import { syntheticPayment } from '../../src/vendor/fixture.mjs';

const approved = {
  job: { networkId: 'testnet', mandateId: 'http-job.testnet', purpose: 'Local HTTP sample', output: 'Fictional artifact',
    budgetAtomic: '3000000000000000000000000', vendorIds: ['vendor.testnet'], expiresAt: '2026-11-13T12:00:00Z' },
  quote: { networkId: 'testnet', mandateId: 'http-job.testnet', vendorId: 'vendor.testnet',
    amountAtomic: '3000000000000000000000000', orderId: 'http-quote', content: 'Northwind fictional sample' },
};
async function start(t) {
  const dir = await mkdtemp(join(tmpdir(), 'haldir-http-'));
  const repository = openLocalRepository({ filename: join(dir, 'http.sqlite'), localTestOnly: true });
  let collections = 0, approvals = 0;
  const orders = createOrders({ repository, localTestOnly: true, now: () => Date.parse('2026-11-12T12:00:00Z'),
    trustedReceiptCollector: ({ quote }) => { collections++; return syntheticPayment(quote).evidence; } });
  const app = createLocalApp({ localTestOnly: true, orders,
    testOnlySession: req => ({ 'test-alice': 'alice.testnet', 'test-bob': 'bob.testnet' })[req.headers['x-test-session']] ?? null,
    trustedApprovalLookup: ({ ownerId, approvalId }) => { approvals++; return ownerId === 'alice.testnet' && approvalId === 'approved-1' ? structuredClone(approved) : null; } });
  const { origin } = await app.listen();
  t.after(async () => { await app.close(); repository.close(); await rm(dir, { recursive: true, force: true }); });
  async function request(path, { method = 'GET', body, session = 'test-alice', headers = {} } = {}) {
    assert.equal(new URL(origin + path).hostname, '127.0.0.1');
    if (headers.host) {
      // fetch ignores a forbidden Host override; use actual HTTP for rebinding.
      return new Promise((resolve, reject) => {
        const req = httpRequest(origin + path, { method, headers: { 'x-test-session': session,
          'content-type': 'application/json', ...headers } }, res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)), headers: new Headers(res.headers) }));
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    }
    const res = await fetch(origin + path, { method,
      headers: { 'x-test-session': session, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  return { app, orders, request, counts: () => ({ collections, approvals }), origin };
}

test('real loopback HTTP admits trusted scope, reads committed identities, independently checks payment and retrieves same artifact', async t => {
  const { request, counts } = await start(t);
  const admitted = await request('/api/jobs', { method: 'POST', body: { approvalId: 'approved-1', admissionKey: 'request-1' } });
  assert.equal(admitted.status, 201);
  assert.equal(admitted.body.qualification, 'LOCAL_SYNTHETIC_ONLY');
  const path = `/api/jobs/${admitted.body.jobId}`;
  assert.deepEqual((await request(path)).body, admitted.body);
  const pending = await request(`${path}/order`);
  assert.equal(pending.body.lifecycle, 'PAYMENT_PENDING');
  const paid = await request(`${path}/order/check`, { method: 'POST', body: {} });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.lifecycle, 'PAID_NOT_DELIVERED');
  assert.equal(paid.body.artifact, null);
  const delivered = await request(`${path}/order/delivery`, { method: 'POST', body: {} });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.artifact.fictionalSample, true);
  assert.deepEqual((await request(`${path}/order/delivery`, { method: 'POST', body: {} })).body, delivered.body);
  assert.deepEqual((await request(`${path}/order/check`, { method: 'POST', body: {} })).body, delivered.body);
  assert.deepEqual(counts(), { collections: 1, approvals: 1 });
  for (const suffix of ['', '/order', '/order/check', '/order/delivery']) {
    const mutation = suffix === '/order/check' || suffix === '/order/delivery';
    assert.equal((await request(path + suffix, { session: 'test-bob', ...(mutation ? { method: 'POST', body: {} } : {}) })).status, 404);
  }
  assert.deepEqual(counts(), { collections: 1, approvals: 1 });
});

test('HTTP rejects browser authority, missing sessions, cross-origin requests and financial/debug endpoints before collectors', async t => {
  const { request, counts, origin } = await start(t);
  assert.equal((await request('/api/jobs', { method: 'POST', session: '', body: { approvalId: 'approved-1', admissionKey: 'request-1' } })).status, 401);
  for (const extra of [{ ownerId: 'alice.testnet' }, { paid: true }, { proof: syntheticPayment(approved.quote).evidence }, { approved }]) {
    assert.equal((await request('/api/jobs', { method: 'POST', body: { approvalId: 'approved-1', admissionKey: 'request-1', ...extra } })).status, 400);
  }
  assert.equal((await request('/api/jobs', { method: 'POST', session: 'test-bob', body: { approvalId: 'approved-1', admissionKey: 'request-1' } })).status, 403);
  assert.equal((await request('/api/jobs', { method: 'POST', headers: { origin: 'https://foreign.invalid' }, body: { approvalId: 'approved-1', admissionKey: 'request-1' } })).status, 403);
  assert.equal((await request('/api/jobs', { method: 'POST', headers: { host: 'foreign.invalid' }, body: { approvalId: 'approved-1', admissionKey: 'request-1' } })).status, 403);
  assert.equal((await request('/api/jobs', { method: 'POST', body: { approvalId: 'x'.repeat(65536), admissionKey: 'request-1' } })).status, 413);
  for (const path of ['/api/pay', '/api/keys', '/internal/tick', '/debug', '/api/jobs/pay']) {
    assert.equal((await request(path, { method: 'POST', body: {} })).status, 404);
  }
  assert.equal(counts().collections, 0);
  const created = await request('/api/jobs', { method: 'POST', headers: { origin }, body: { approvalId: 'approved-1', admissionKey: 'request-1' } });
  assert.equal(created.status, 201);
  const path = `/api/jobs/${created.body.jobId}/order`;
  for (const suffix of ['/check', '/delivery']) {
    assert.equal((await request(path + suffix, { method: 'POST', body: { paid: true, proof: {} } })).status, 400);
  }
  assert.equal(counts().collections, 0);
  assert.equal((await request(path)).body.lifecycle, 'PAYMENT_PENDING');
  assert.equal(created.headers.get('access-control-allow-origin'), null);
  assert.equal(created.headers.get('cache-control'), 'no-store');
});

test('startup requires explicit LOCAL opt-in and injected test identity/approved-scope authority', () => {
  assert.throws(() => createLocalApp({}), /LOCAL_TEST_ONLY/);
  assert.throws(() => createLocalApp({ localTestOnly: true }), /TEST_SESSION_REQUIRED/);
  assert.throws(() => createLocalApp({ localTestOnly: true, testOnlySession: () => null }), /TRUSTED_APPROVAL_LOOKUP_REQUIRED/);
});

for (const host of ['0.0.0.0', '::', 'localhost', '192.0.2.1']) {
  test(`listener denies nonliteral-loopback binding ${host}`, async t => {
    const app = createLocalApp({ localTestOnly: true, testOnlySession: () => null,
      trustedApprovalLookup: () => null, orders: {} });
    t.after(() => app.close());
    await assert.rejects(app.listen({ host }), /LOOPBACK_ONLY/);
  });
}
