import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, baseEncode } from 'near-api-js';
import { createNearAiRunnerPort } from './near-ai-runner-port.mjs';
import { createPublicOrders, openLocalRepository } from '../../src/server/orders.mjs';
import { approvedInput, approvedSources } from '../../src/shared/job-contract.mjs';
import { syntheticPayment } from '../../src/vendor/fixture.mjs';

// Offline component qualification. Actual public admission/default budget and
// facade validation; synthetic transport receipt, not hosted/provider proof.
async function fixture(t, { unknown = false } = {}) {
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => repository.close());
  const now = () => Date.parse('2026-11-13T10:00:00Z');
  const scope = { networkId: 'testnet', mandateId: 'cache.testnet', purpose: 'Compare fictional samples', output: 'Evidence brief',
    budgetAtomic: '30', vendorIds: ['records.testnet', 'research.testnet'], expiresAt: '2026-11-13T18:00:00Z' };
  const approved = { schemaVersion: 'haldir.approved.two-source.v1', job: scope,
    sources: scope.vendorIds.map((vendorId, i) => ({ sourceId: ['company-records', 'background-research'][i],
      quote: { networkId: scope.networkId, mandateId: scope.mandateId, vendorId, amountAtomic: '8', orderId: `cache-${i}`, content: `Fictional source ${i}` } })) };
  const hash = baseEncode(new Uint8Array(32).fill(7));
  const manifest = { manifestId: 'cache-approved', ownerId: 'alice.testnet', approved,
    binding: { networkId: 'testnet', ownerId: 'alice.testnet', signerId: 'agent.testnet', mandateId: scope.mandateId,
      publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString(), maxAllowanceAtomic: '1000', codeHash: hash },
    rpcUrl: 'https://closed.invalid', allowedRpcUrls: ['https://closed.invalid'],
    chainEvidence: { networkId: 'testnet', finality: 'final', blockHash: hash, blockHeight: 123, observedAt: now() } };
  const sources = approvedSources(approved);
  const orders = createPublicOrders({ repository, now, trustedManifestProvider: async () => manifest,
    trustedReceiptCollector: async ({ quote }) => syntheticPayment(quote, quote.orderId === 'cache-0' ? 11 : 31).evidence });
  const job = await orders.createJob({ ownerId: manifest.ownerId, admissionKey: 'cache', approvalId: manifest.manifestId });
  const plan = { phase: 'plan', approvedJobInput: approvedInput(job), approvedSources: sources,
    tools: [{ name: 'requestquotes', approvedSources: sources }] };
  const counts = { transports: 0, inference: 0, writes: 0 };
  const observed = { runTransaction: cb => repository.runTransaction(tx => cb({ ...tx,
    create(c, k, v) { counts.writes++; return tx.create(c, k, v); },
    set(c, k, v) { counts.writes++; return tx.set(c, k, v); },
  })) };
  const options = { repository: observed, apiKey: 'CLOSED_CACHE_KEY_ONLY', authorizationExpiresAt: '2026-11-16T23:59:00Z', now,
    transportFactory: () => {
      counts.transports++; let receipt;
      return { transport: async (_url, init) => {
        counts.inference++; if (unknown) throw new Error('accepted response lost');
        const body = JSON.parse(init.body), input = JSON.parse(body.messages[1].content);
        const result = input.phase === 'plan' ? { tool: 'requestquotes', arguments: { quoteIds: sources.map(s => s.quoteId) } }
          : { findings: input.evidence.map(a => ({ artifactId: a.artifactId, excerpt: a.content.slice(0, 50) })), interpretations: [] };
        receipt = { id: 'closed-cache-result', signatureKind: 'provider_tee', model: body.model, sdkVersion: '0.3.0', httpStatus: 200,
          e2ee: true, usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }, reasoningTokens: 0, signatureLookups: 1 };
        return Response.json({ model: body.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }], usage: receipt.usage });
      }, getReceipt: () => receipt, drain: async () => {} };
    } };
  const model = () => createNearAiRunnerPort(options);
  const rows = () => repository.runTransaction(async tx => {
    // Exact known identities are obtained from the actual budget's accessor.
    const { publicModelReservationKey } = await import('../../src/server/public-journey.mjs');
    const { createHash } = await import('node:crypto');
    const id = createHash('sha256').update(JSON.stringify(['haldir-near-ai-v1', job.ownerId, job.jobId])).digest('hex');
    return Promise.all(['plan', 'report'].map(async phase => { const key = publicModelReservationKey(id, job.jobId, phase); return { key, value: await tx.get('modelReservations', key) }; }));
  });
  const report = async () => {
    for (const source of sources) { await orders.checkPayment({ ownerId: job.ownerId, jobId: job.jobId, quoteId: source.quoteId }); await orders.retrieveDelivery({ ownerId: job.ownerId, jobId: job.jobId, quoteId: source.quoteId }); }
    const members = await orders.getOrders({ ownerId: job.ownerId, jobId: job.jobId });
    return { phase: 'report', approvedJobInput: approvedInput(job), evidence: members.map(m => m.order.artifact), tools: [] };
  };
  return { repository, model, counts, job, sources, plan, rows, report, options };
}

