import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, PublicKey, createTransaction, actions, baseEncode } from 'near-api-js';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import * as trusted from './trusted-composition.mjs';
import { createPublicOrders, openLocalRepository } from '../../src/server/orders.mjs';
import { approvedSources, approvedInput } from '../../src/shared/job-contract.mjs';
import { createHash } from 'node:crypto';
import { createNearAiTransport } from './near-ai-transport.mjs';
import { verifiedCompletion } from './near-ai-worker.mjs';
import { NEAR_AI_RELEASE } from './near-ai-policy.mjs';
import { publicModelReservationKey } from '../../src/server/public-journey.mjs';

const clock = Date.parse('2026-11-13T14:00:00Z');
async function fixture(t, options = {}) {
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => repository.close());
  let forbidden = 0, resolutions = 0, readonlyWrites = 0, validation = false, replays = 0;
  const deny = () => { forbidden++; throw new Error('NO_EXTERNAL_TRANSPORT'); };
  for (const [o, keys] of [[globalThis, ['fetch']], [http, ['request', 'get']], [https, ['request', 'get']],
    [net.Socket.prototype, ['connect']], [tls, ['connect']]]) for (const key of keys) t.mock.method(o, key, deny);
  t.after(() => assert.equal(forbidden, 0));
  const key = KeyPair.fromRandom('ed25519'), ownerId = 'owner.testnet', approvalId = 'operator-approval-not-manifest-id';
  const job = { networkId: 'testnet', mandateId: 'mandate.testnet', purpose: 'Fictional due diligence', output: 'Evidence brief',
    budgetAtomic: '30', vendorIds: ['records.testnet', 'background.testnet'], expiresAt: '2099-01-01T00:00:00Z' };
  const sources = job.vendorIds.map((vendorId, i) => ({ sourceId: ['company-records', 'background-research'][i],
    quote: { networkId: 'testnet', mandateId: job.mandateId, vendorId, amountAtomic: String(8 + i), orderId: `source-${i}`, content: `Fictional ${i}` } }));
  const manifest = { manifestId: 'immutable-manifest', ownerId,
    approved: options.legacy ? { job, quote: sources[0].quote } : { schemaVersion: 'haldir.approved.two-source.v1', job, sources },
    binding: { ownerId, signerId: 'agent.testnet', mandateId: job.mandateId, networkId: 'testnet', publicKey: key.getPublicKey().toString(),
      maxAllowanceAtomic: '1000', codeHash: baseEncode(new Uint8Array(32).fill(7)) },
    rpcUrl: 'https://rpc.testnet.near.org', allowedRpcUrls: ['https://rpc.testnet.near.org'] };
  const binding = { ownerId, approvalId, manifestId: manifest.manifestId, publicKey: manifest.binding.publicKey, keyVersion: 'synthetic-immutable-v1' };
  const wrapper = { runTransaction: fn => repository.runTransaction(async tx => {
    const readonly = { get: (...args) => tx.get(...args), create() { readonlyWrites++; assert.fail('signer callback wrote'); }, set() { readonlyWrites++; assert.fail('signer callback wrote'); } };
    if (validation && options.replay) { await fn(readonly); replays++; }
    return fn(validation ? readonly : tx);
  }) };
  const resolveKeyMaterial = async input => {
    resolutions++; assert.deepEqual(Object.keys(input).sort(), ['keyVersion', 'signal']);
    assert.equal(input.keyVersion, 'synthetic-immutable-v1'); assert.ok(input.signal instanceof AbortSignal);
    return options.resolve ? options.resolve(input, key) : key.toString();
  };
  const qualification = { signingBindings: [binding], resolveKeyMaterial,
    model: { apiKey: 'synthetic-not-provider-key', authorizationExpiresAt: '2099-01-01T00:00:00Z',
      transportFactory: () => { throw new Error('MODEL_TRANSPORT_NOT_REQUESTED'); } } };
  await repository.runTransaction(tx => tx.create(trusted.APPROVAL_COLLECTION, trusted.approvalKey({ ownerId, approvalId }),
    { schemaVersion: 'haldir.public.approval.v1', ownerId, approvalId, manifest }));
  const observed = { ...manifest, chainEvidence: { networkId: 'testnet', finality: 'final', blockHash: baseEncode(new Uint8Array(32).fill(8)),
    blockHeight: 1, observedAt: clock, deployment: 'MANDATE_READY' } };
  const orders = createPublicOrders({ repository, now: () => clock, trustedManifestProvider: async () => structuredClone(observed) });
  const admit = async () => {
    const admitted = await orders.createJob({ ownerId, approvalId, admissionKey: 'ordinary-new-job' });
    assert.equal(admitted.approvalId, undefined); validation = true;
    return { ownerId, jobId: admitted.jobId, manifest: admitted.publicManifest, signal: new AbortController().signal };
  };
  const transaction = (m, index = 0) => { const q = approvedSources(m.approved)[index].quote;
    return createTransaction(m.binding.signerId, PublicKey.fromString(m.binding.publicKey), m.binding.mandateId, BigInt(index + 1),
      [actions.functionCall('pay', { order_id: q.orderId, recipient: q.vendorId, amount: q.amountAtomic }, 100_000_000_000_000n, 0n)], new Uint8Array(32).fill(7)); };
  return { repository, wrapper, binding, manifest, qualification, resolveKeyMaterial, admit, transaction,
    counts: () => ({ resolutions, readonlyWrites, replays, forbidden }) };
}

