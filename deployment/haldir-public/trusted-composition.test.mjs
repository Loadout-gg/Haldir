import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrustedComposition, createTrustedApprovalStore, approvalKey, APPROVAL_COLLECTION } from './trusted-composition.mjs';
import { KeyPair } from 'near-api-js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const subject = { ownerId: 'alice.testnet', approvalId: 'approved-1' };
const synthetic = () => ({ schemaVersion: 'haldir.public.approval.v1', ...subject,
  manifest: { manifestId: 'manifest-1', ownerId: subject.ownerId, approved: { job: { networkId: 'testnet' } },
    binding: { ownerId: subject.ownerId, networkId: 'testnet' },
    rpcUrl: 'https://rpc.testnet.near.org', allowedRpcUrls: ['https://rpc.testnet.near.org'] } });

test('approval port reads one exact owner/approval key, returns detached frozen immutable terms; never writes', async () => {
  const row = synthetic(), calls = [];
  const repository = { async runTransaction(fn) { return fn({
    async get(...args) { calls.push(args); return row; },
    create() { assert.fail('no provisioning'); }, set() { assert.fail('immutable approvals'); },
  }); } };
  const store = createTrustedApprovalStore({ repository });
  const value = await store.get(subject);
  assert.deepEqual(value, row.manifest);
  assert.deepEqual(calls, [[APPROVAL_COLLECTION, JSON.stringify(['haldir-public-approval-v1', 'alice.testnet', 'approved-1'])]]);
  assert.equal(approvalKey(subject), calls[0][1]); assert.equal(APPROVAL_COLLECTION, 'publicApprovals');
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.approved.job));
  row.manifest.approved.job.networkId = 'mainnet';
  assert.equal(value.approved.job.networkId, 'testnet');
  assert.deepEqual(Object.keys(store), ['get']);
});
test('missing/foreign/malformed approvals fail closed and cannot accept browser terms', async () => {
  for (const change of [() => null, r => ({ ...r, ownerId: 'bob.testnet' }),
    r => ({ ...r, approvalId: 'other' }), r => ({ ...r, schemaVersion: 'other' }),
    r => ({ ...r, approved: true }), r => ({ ...r, manifest: { ...r.manifest, ownerId: 'bob.testnet' } }),
    r => ({ ...r, manifest: { ...r.manifest, chainEvidence: {} } }),
    r => ({ ...r, manifest: { ...r.manifest, rpcUrl: 'https://mainnet.near.org' } }),
  ]) {
    let writes = 0;
    const store = createTrustedApprovalStore({ repository: { runTransaction: fn => fn({
      get: async () => change(synthetic()), set() { writes++; }, create() { writes++; },
    }) } });
    await assert.rejects(store.get(subject), /APPROVAL_UNAVAILABLE/); assert.equal(writes, 0);
  }
  let reads = 0;
  const store = createTrustedApprovalStore({ repository: { runTransaction() { reads++; } } });
  for (const input of [{ ...subject, manifest: synthetic().manifest }, { ...subject, ownerId: '../alice' },
    { ...subject, approvalId: 'a/b' }, { ...subject, signal: {} }]) {
    await assert.rejects(store.get(input), /APPROVAL_SUBJECT_INVALID/);
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(store.get({ ...subject, signal: aborted.signal })); assert.equal(reads, 0);
});
test('finite composition has real readers/owner recovery, no model/signer or financial admission', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('NO_EXTERNAL_NETWORK'); });
  const repository = { runTransaction: fn => fn({ get: async () => null }) };
  const composition = createTrustedComposition({ repository });
  assert.equal(typeof composition.trustedAccessKeyReader, 'function');
  assert.equal(typeof composition.trustedManifestProvider, 'function');
  assert.equal(typeof composition.ownerOperations.prepare, 'function');
  assert.equal(typeof composition.ownerOperations.reconcile, 'function');
  assert.equal(typeof composition.trustedMandateStatusReader, 'function');
  await assert.rejects(composition.trustedMandateStatusReader({ ownerId: 'alice.testnet', jobId: 'missing',
    manifest: {}, signal: new AbortController().signal }), { code: 'NOT_FOUND' });
  assert.equal(calls, 0, 'the actual composed reader denies an unowned job before transport');
  assert.equal(composition.model, undefined); assert.equal(composition.trustedSignerProvider, undefined);
  assert.deepEqual(composition.capabilities, { publicTestnet: true, financialActions: false, qualifiedModel: false, qualifiedSigning: false });
  assert.equal(composition.maxRunMs, 20000); assert.equal(calls, 0);
  await assert.rejects(composition.trustedManifestProvider(subject), { code: 'MANIFEST_UNAVAILABLE' });
  assert.equal(calls, 0); // Missing approval does not even attempt RPC.
  for (const options of [{ repository, env: {} }, { repository, model: {} }, { repository, rpcUrl: 'http://localhost' }]) {
    assert.throws(() => createTrustedComposition(options), /TRUSTED_COMPOSITION_INVALID/);
  }
});
test('actual composed 5s deadlines cover earlier store/status work and stalled bodies, never one timeout per RPC', async t => {
  const fixture = JSON.parse(await readFile(new URL('../haldir-testnet/manifest.synthetic-fixture.json', import.meta.url)));
  const rpcUrl = 'https://rpc.testnet.near.org', b = fixture.runtime_binding, s = fixture.spec;
  const manifest = { manifestId: 'synthetic-deadline', ownerId: b.ownerId, binding: b, rpcUrl, allowedRpcUrls: [rpcUrl],
    approved: { job: { networkId: 'testnet', mandateId: b.mandateId, purpose: 'SYNTHETIC', output: 'Report',
      budgetAtomic: s.cap, vendorIds: s.allowlist, expiresAt: new Date(Date.now() + 3600000).toISOString() },
      quote: { networkId: 'testnet', mandateId: b.mandateId, vendorId: s.allowlist[0], amountAtomic: '8', orderId: 'q', content: 'SYNTHETIC' } } };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let statuses = 0, queries = 0, storeReads = 0, bodyAborts = 0;
  const signals = new Set();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, rpcUrl); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal); signals.add(init.signal);
    const r = JSON.parse(init.body);
    if (r.method === 'status' && ++statuses === 1) {
      await pause(2500); return Response.json({ jsonrpc: '2.0', id: r.id, result: { chain_id: 'testnet', sync_info: { syncing: false } } });
    }
    if (r.method === 'query') queries++;
    else assert.equal(r.method, 'status');
    // No native transport. Simulate fetch's cancellation of a stalled body.
    return new Response(new ReadableStream({ start(controller) {
      init.signal.addEventListener('abort', () => { bodyAborts++; controller.error(new Error('SYNTHETIC_ABORT')); }, { once: true });
    } }));
  });
  const keyComposition = createTrustedComposition({ repository: { runTransaction: async () => null } });
  const manifestComposition = createTrustedComposition({ repository: { runTransaction: async fn => fn({ get: async (collection, key) => {
    storeReads++; assert.equal(collection, APPROVAL_COLLECTION);
    assert.equal(key, approvalKey({ ownerId: b.ownerId, approvalId: 'one' }));
    await pause(2500); return { schemaVersion: 'haldir.public.approval.v1', ownerId: b.ownerId, approvalId: 'one', manifest };
  } }) } });
  const ownerComposition = createTrustedComposition({ repository: { runTransaction: async () => new Promise(() => {}) } });
  const start = performance.now();
  const key = keyComposition.trustedAccessKeyReader({ networkId: 'testnet', accountId: 'alice.testnet', publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString() });
  const observed = manifestComposition.trustedManifestProvider({ ownerId: b.ownerId, approvalId: 'one' });
  const jobId = 'synthetic-deadline';
  const recovery = ownerComposition.ownerOperations.reconcile({ ownerId: 'alice.testnet', action: 'stop', job: { jobId },
    operationId: createHash('sha256').update(JSON.stringify(['haldir-owner-v1', jobId, 'stop'])).digest('hex'),
    transactionHash: '11111111111111111111111111111111', signerId: 'alice.testnet', manifest: {} });
  const [keyResult, manifestResult, ownerResult] = await Promise.allSettled([key, observed, recovery]);
  const elapsed = performance.now() - start;
  assert.equal(keyResult.status, 'rejected'); assert.equal(keyResult.reason.code, 'OWNER_KEY_UNAVAILABLE');
  assert.equal(manifestResult.status, 'rejected'); assert.equal(manifestResult.reason.code, 'MANIFEST_UNAVAILABLE');
  assert.equal(ownerResult.status, 'fulfilled'); assert.equal(ownerResult.value.status, 'UNKNOWN');
  assert.ok(elapsed >= 4800 && elapsed < 7000, `shared 5000ms deadline observed ${elapsed}ms`);
  assert.equal(statuses, 2); assert.equal(queries, 1); assert.equal(storeReads, 1);
  assert.equal(bodyAborts, 2); assert.equal(signals.size, 2); assert.ok([...signals].every(signal => signal.aborted));
  t.diagnostic(JSON.stringify({ sharedDeadlineMs: 5000, observedMs: elapsed, statuses, queries, bodyAborts }));
});

