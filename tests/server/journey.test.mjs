import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syntheticPayment } from '../../src/vendor/fixture.mjs';
import { verifyPaymentProof } from '../../src/vendor/payment-proof.mjs';
import { createOrders, openLocalRepository } from '../../src/server/orders.mjs';

const alice = 'alice.testnet', bob = 'bob.testnet';
const now = () => Date.parse('2026-11-12T12:00:00Z');
function approval(orderId = 'quote-1', mandateId = 'job.testnet') {
  const job = { networkId: 'testnet', mandateId, purpose: 'Supplier verification sample',
    output: 'Fictional supplier artifact', budgetAtomic: '3000000000000000000000000',
    vendorIds: ['vendor.testnet'], expiresAt: '2026-11-13T12:00:00Z' };
  const quote = { networkId: job.networkId, mandateId, vendorId: job.vendorIds[0],
    amountAtomic: job.budgetAtomic, orderId, content: 'Northwind fictional sample' };
  return { job, quote };
}
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'haldir-orders-'));
  const filename = join(dir, 'journey.sqlite');
  const repository = openLocalRepository({ filename, localTestOnly: true });
  t.after(async () => { repository.close(); await rm(dir, { recursive: true, force: true }); });
  const orders = createOrders({ repository, localTestOnly: true, now, ...options });
  return { orders, repository, filename };
}
const create = (orders, approved = approval(), admissionKey = 'request-1', ownerId = alice) =>
  orders.createJob({ ownerId, admissionKey, approved });