test('local graph resolves a job admitted after construction and signs both sources with one restricted signer', async t => {
  const h = await fixture(t, { replay: true });
  const c = trusted.createTrustedComposition({ repository: h.wrapper, localQualification: h.qualification });
  const request = await h.admit(); // no job/mandate/order existed at constructor time
  const signer = await c.trustedSignerProvider(request);
  for (let i = 0; i < 2; i++) {
    const result = await signer.signTransaction(h.transaction(request.manifest, i));
    assert.ok(result.signedTransaction); assert.ok(result.txHash);
  }
  assert.deepEqual(c.capabilities, { publicTestnet: true, financialActions: true, qualifiedModel: true, qualifiedSigning: true });
  assert.equal(c.maxRunMs, 20000);
  assert.equal(c.model.contractVersion, 'haldir.model.runner-recovery.v1');
  assert.equal(typeof c.model.propose, 'function'); assert.equal(typeof c.model.recover, 'function');
  assert.equal(typeof c.ownerOperations.prepare, 'function'); assert.equal(typeof c.ownerOperations.reconcile, 'function');
  assert.equal(h.counts().resolutions, 1); assert.equal(h.counts().readonlyWrites, 0); assert.ok(h.counts().replays >= 2);
});

const makeProvider = (h, extra = {}) => trusted.createPostAdmissionSignerProvider({ repository: h.wrapper,
  signingBindings: [h.binding], resolveKeyMaterial: h.resolveKeyMaterial, ...extra });