async function closedRecovery(f, input) {
  const before = { ...f.counts }, rows = await f.rows();
  await assert.rejects(f.model().recover(input), { code: 'MODEL_CACHE_UNAVAILABLE' });
  assert.deepEqual(f.counts, before, 'recovery neither writes nor constructs/invokes normal transport');
  assert.deepEqual(await f.rows(), rows);
}

test('cache-only absence does not consume admission or masquerade as MODEL_NOT_SENT', async t => {
  const f = await fixture(t);
  assert.equal(f.model().contractVersion, 'haldir.model.runner-recovery.v1');
  await closedRecovery(f, f.plan);
  assert.ok((await f.rows()).every(r => r.value === null));
  await f.model().propose(f.plan); assert.equal(f.counts.inference, 1);
});

test('actual consumed unknown remains unavailable with zero recovery writes or transport', async t => {
  const f = await fixture(t, { unknown: true });
  await assert.rejects(f.model().propose(f.plan), { code: 'MODEL_UNAVAILABLE' });
  assert.equal((await f.rows())[0].value.state, 'RESERVED_NO_AUTOMATIC_REFUND');
  await closedRecovery(f, f.plan); assert.equal(f.counts.inference, 1);
});

for (const phase of ['plan', 'report']) test(`cache-only ${phase} returns the actual validated persisted result after expiry`, async t => {
  const f = await fixture(t), input = phase === 'plan' ? f.plan : await f.report();
  const result = await f.model().propose(input), before = { ...f.counts };
  f.options.now = () => Date.parse('2026-11-17T00:00:00Z');
  assert.deepEqual(await f.model().recover(input), result); assert.deepEqual(f.counts, before);
});

for (const [name, mutate] of [
  ['unknown state', (f, input, row) => { row.value.state = 'UNKNOWN'; }],
  ['malformed row', (f, input, row) => { row.value = { state: 'COMPLETED_VERIFIED' }; }],
  ['wrong row owner', (f, input, row) => { row.value.ownerId = 'bob.testnet'; }],
  ['wrong row job', (f, input, row) => { row.value.jobId = 'other-job'; }],
  ['wrong digest', (f, input, row) => { row.value.requestDigest = '0'.repeat(64); }],
  ['forged result', (f, input, row) => { row.value.result.arguments.quoteIds.reverse(); }],
  ['unverified receipt', (f, input, row) => { row.value.verification.signatureKind = 'gateway'; }],
  ['wrong input owner', (f, input) => { input.approvedJobInput.ownerId = 'bob.testnet'; }],
  ['wrong source tuple', (f, input) => { input.approvedSources.reverse(); }],
  ['changed second source', async f => { await f.repository.runTransaction(async tx => { const s = f.sources[1], q = await tx.get('quotes', s.quoteId); q.quote.amountAtomic = '9'; tx.set('quotes', s.quoteId, q); }); }],
]) test(`cache-only rejects ${name} without admission or transport`, async t => {
  const f = await fixture(t); await f.model().propose(f.plan);
  const input = structuredClone(f.plan), row = (await f.rows())[0];
  await mutate(f, input, row);
  await f.repository.runTransaction(tx => tx.set('modelReservations', row.key, row.value));
  await closedRecovery(f, input);
});

test('cache-only report revalidates persisted artifact digest and delivery bindings', async t => {
  const f = await fixture(t), input = await f.report(); await f.model().propose(input);
  await f.repository.runTransaction(async tx => {
    const key = f.sources[1].quoteId, order = await tx.get('orders', key), delivery = await tx.get('deliveries', key);
    order.artifact.content = 'forged'; delivery.artifact = order.artifact;
    tx.set('orders', key, order); tx.set('deliveries', key, delivery);
  });
  await closedRecovery(f, input);
});

test('cache-only pre-abort never publishes a saved result or constructs transport', async t => {
  const f = await fixture(t); await f.model().propose(f.plan);
  const controller = new AbortController(); controller.abort();
  await closedRecovery(f, { ...f.plan, signal: controller.signal });
});