test('approved scoped admission freezes durable job/quote/order and same-key replay returns the same identity', async t => {
  const { orders } = await setup(t);
  const approved = approval();
  const first = await create(orders, approved);
  assert.ok(first?.jobId, 'admission must return committed job identity');
  assert.equal(first.qualification, 'LOCAL_SYNTHETIC_ONLY');
  assert.deepEqual(first.scope, approved.job);
  approved.job.purpose = 'mutated caller object';
  assert.deepEqual(await orders.getJob({ ownerId: alice, jobId: first.jobId }), first);
  assert.deepEqual(await create(orders), first);
  const order = await orders.getOrder({ ownerId: alice, jobId: first.jobId });
  assert.equal(order.jobId, first.jobId);
  assert.equal(order.orderId, 'quote-1');
  assert.equal(order.lifecycle, 'PAYMENT_PENDING');
  assert.equal(order.proof, null);
  assert.equal(order.artifact, null);
  await assert.rejects(create(orders, approval('changed')), e => e.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(create(orders, approval(), 'other-key'), e => e.code === 'ORDER_ALREADY_BOUND');
  await assert.rejects(orders.getJob({ ownerId: bob, jobId: first.jobId }), e => e.code === 'NOT_FOUND');
  await assert.rejects(orders.getOrder({ ownerId: bob, jobId: first.jobId }), e => e.code === 'NOT_FOUND');
});

test('trusted receipt collection is independently verified and atomically claims payment plus missing-delivery pointer', async t => {
  let collections = 0;
  const approved = approval();
  const evidence = syntheticPayment(approved.quote).evidence;
  const { orders, repository } = await setup(t, { trustedReceiptCollector: async input => {
    collections++;
    assert.deepEqual(input.quote, approved.quote);
    return evidence;
  } });
  const job = await create(orders);
  const input = { ownerId: alice, jobId: job.jobId };
  const paid = await orders.checkPayment(input);
  assert.equal(paid.lifecycle, 'PAID_NOT_DELIVERED');
  assert.deepEqual(paid.proof, verifyPaymentProof(approved.quote, evidence));
  assert.equal(paid.artifact, null);
  const claim = await repository.runTransaction(tx => tx.get('claims', paid.proof.proofId));
  assert.equal(claim.quoteId, job.quoteId);
  assert.equal(claim.jobId, job.jobId);
  const delivery = await repository.runTransaction(tx => tx.get('deliveries', job.quoteId));
  assert.equal(delivery.artifact, null);
  assert.equal(delivery.quoteId, job.quoteId);
  assert.deepEqual(await orders.checkPayment(input), paid);
  assert.equal(collections, 1, 'paid check must not re-collect or invoke payment');
  await assert.rejects(orders.checkPayment({ ...input, ownerId: bob }), e => e.code === 'NOT_FOUND');
  assert.equal(collections, 1, 'foreign owner never reaches trusted evidence collector');
});

test('same synthetic transfer receipt cannot serve a different frozen quote', async t => {
  const { orders } = await setup(t, { trustedReceiptCollector: async ({ quote }) => syntheticPayment(quote).evidence });
  const first = await create(orders);
  const second = await create(orders, approval('quote-2', 'second.testnet'), 'request-2', bob);
  // Deliberately inconsistent trusted-source fixture: each graph validates alone,
  // but both assert the SAME receipt ID. Durable uniqueness must catch this.
  const p1 = verifyPaymentProof(approval().quote, syntheticPayment(approval().quote).evidence);
  const q2 = approval('quote-2', 'second.testnet').quote;
  assert.equal(verifyPaymentProof(q2, syntheticPayment(q2).evidence).proofId, p1.proofId);
  await orders.checkPayment({ ownerId: alice, jobId: first.jobId });
  await assert.rejects(orders.checkPayment({ ownerId: bob, jobId: second.jobId }), e => e.code === 'PROOF_ALREADY_CLAIMED');
  const rejected = await orders.getOrder({ ownerId: bob, jobId: second.jobId });
  assert.equal(rejected.lifecycle, 'PAYMENT_PENDING');
  assert.equal(rejected.proof, null);
  assert.equal(rejected.artifact, null);
});

test('a pending mandate cannot be rebound to a fresh job/order or a different owner', async t => {
  const { orders } = await setup(t);
  const original = await create(orders);
  const before = await orders.getOrder({ ownerId: alice, jobId: original.jobId });
  await assert.rejects(create(orders, approval('quote-2'), 'request-2'), e => e.code === 'MANDATE_ALREADY_BOUND');
  await assert.rejects(create(orders, approval('quote-3'), 'request-3', bob), e => e.code === 'MANDATE_ALREADY_BOUND');
  assert.deepEqual(await orders.getOrder({ ownerId: alice, jobId: original.jobId }), before);
});

test('local stop is persisted without claiming chain stop, and an older pending payment can still reconcile', async t => {
  const { orders } = await setup(t, { trustedReceiptCollector: ({ quote }) => syntheticPayment(quote).evidence });
  const job = await create(orders);
  const input = { ownerId: alice, jobId: job.jobId };
  const stopped = await orders.stopLocalJob(input);
  assert.equal(stopped.state, 'LOCAL_STOPPED');
  assert.equal(stopped.qualification, 'LOCAL_SYNTHETIC_ONLY');
  assert.deepEqual(await orders.getJob(input), stopped);
  assert.equal((await orders.checkPayment(input)).lifecycle, 'PAID_NOT_DELIVERED');
});

test('delivery requires a claimed proof and returns the identical fictional artifact after local stop without recollection or payment', async t => {
  let collections = 0, payments = 0;
  const { orders } = await setup(t, { trustedReceiptCollector: ({ quote }) => { collections++; return syntheticPayment(quote).evidence; },
    pay: () => { payments++; throw new Error('not authorized'); } });
  const job = await create(orders);
  const input = { ownerId: alice, jobId: job.jobId };
  await assert.rejects(orders.retrieveDelivery(input), e => e.code === 'PAYMENT_NOT_VERIFIED');
  const paid = await orders.checkPayment(input);
  await orders.stopLocalJob(input);
  const delivered = await orders.retrieveDelivery(input);
  assert.equal(delivered.lifecycle, 'DELIVERED');
  assert.equal(delivered.artifact.fictionalSample, true);
  assert.equal(delivered.artifact.orderId, paid.orderId);
  assert.deepEqual(delivered.proof, paid.proof);
  assert.deepEqual(await orders.retrieveDelivery(input), delivered);
  assert.deepEqual(await orders.checkPayment(input), delivered);
  assert.equal(collections, 1);
  assert.equal(payments, 0);
  await assert.rejects(orders.retrieveDelivery({ ...input, ownerId: bob }), e => e.code === 'NOT_FOUND');
});

test('claim/order/delivery commit failure rolls back actual SQL writes and same-proof retry recovers', async t => {
  const { repository } = await setup(t);
  await repository.runTransaction(tx => tx.create('rollbackSentinels', 'existing', { present: true }));
  let fault = true;
  const injected = { runTransaction: callback => repository.runTransaction(tx => callback({
    ...tx,
    set(collection, key, value) {
      tx.set(collection, key, value);
      if (fault && collection === 'orders' && value.proof) {
        // Applied last at SQL commit, after claim+pointer+order writes. Existing
        // exact-key create forces rollback of the ENTIRE real DB transaction.
        tx.create('rollbackSentinels', 'existing', {});
      }
    },
  })) };
  const orders = createOrders({ repository: injected, localTestOnly: true, now,
    trustedReceiptCollector: ({ quote }) => syntheticPayment(quote).evidence });
  const job = await create(orders);
  const input = { ownerId: alice, jobId: job.jobId };
  const before = await orders.getOrder(input);
  await assert.rejects(orders.checkPayment(input), /already exists/);
  const proof = verifyPaymentProof(approval().quote, syntheticPayment(approval().quote).evidence);
  assert.equal(await repository.runTransaction(tx => tx.get('claims', proof.proofId)), null);
  assert.equal(await repository.runTransaction(tx => tx.get('deliveries', job.quoteId)), null);
  assert.deepEqual(await orders.getOrder(input), before);
  await assert.rejects(orders.retrieveDelivery(input), e => e.code === 'PAYMENT_NOT_VERIFIED');
  fault = false;
  assert.equal((await orders.checkPayment(input)).lifecycle, 'PAID_NOT_DELIVERED');
  assert.equal((await orders.retrieveDelivery(input)).lifecycle, 'DELIVERED');
});

test('separate SQLite connections serialize concurrent admission and competing receipt claims', async t => {
  const { orders: first, filename } = await setup(t, { trustedReceiptCollector: ({ quote }) => syntheticPayment(quote).evidence });
  const secondRepo = openLocalRepository({ filename, localTestOnly: true });
  t.after(() => secondRepo.close());
  const second = createOrders({ repository: secondRepo, localTestOnly: true, now,
    trustedReceiptCollector: ({ quote }) => syntheticPayment(quote).evidence });
  const [a, replay] = await Promise.all([create(first), create(second)]);
  assert.deepEqual(a, replay);
  const b = await create(second, approval('other-quote', 'other-job.testnet'), 'request-b', bob);
  const results = await Promise.allSettled([
    first.checkPayment({ ownerId: alice, jobId: a.jobId }),
    second.checkPayment({ ownerId: bob, jobId: b.jobId }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'PROOF_ALREADY_CLAIMED');
});

test('transaction callbacks can be replayed after rollback without changing admission/proof/artifact identity', async t => {
  const { repository } = await setup(t);
  const replay = new Error('test retry after rollback');
  const retrying = { async runTransaction(callback) {
    await assert.rejects(repository.runTransaction(async tx => { await callback(tx); throw replay; }), e => e === replay);
    return repository.runTransaction(callback);
  } };
  let collections = 0;
  const orders = createOrders({ repository: retrying, localTestOnly: true, now,
    trustedReceiptCollector: ({ quote }) => { collections++; return syntheticPayment(quote).evidence; } });
  const job = await create(orders);
  const input = { ownerId: alice, jobId: job.jobId };
  assert.deepEqual(await create(orders), job);
  assert.equal((await orders.checkPayment(input)).lifecycle, 'PAID_NOT_DELIVERED');
  const delivered = await orders.retrieveDelivery(input);
  assert.equal(delivered.lifecycle, 'DELIVERED');
  assert.deepEqual(await orders.retrieveDelivery(input), delivered);
  assert.equal(collections, 1, 'no collector/network/payment effect in retryable callbacks');
});

for (const [name, collect, code] of [
  ['unknown', () => null, 'EVIDENCE_UNAVAILABLE'],
  ['collector outage', () => { throw new Error('unavailable'); }, 'COLLECTOR_UNAVAILABLE'],
  ['browser-style paid state', () => ({ paid: true }), 'NETWORK_MISMATCH'],
  ['incomplete receipt evidence', q => { const e = syntheticPayment(q).evidence; delete e.receipts; return e; }, 'MISSING_ACTION_EVIDENCE'],
  ['nonfinal payment', q => { const e = syntheticPayment(q).evidence; e.finalTransaction.final_execution_status = 'EXECUTED'; return e; }, 'NOT_FINAL'],
  ['wrong amount', q => syntheticPayment({ ...q, amountAtomic: '1' }).evidence, 'PAY_CALL_MISMATCH'],
  ['wrong recipient', q => syntheticPayment({ ...q, vendorId: 'other.testnet' }).evidence, 'PAY_CALL_MISMATCH'],
  ['wrong network', q => syntheticPayment({ ...q, networkId: 'mainnet' }).evidence, 'NETWORK_MISMATCH'],
]) test(`payment ${name} retains pending original order, never grants delivery or authorizes a fresh payment`, async t => {
  let collections = 0, payments = 0;
  const { orders, repository } = await setup(t, { trustedReceiptCollector: ({ quote }) => { collections++; return collect(quote); },
    pay: () => { payments++; throw new Error('payment must never run'); } });
  const job = await create(orders);
  const input = { ownerId: alice, jobId: job.jobId };
  const before = await orders.getOrder(input);
  let pending;
  await assert.doesNotReject(async () => { pending = await orders.checkPayment(input); });
  assert.deepEqual(pending, { ...before, lastCheckCode: code });
  assert.deepEqual(await orders.getOrder(input), pending);
  await orders.checkPayment(input);
  assert.equal(collections, 2, 'only explicit safe read retry, no background loop');
  assert.equal(payments, 0);
  assert.deepEqual(await create(orders), job);
  assert.equal(await repository.runTransaction(tx => tx.get('deliveries', job.quoteId)), null);
  assert.equal(pending.proof, null);
});

for (const [name, mutate] of [
  ['wrong network', a => { a.quote.networkId = 'mainnet'; }],
  ['unbound mandate', a => { a.quote.mandateId = 'other.testnet'; }],
  ['disallowed recipient', a => { a.quote.vendorId = 'other.testnet'; }],
  ['over budget', a => { a.quote.amountAtomic = '3000000000000000000000001'; }],
  ['noncanonical amount', a => { a.quote.amountAtomic = '01'; }],
  ['expired scope', a => { a.job.expiresAt = '2026-11-12T11:59:59Z'; }],
  ['invalid calendar expiry', a => { a.job.expiresAt = '2026-11-31T12:00:00Z'; }],
  ['invalid order identifier', a => { a.quote.orderId = 'bad/order'; }],
  ['amount with trailing newline', a => { a.quote.amountAtomic = '1\n'; }],
  ['order identifier with trailing newline', a => { a.quote.orderId = 'quote-1\n'; }],
  ['mandate with trailing newline', a => { a.job.mandateId = a.quote.mandateId = 'job.testnet\n'; }],
  ['browser-style paid authority', a => { a.quote.paid = true; }],
]) test(`admission refuses ${name} before allocating an identity`, async t => {
  const { orders } = await setup(t);
  const invalid = approval(); mutate(invalid);
  await assert.rejects(create(orders, invalid), e => e.code === 'INVALID_APPROVAL');
  assert.ok((await create(orders)).jobId, 'same admission key remains usable for valid approved scope');
});