const changeRecord = (h, collection, id, change) => h.repository.runTransaction(async tx => {
  const row = await tx.get(collection, id); tx.set(collection, id, change(row));
});
for (const [name, mutate] of [
  ['cross-owner request', async (_h, r) => { r.ownerId = 'foreign.testnet'; }],
  ['unknown job', async (_h, r) => { r.jobId = 'not-admitted'; }],
  ['wrong public key', async (_h, r) => { r.manifest.binding.publicKey = KeyPair.fromRandom('ed25519').getPublicKey().toString(); }],
  ['changed request second source', async (_h, r) => { r.manifest.approved.sources[1].quote.content += ' changed'; }],
  ['changed admitted observation', async (_h, r) => { r.manifest.chainEvidence.blockHeight++; }],
  ['changed operator approval', async h => changeRecord(h, trusted.APPROVAL_COLLECTION,
    trusted.approvalKey({ ownerId: h.binding.ownerId, approvalId: h.binding.approvalId }), row => {
      row.manifest.approved.sources[1].quote.amountAtomic = '10'; return row;
    })],
  ['wrong mandate membership', async (h, r) => changeRecord(h, 'mandates', Buffer.from(JSON.stringify([
    'haldir-local-v1', 'testnet', r.manifest.binding.mandateId])).toString('base64url'), row => ({ ...row, jobId: 'other-job' }))],
  ['wrong persisted owner', async (h, r) => changeRecord(h, 'jobs', r.jobId, row => ({ ...row, ownerId: 'foreign.testnet' }))],
  ['stopped job', async (h, r) => changeRecord(h, 'jobs', r.jobId, row => ({ ...row, state: 'LOCAL_STOPPED' }))],
  ['wrong source refs', async (h, r) => changeRecord(h, 'jobs', r.jobId, row => { row.sourceRefs[1].quoteId = 'other'; return row; })],
  ['changed second quote', async (h, r) => changeRecord(h, 'quotes', approvedSources(r.manifest.approved)[1].quoteId,
    row => { row.quote.amountAtomic = '10'; return row; })],
  ['changed second order', async (h, r) => changeRecord(h, 'orders', approvedSources(r.manifest.approved)[1].quoteId,
    row => { row.quote.content += ' changed'; return row; })],
  ['foreign second quote owner', async (h, r) => changeRecord(h, 'quotes', approvedSources(r.manifest.approved)[1].quoteId,
    row => ({ ...row, ownerId: 'foreign.testnet' }))],
  ['pre-aborted signal', async (_h, r) => { r.signal = AbortSignal.abort(); }],
  ['request extra key', async (_h, r) => { r.keyVersion = 'browser-version'; }],
]) test(`post-admission denies ${name} with zero secret reads`, async t => {
  const h = await fixture(t), provider = makeProvider(h), request = await h.admit();
  await mutate(h, request);
  await assert.rejects(provider(request), { message: 'SIGNER_UNAVAILABLE' });
  assert.equal(h.counts().resolutions, 0); assert.equal(h.counts().readonlyWrites, 0);
});

test('cached provider revalidates changed approval and both sources before resolving again', async t => {
  const h = await fixture(t), provider = makeProvider(h), r = await h.admit();
  await provider(r); assert.equal(h.counts().resolutions, 1);
  await changeRecord(h, 'orders', approvedSources(r.manifest.approved)[1].quoteId, row => ({ ...row, jobId: 'foreign-job' }));
  await assert.rejects(provider(r), { message: 'SIGNER_UNAVAILABLE' }); assert.equal(h.counts().resolutions, 1);
});

test('constructor snapshot is detached and ordinary legacy admission is also resolved after construction', async t => {
  const h = await fixture(t, { legacy: true }), provider = makeProvider(h);
  h.binding.keyVersion = 'mutated'; h.binding.publicKey = 'invalid';
  const r = await h.admit(), signer = await provider(r);
  assert.ok(await signer.signTransaction(h.transaction(r.manifest)));
  assert.equal(h.counts().resolutions, 1);
});

for (const [name, mutate] of [
  ['duplicate manifest tuple', row => ({ ...row, approvalId: 'other-approval', publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString(), keyVersion: 'other-version' })],
  ['duplicate approval tuple', row => ({ ...row, manifestId: 'other-manifest', publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString(), keyVersion: 'other-version' })],
  ['duplicate public key', row => ({ ...row, manifestId: 'other-manifest', approvalId: 'other-approval', keyVersion: 'other-version' })],
  ['duplicate key version', row => ({ ...row, manifestId: 'other-manifest', approvalId: 'other-approval', publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString() })],
]) test(`binding catalog denies ${name}`, async t => {
  const h = await fixture(t);
  assert.throws(() => makeProvider(h, { signingBindings: [h.binding, mutate(h.binding)] }), { message: 'SIGNER_UNAVAILABLE' });
  assert.equal(h.counts().resolutions, 0);
});
for (const [name, change] of [
  ['malformed version', b => { b.keyVersion = 'invalid version'; }],
  ['malformed public key', b => { b.publicKey = 'ed25519:invalid'; }],
  ['unknown custody field', b => { b.secret = 'not-allowed'; }],
  ['malformed approval ID', b => { b.approvalId = '../bad'; }],
]) test(`binding catalog denies ${name} before secret access`, async t => {
  const h = await fixture(t); change(h.binding);
  assert.throws(() => makeProvider(h), { message: 'SIGNER_UNAVAILABLE' }); assert.equal(h.counts().resolutions, 0);
});

