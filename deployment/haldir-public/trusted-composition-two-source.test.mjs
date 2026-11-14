import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, baseEncode } from 'near-api-js';
import { createTrustedApprovalStore, approvalKey, APPROVAL_COLLECTION } from './trusted-composition.mjs';
import { createPublicOrders, openLocalRepository } from '../../src/server/orders.mjs';
import { approvedSources } from '../../src/shared/job-contract.mjs';

// Parent integration characterization: actual store/ordinary admission, synthetic
// immutable approvals and final-chain evidence. No RPC, credentials or activation.
const now = Date.parse('2026-11-13T14:00:00Z');
function fixture(two = true) {
  const ownerId = 'owner.testnet', approvalId = 'parent-composition';
  const job = { networkId: 'testnet', mandateId: 'mandate.testnet', purpose: 'Fictional supplier check',
    output: 'Evidence brief', budgetAtomic: '30', vendorIds: ['records.testnet', 'background.testnet'], expiresAt: '2099-01-01T00:00:00Z' };
  const sources = ['company-records', 'background-research'].map((sourceId, i) => ({ sourceId,
    quote: { networkId: job.networkId, mandateId: job.mandateId, vendorId: job.vendorIds[i],
      amountAtomic: i ? '9' : '8', orderId: `parent-source-${i}`, content: `Fictional source ${i}` } }));
  const approved = two ? { schemaVersion: 'haldir.approved.two-source.v1', job, sources } : { job, quote: sources[0].quote };
  const manifest = { manifestId: 'parent-manifest', ownerId, approved,
    binding: { ownerId, signerId: 'agent.testnet', mandateId: job.mandateId, networkId: 'testnet',
      publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString(), maxAllowanceAtomic: '1000',
      codeHash: baseEncode(new Uint8Array(32).fill(7)) },
    rpcUrl: 'https://rpc.testnet.near.org', allowedRpcUrls: ['https://rpc.testnet.near.org'] };
  return { schemaVersion: 'haldir.public.approval.v1', ownerId, approvalId, manifest };
}
function syntheticObserved(manifest) {
  return { ...manifest, chainEvidence: { networkId: 'testnet', finality: 'final',
    blockHash: baseEncode(new Uint8Array(32).fill(8)), blockHeight: 1, observedAt: now, deployment: 'MANDATE_READY' } };
}
for (const two of [false, true]) test(`existing trusted store supports exact immutable ${two ? 'two-source' : 'legacy'} approval without writes`, async t => {
  const row = fixture(two), calls = []; let writes = 0, transports = 0;
  t.mock.method(globalThis, 'fetch', async () => { transports++; throw new Error('DENIED'); });
  const store = createTrustedApprovalStore({ repository: { runTransaction: fn => fn({
    get: async (...args) => { calls.push(args); return row; }, create: () => { writes++; }, set: () => { writes++; },
  }) } });
  const subject = { ownerId: row.ownerId, approvalId: row.approvalId };
  const value = await store.get(subject);
  assert.deepEqual(value, row.manifest);
  assert.deepEqual(calls, [[APPROVAL_COLLECTION, approvalKey(subject)]]);
  assert.equal(approvedSources(value.approved).length, two ? 2 : 1);
  assert.ok(Object.isFrozen(value.approved.job));
  if (two) assert.ok(Object.isFrozen(value.approved.sources[1].quote));
  assert.equal(writes, 0); assert.equal(transports, 0);
});
test('trusted store feeds ordinary public two-source admission; replay keeps one job and both orders', async t => {
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => repository.close());
  let transports = 0;
  t.mock.method(globalThis, 'fetch', async () => { transports++; throw new Error('DENIED'); });
  const row = fixture(), subject = { ownerId: row.ownerId, approvalId: row.approvalId };
  await repository.runTransaction(tx => tx.create(APPROVAL_COLLECTION, approvalKey(subject), row));
  const store = createTrustedApprovalStore({ repository });
  const orders = createPublicOrders({ repository, now: () => now,
    trustedManifestProvider: async input => syntheticObserved(await store.get(input)) });
  const input = { ...subject, admissionKey: 'parent-same-job' };
  const job = await orders.createJob(input), replay = await orders.createJob(input);
  assert.deepEqual(replay, job);
  assert.equal(job.schemaVersion, 'haldir.job.two-source.v1');
  assert.equal(job.scope.budgetAtomic, '30');
  const members = await orders.getOrders({ ownerId: row.ownerId, jobId: job.jobId });
  assert.deepEqual(members.map(m => m.sourceId), ['company-records', 'background-research']);
  assert.equal(new Set(members.map(m => m.order.jobId)).size, 1);
  assert.equal(new Set(members.map(m => m.order.quoteId)).size, 2);
  assert.ok(members.every(m => m.order.proof === null && m.order.artifact === null));
  assert.equal(await repository.runTransaction(tx => tx.get('nativeOperations', job.quoteId)), null);
  assert.equal(transports, 0);
});
test('manifest validation rejects malformed stored second source before admission writes', async t => {
  const row = fixture(); row.manifest.approved.sources[1].quote.amountAtomic = '31';
  let writes = 0;
  const repository = { runTransaction: fn => fn({ get: async () => row,
    create: () => { writes++; }, set: () => { writes++; } }) };
  const store = createTrustedApprovalStore({ repository });
  const orders = createPublicOrders({ repository, now: () => now,
    trustedManifestProvider: async input => syntheticObserved(await store.get(input)) });
  await assert.rejects(orders.createJob({ ownerId: row.ownerId, approvalId: row.approvalId, admissionKey: 'bad' }),
    { code: 'INVALID_APPROVAL' });
  assert.equal(writes, 0);
});