test('wrong resolved key stays unavailable and does not expose signing capability', async t => {
  const h = await fixture(t, { resolve: () => KeyPair.fromRandom('ed25519').toString() }), provider = makeProvider(h);
  await assert.rejects(provider(await h.admit()), { message: 'SIGNER_UNAVAILABLE' }); assert.equal(h.counts().resolutions, 1);
});

for (const mode of ['abort', 'timeout']) test(`post-admission preserves ${mode} quarantine until late key settlement`, async t => {
  let entered, release, resolverSignal;
  const ready = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const h = await fixture(t, { resolve: async ({ signal }, key) => { resolverSignal = signal; entered(); await held; return key.toString(); } });
  const provider = makeProvider(h, { timeoutMs: mode === 'timeout' ? 10 : 1000 }), r = await h.admit(), controller = new AbortController();
  r.signal = controller.signal;
  const first = assert.rejects(provider(r), { message: 'SIGNER_UNAVAILABLE' });
  await ready; if (mode === 'abort') controller.abort(); await first;
  assert.ok(resolverSignal.aborted);
  await assert.rejects(provider({ ...r, signal: new AbortController().signal }), { message: 'SIGNER_UNAVAILABLE' });
  assert.equal(h.counts().resolutions, 1, 'no replacement provider while original resolver is unsettled');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.counts().resolutions, 1, 'late secret does not retry or yield a signer');
});

for (const mutate of [q => { q.enabled = true; }, q => { delete q.model; }, q => { q.model.facade = {}; },
  q => { q.model.transportFactory = 'module-path'; }, q => { q.signingBindings[0].keyVersion = ''; },
  q => { q.model.authorizationExpiresAt = 'not-a-date'; }, q => { q.resolveKeyMaterial = 'module-path'; }])
  test('partial or extended local graph cannot half-enable composition', async t => {
    const h = await fixture(t); mutate(h.qualification);
    assert.throws(() => trusted.createTrustedComposition({ repository: h.wrapper, localQualification: h.qualification }), /TRUSTED_COMPOSITION_INVALID/);
    assert.equal(h.counts().resolutions, 0);
  });

test('malformed constructor input is sanitized consistently', () => {
  for (const options of [null, undefined, {}, [], 'invalid'])
    assert.throws(() => trusted.createPostAdmissionSignerProvider(options), { message: 'SIGNER_UNAVAILABLE' });
});

test('local graph retains actual atomic budget, verified transport validation and cache-only recovery', async t => {
  const h = await fixture(t); let calls = 0, verifies = 0;
  h.qualification.model.transportFactory = ({ apiKey, signal }) => createNearAiTransport({ apiKey, signal,
    run: async input => ({ ok: true, ...await verifiedCompletion(input, async options => {
      assert.equal(options.e2ee, true);
      return { sdkVersion: '0.3.0', getSdkError: () => null, pause: async () => {}, client: {
        async fetch(url, init) {
          calls++; assert.equal(url, 'https://cloud-api.near.ai/v1/chat/completions');
          const body = JSON.parse(init.body), request = JSON.parse(body.messages[1].content);
          assert.equal(body.thinking_token_budget, 512);
          const result = { tool: 'requestquotes', arguments: { quoteIds: request.approvedSources.map(s => s.quoteId) } };
          return Response.json({ id: 'synthetic-local-receipt-not-provider-attestation', model: body.model,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }],
            usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } });
        },
        async verifyResponse(id) { verifies++; return { id, signatureKind: 'provider_tee' }; }, clearResponseCache() {},
      } };
    }) }) });
  const c = trusted.createTrustedComposition({ repository: h.repository, localQualification: h.qualification });
  const r = await h.admit(), job = await h.repository.runTransaction(tx => tx.get('jobs', r.jobId));
  const sources = approvedSources(r.manifest.approved), input = { phase: 'plan', approvedJobInput: approvedInput(job),
    approvedSources: sources, tools: [{ name: 'requestquotes', approvedSources: sources }], signal: r.signal };
  await assert.rejects(c.model.recover(input), { message: 'MODEL_CACHE_UNAVAILABLE' });
  assert.equal(calls, 0); assert.equal(await h.repository.runTransaction(tx => tx.get('modelReleaseSpend', NEAR_AI_RELEASE.key)), null);
  const result = await c.model.propose(input);
  assert.deepEqual(result, { tool: 'requestquotes', arguments: { quoteIds: sources.map(s => s.quoteId) } });
  assert.equal(calls, 1); assert.equal(verifies, 1);
  const id = createHash('sha256').update(JSON.stringify(['haldir-near-ai-v1', r.ownerId, r.jobId])).digest('hex');
  const key = publicModelReservationKey(id, r.jobId, 'plan');
  const row = await h.repository.runTransaction(tx => tx.get('modelReservations', key));
  assert.equal(row.state, 'COMPLETED_VERIFIED'); assert.equal(row.ownerId, r.ownerId); assert.equal(row.jobId, r.jobId);
  const release = await h.repository.runTransaction(tx => tx.get('modelReleaseSpend', NEAR_AI_RELEASE.key));
  assert.ok(BigInt(release.reservedCostMicros) > 0n);
  const reconstructed = trusted.createTrustedComposition({ repository: h.repository, localQualification: {
    ...h.qualification, model: { ...h.qualification.model, transportFactory: () => assert.fail('recovery started transport') } } });
  assert.deepEqual(await reconstructed.model.recover(input), result);
  assert.deepEqual(await reconstructed.model.propose(input), result);
  assert.deepEqual(await h.repository.runTransaction(tx => tx.get('modelReservations', key)), row);
  assert.deepEqual(await h.repository.runTransaction(tx => tx.get('modelReleaseSpend', NEAR_AI_RELEASE.key)), release);
  assert.equal(calls, 1); assert.equal(h.counts().resolutions, 0);
});

test('composed signer remains usable beyond incumbent 10 seconds but never beyond original run signal', { timeout: 15000 }, async t => {
  const h = await fixture(t), c = trusted.createTrustedComposition({ repository: h.wrapper, localQualification: h.qualification });
  const r = await h.admit(), controller = new AbortController(); r.signal = controller.signal;
  const start = performance.now(), signer = await c.trustedSignerProvider(r);
  await new Promise(resolve => setTimeout(resolve, 10050));
  for (let i = 0; i < 2; i++) assert.ok(await signer.signTransaction(h.transaction(r.manifest, i)));
  const signedAt = performance.now() - start;
  assert.ok(signedAt > 10000 && signedAt < 20000); assert.equal(h.counts().resolutions, 1);
  controller.abort();
  await assert.rejects(signer.getPublicKey(), { message: 'SIGNER_UNAVAILABLE' });
  await assert.rejects(signer.signTransaction(h.transaction(r.manifest, 1)), { message: 'SIGNER_UNAVAILABLE' });
  t.diagnostic(JSON.stringify({ syntheticLocalOnly: true, singleResolution: 1, twoSignaturesAtMs: signedAt, composedTimeoutMs: 20000 }));
});


