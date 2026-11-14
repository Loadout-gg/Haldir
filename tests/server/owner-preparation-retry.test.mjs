import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { KeyPair, baseEncode } from 'near-api-js';
import { serializeMessageNep413 } from '@meteorwallet/sdk';
import { openLocalRepository, createPublicOrders } from '../../src/server/orders.mjs';
import { createWalletSessions } from '../../src/server/wallet-session.mjs';
import { createPublicJourney } from '../../src/server/public-journey.mjs';
import { createNearOwnerOperations } from '../../src/server/near-owner-operations.mjs';
import { approvedSources } from '../../src/shared/job-contract.mjs';

const origin = 'https://retry.example', now = Date.parse('2026-11-13T10:00:00Z');
const hash = baseEncode(new Uint8Array(32).fill(8));
const key = (jobId, action = 'stop') => createHash('sha256').update(JSON.stringify(['haldir-owner-v1', jobId, action])).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// Actual concrete repository-only prepare, real HTTP and signed synthetic login.
// No RPC, wallet, signing/broadcast, model or external transport is permitted.
async function fixture(t, { maxRunMs = 2000, timeoutMs = 500, two = false } = {}) {
  const raw = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => raw.close());
  let hook = async (_callback, run) => run(), prepares = 0, transports = 0;
  const repository = { runTransaction: callback => hook(callback, () => raw.runTransaction(callback)) };
  t.mock.method(globalThis, 'fetch', async () => { transports++; throw new Error('EXTERNAL_TRANSPORT_FORBIDDEN'); });
  t.after(() => assert.equal(transports, 0));
  const pair = KeyPair.fromRandom('ed25519');
  const binding = { networkId: 'testnet', ownerId: 'alice.testnet', signerId: 'agent.testnet', mandateId: 'mandate.testnet',
    publicKey: pair.getPublicKey().toString(), maxAllowanceAtomic: '1000', codeHash: hash };
  const manifest = { manifestId: 'approved', ownerId: binding.ownerId,
    approved: { job: { networkId: 'testnet', mandateId: binding.mandateId, purpose: 'Fictional supplier', output: 'Report',
      budgetAtomic: '30', vendorIds: ['vendor.testnet'], expiresAt: '2026-11-13T18:00:00Z' },
      quote: { networkId: 'testnet', mandateId: binding.mandateId, vendorId: 'vendor.testnet', amountAtomic: '8', orderId: 'one', content: 'Fictional sample' } },
    binding, rpcUrl: 'https://no-network.invalid', allowedRpcUrls: ['https://no-network.invalid'],
    chainEvidence: { networkId: 'testnet', finality: 'final', blockHash: hash, blockHeight: 123, observedAt: now } };
  if (two) {
    const first = manifest.approved.quote, second = {...first,vendorId:'second.testnet',orderId:'two',content:'Fictional background',amountAtomic:'9'};
    manifest.approved.job.vendorIds = [first.vendorId,second.vendorId];
    manifest.approved = {schemaVersion:'haldir.approved.two-source.v1',job:manifest.approved.job,
      sources:[{sourceId:'company-records',quote:first},{sourceId:'background-research',quote:second}]};
    assert.equal(approvedSources(manifest.approved).length,2);
  }
  const trustedAccessKeyReader = async ({ accountId, publicKey }) => ({ networkId: 'testnet', accountId, publicKey,
    permission: 'FullAccess', finality: 'final', blockHeight: 123, blockHash: hash, observedAt: now });
  const config = { repository, approvedOrigin: origin, approvedRecipient: 'retry.example', trustedAccessKeyReader,
    now: () => now, maxRunMs, capabilities: { publicTestnet: true } };
  const sessions = createWalletSessions(config);
  async function login(accountId) {
    const c = await sessions.issueChallenge({ accountId, origin, networkId: 'testnet' });
    const signed = pair.sign(serializeMessageNep413({ ...c.payload, nonce: Buffer.from(c.payload.nonce, 'base64') }));
    const r = await sessions.verifyChallenge({ accountId, origin, networkId: 'testnet', challengeId: c.challengeId,
      publicKey: pair.getPublicKey().toString(), signature: Buffer.from(signed.signature).toString('base64') });
    return `__Host-haldir_session=${r.token}`;
  }
  const cookie = await login('alice.testnet'), foreign = await login('bob.testnet');
  const job = await createPublicOrders({ repository, now: () => now, trustedManifestProvider: async () => manifest })
    .createJob({ ownerId: 'alice.testnet', approvalId: 'approved', admissionKey: 'one' });
  const concrete = createNearOwnerOperations({ repository, rpcUrl: manifest.rpcUrl, allowedRpcUrls: manifest.allowedRpcUrls, timeoutMs });
  let prepare = input => concrete.prepare(input);
  const ownerOperations = { prepare: input => { prepares++; return prepare(input); }, reconcile: input => concrete.reconcile(input) };
  let dropResponse = false;
  const app = createPublicJourney({ ...config, ownerOperations }), server = createServer((req, res) => {
    if (dropResponse && req.url.endsWith('/owner/prepare')) {
      dropResponse = false;
      res.end = () => { res.destroy(); return res; };
    }
    return app.handle(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => { assert.equal(server.listening,false); assert.equal(server.address(),null); resolve(); })));
  const path = `/api/public/jobs/${job.jobId}`;
  const send = (suffix = '', body = {}, headers = {}, port = server.address().port) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: path + suffix, method: 'POST',
      headers: { host: 'retry.example', origin, 'x-haldir-csrf': '1', 'content-type': 'application/json', cookie, ...headers } }, res => {
      const chunks = []; res.on('error', reject); res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const read = () => raw.runTransaction(tx => tx.get('ownerOperations', key(job.jobId)));
  return { raw, repository, concrete, manifest, job, send, read, foreign, config, ownerOperations,
    dropResponse: () => { dropResponse = true; },
    prepares: () => prepares, hook: fn => { hook = fn; }, prepare: fn => { prepare = fn; },
    retry: (attemptId, action = 'stop', extra = {}) => send('/owner/retry-prepare', { action, operationId: key(job.jobId, action), attemptId, ...extra }) };
}

test('settled pure concrete preparation failure permits only explicit same-identity retry with immutable terms', async t => {
  const h = await fixture(t, { timeoutMs: 20 });
  // Hold the concrete preparer's repository-only binding read past its deadline.
  // Its read can finish later but has no issuance write or RPC capability.
  const release = deferred(), entered = deferred();
  h.prepare(async input => {
    h.hook((_cb, run) => { entered.resolve(); return release.promise.then(run); });
    try { return await h.concrete.prepare(input); } finally { h.hook((_cb, run) => run()); }
  });
  const first = h.send('/owner/prepare', { action: 'stop' });
  await entered.promise;
  const failed = await first;
  release.resolve();
  assert.equal(failed.status, 503);
  const row = await h.read();
  assert.equal(row.request, null); assert.equal(row.transactionHash, null); assert.equal(row.receipt, null);
  assert.equal(row.preparation?.state, 'UNISSUED_FAILED');
  assert.match(row.preparation.attemptId, uuid);
  const lookup = await h.send('/owner/prepare', { action: 'stop' });
  assert.equal(lookup.body.walletEligible, false);
  assert.equal(lookup.body.operation.preparation.attemptId, row.preparation.attemptId);
  h.prepare(input => h.concrete.prepare(input));
  const retry = await h.retry(row.preparation.attemptId);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.walletEligible, true);
  assert.equal(retry.body.operation.operationId, row.operationId);
  assert.notEqual(retry.body.operation.preparation.attemptId, row.preparation.attemptId);
  assert.equal(retry.body.operation.preparation.state, 'ISSUED');
  assert.deepEqual(retry.body.operation.request, { network: 'testnet', signerId: 'alice.testnet', receiverId: 'mandate.testnet',
    methodName: 'stop', args: {}, gas: '100000000000000', deposit: '0' });
  assert.deepEqual((await h.raw.runTransaction(tx => tx.get('jobs', h.job.jobId))).publicManifest, h.manifest);
  assert.equal(h.prepares(), 2);
  await h.raw.runTransaction(async tx => {
    const old = await tx.get('ownerPreparationAttempts', row.preparation.attemptId);
    const next = await tx.get('ownerPreparationAttempts', retry.body.operation.preparation.attemptId);
    assert.deepEqual(old, { operationId: row.operationId, attemptId: row.preparation.attemptId, state: 'UNISSUED_FAILED', previousAttemptId: null });
    assert.equal(next.previousAttemptId, old.attemptId); assert.equal(next.state, 'ISSUED');
  });
});

test('concurrent explicit retry claimants get one generation and only one eligible response', async t => {
  const h = await fixture(t);
  h.prepare(async () => { throw new Error('pure preparation failed'); });
  assert.equal((await h.send('/owner/prepare', { action: 'stop' })).status, 503);
  const failed = await h.read(), entered = deferred(), release = deferred();
  h.prepare(async input => { entered.resolve(); await release.promise; return h.concrete.prepare(input); });
  const first = h.retry(failed.preparation.attemptId); await entered.promise;
  const other = await h.retry(failed.preparation.attemptId);
  assert.equal(other.status, 200); assert.equal(other.body.walletEligible, false);
  assert.equal(other.body.operation.preparation.state, 'PREPARING');
  release.resolve(); const winner = await first;
  assert.equal(winner.body.walletEligible, true);
  assert.equal(winner.body.operation.preparation.attemptId, other.body.operation.preparation.attemptId);
  assert.equal(h.prepares(), 2);
});

test('unreserved initial claim races ordinary prepare without reopening any existing generation', async t => {
  const h = await fixture(t), entered = deferred(), release = deferred();
  h.prepare(async input => { entered.resolve(); await release.promise; return h.concrete.prepare(input); });
  const initial = h.send('/owner/prepare', { action: 'stop' }); await entered.promise;
  const loser = await h.retry('unreserved');
  assert.equal(loser.body.walletEligible, false); assert.equal(loser.body.operation.status, 'PREPARING');
  release.resolve(); const winner = await initial;
  assert.equal(winner.body.walletEligible, true);
  assert.equal(loser.body.operation.preparation.attemptId, winner.body.operation.preparation.attemptId);
  assert.equal((await h.retry('unreserved')).body.walletEligible, false);
  assert.equal(h.prepares(), 1);
  const other = await h.retry('unreserved', 'withdraw');
  assert.equal(other.body.walletEligible, true); assert.notEqual(other.body.operation.operationId, winner.body.operation.operationId);
});

test('lost issued prepare response and restart are lookup-only even without a hash', async t => {
  const h = await fixture(t);
  // Destroy the actual HTTP response AFTER the handler has committed issuance.
  h.dropResponse();
  await assert.rejects(h.send('/owner/prepare', { action: 'stop' }), { code: 'ECONNRESET' });
  const before = await h.read();
  assert.equal(before.preparation.state, 'ISSUED'); assert.equal(before.transactionHash, null);
  const lookup = await h.send('/owner/prepare', { action: 'stop' });
  assert.equal(lookup.body.walletEligible, false);
  assert.equal((await h.retry(before.preparation.attemptId)).body.walletEligible, false);
  assert.equal((await h.retry('unreserved')).body.walletEligible, false);
  assert.deepEqual(await h.read(), before); assert.equal(h.prepares(), 1);
  const restarted = createPublicJourney({ ...h.config, ownerOperations: h.ownerOperations });
  const server = createServer(restarted.handle); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(() => { assert.equal(server.listening,false); assert.equal(server.address(),null); resolve(); })));
  const reopened = await h.send('/owner/prepare', { action: 'stop' }, {}, server.address().port);
  assert.equal(reopened.body.walletEligible, false);
  assert.deepEqual(reopened.body.operation, lookup.body.operation);
  assert.equal((await h.send('', {}, {}, server.address().port)).body.ownerOperations[0].preparation.state, 'ISSUED');
});

for (const outcome of ['completion', 'error']) test(`stale original preparation ${outcome} cannot overwrite a successor generation`, async t => {
  const h = await fixture(t), entered = deferred(), release = deferred();
  h.prepare(async input => { const request = await h.concrete.prepare(input); entered.resolve(); await release.promise;
    if (outcome === 'error') throw new Error('stale pure error'); return request; });
  const original = h.send('/owner/prepare', { action: 'stop' }); await entered.promise;
  const old = await h.read();
  // Adversarial persistence interleaving; NOT an authorized takeover API.
  const successor = { ...old, preparation: { attemptId: '22222222-2222-4222-8222-222222222222', state: 'PREPARING' } };
  await h.raw.runTransaction(tx => tx.set('ownerOperations', old.operationId, successor));
  release.resolve(); assert.notEqual((await original).status, 200);
  assert.deepEqual(await h.read(), successor);
});

for (const phase of ['initial', 'save']) test(`delayed ${phase} commit drains past deadline without issuing a wallet-eligible response`, async t => {
  const h = await fixture(t, { maxRunMs: 80 }), entered = deferred(), release = deferred(), expired = deferred();
  let held = false;
  h.hook(callback => h.raw.runTransaction(async tx => {
    const result = await callback(tx);
    if (!held && ((phase === 'initial' && result?.created === true) || (phase === 'save' && result?.status === 'AWAITING_WALLET'))) {
      held = true; entered.resolve(); await release.promise;
    }
    return result;
  }));
  let done = false;
  const pending = h.send('/owner/prepare', { action: 'stop' }).then(x => { done = true; return x; });
  await entered.promise;
  setTimeout(expired.resolve, 110); await expired.promise;
  assert.equal(done, false); release.resolve();
  const response = await pending; assert.equal(response.status, 503); assert.equal(response.body.error, 'EXECUTION_DEADLINE');
  assert.equal(held, true);
  const row = await h.read();
  assert.equal(row.preparation.state, phase === 'save' ? 'ISSUED' : 'UNISSUED_FAILED');
  assert.equal(row.request === null, phase === 'initial');
  assert.equal((await h.retry('unreserved')).body.walletEligible, false);
  if (phase === 'save') assert.equal((await h.retry(row.preparation.attemptId)).body.walletEligible, false);
});

for (const phase of ['initial', 'save', 'failure']) test(`uncertain ${phase} store commit stays closed and never manufactures retry proof`, async t => {
  const h = await fixture(t); let injected = false;
  if (phase === 'failure') h.prepare(async () => { throw new Error('pure failure'); });
  h.hook(async (callback, run) => {
    const result = await run();
    const row = await h.read();
    const target = phase === 'initial' ? result?.created : phase === 'save' ? result?.status === 'AWAITING_WALLET' : row?.preparation?.state === 'UNISSUED_FAILED';
    if (!injected && target) { injected = true; throw new Error('commit response lost'); }
    return result;
  });
  assert.equal((await h.send('/owner/prepare', { action: 'stop' })).status, 500);
  assert.equal(injected, true);
  const row = await h.read();
  assert.equal((await h.retry('unreserved')).body.walletEligible, false);
  // A failure-state transaction that actually committed already has original
  // no-save proof; unlike uncertain initial/save commits this is safe to retry.
  if (phase !== 'failure') {
    assert.notEqual(row.preparation.state, 'UNISSUED_FAILED');
    assert.equal((await h.retry(row.preparation.attemptId)).body.walletEligible, false);
  }
});

for (const [label, mutate] of [
  ['legacy unknown', r => { delete r.preparation; delete r.preparationManifest; }],
  ['crashed preparing', r => { r.status = 'PREPARING'; r.preparation.state = 'PREPARING'; }],
  ['issued no hash', r => { r.status = 'AWAITING_WALLET'; r.preparation.state = 'ISSUED'; r.request = { retained: true }; }],
  ['hash-bearing unknown', r => { r.transactionHash = hash; }],
  ['receipt-bearing unknown', r => { r.receipt = { status: 'UNKNOWN' }; }],
  ['terminal failed', r => { r.status = 'FAILED'; }],
  ['terminal confirmed', r => { r.status = 'CONFIRMED'; }],
  ['changed immutable manifest', r => { r.preparationManifest = 'different'; }],
]) test(`${label} is never reopened by explicit retry or unreserved`, async t => {
  const h = await fixture(t); h.prepare(async () => { throw new Error('pure failure'); });
  await h.send('/owner/prepare', { action: 'stop' });
  const row = await h.read(), attemptId = row.preparation.attemptId; mutate(row);
  await h.raw.runTransaction(tx => tx.set('ownerOperations', row.operationId, row));
  for (const id of [attemptId, 'unreserved']) {
    const response = await h.retry(id); assert.equal(response.status, 200); assert.equal(response.body.walletEligible, false);
    if (label === 'legacy unknown') assert.equal(response.body.operation.preparation, null);
  }
  assert.deepEqual(await h.read(), row); assert.equal(h.prepares(), 1);
});

test('retry retains exact-body session owner Origin CSRF action and identity guards with admission closed', async t => {
  const h = await fixture(t), body = { action: 'stop', operationId: key(h.job.jobId), attemptId: 'unreserved' };
  for (const [headers, status] of [[{ cookie: '' }, 401], [{ cookie: h.foreign }, 404], [{ origin: 'https://foreign.invalid' }, 403],
    [{ host: 'foreign.invalid' }, 403], [{ 'x-haldir-csrf': '0' }, 403], [{ 'sec-fetch-site': 'cross-site' }, 403]])
    assert.equal((await h.send('/owner/retry-prepare', body, headers)).status, status);
  for (const change of [{ action: 'create' }, { action: 'other' }, { action: 1 }, { operationId: 'A'.repeat(64) },
    { operationId: key(h.job.jobId, 'withdraw') }, { attemptId: 'not-uuid' }, { attemptId: '22222222-2222-4222-8222-22222222222A' }, { extra: 'x' }])
    assert.equal((await h.send('/owner/retry-prepare', { ...body, ...change })).status, 400);
  assert.equal(await h.read(), null); assert.equal(h.prepares(), 0);
  assert.equal((await h.retry('22222222-2222-4222-8222-222222222222')).status, 409);
  const allowed = await h.retry('unreserved'); assert.equal(allowed.body.walletEligible, true);
  for (const suffix of ['/run', '/resume']) assert.equal((await h.send(suffix)).status, 503);
  assert.equal((await h.send('/owner/prepare', { action: 'create' })).status, 503);
});

for (const action of ['stop','withdraw']) test(`TS1 concrete ${action} retry and handler reload retain the exact operation with model off`,async t=>{
  const h=await fixture(t,{two:true,timeoutMs:20});
  assert.equal(h.config.model,undefined);
  assert.equal(h.config.capabilities.qualifiedModel,undefined);
  for(const suffix of ['/run','/resume'])assert.equal((await h.send(suffix)).status,503);
  assert.equal((await h.send('/owner/prepare',{action:'create'})).status,503);
  // Real pure preparer times out, rather than a fabricated owner-success port.
  const release=deferred(); let entered=false;
  h.prepare(async input=>{
    h.hook((_callback,run)=>{entered=true;return release.promise.then(run);});
    try{return await h.concrete.prepare(input);}finally{h.hook((_callback,run)=>run());}
  });
  const failed=await h.send('/owner/prepare',{action});release.resolve();
  assert.equal(entered,true);assert.equal(failed.status,503);
  const read=()=>h.raw.runTransaction(tx=>tx.get('ownerOperations',key(h.job.jobId,action)));
  const original=await read();
  assert.equal(original.preparation.state,'UNISSUED_FAILED');assert.equal(original.request,null);assert.equal(original.transactionHash,null);
  h.prepare(input=>h.concrete.prepare(input));
  const retried=await h.retry(original.preparation.attemptId,action);
  assert.equal(retried.status,200);assert.equal(retried.body.walletEligible,true);
  assert.equal(retried.body.operation.operationId,original.operationId);
  assert.deepEqual(retried.body.operation.request,{network:'testnet',signerId:'alice.testnet',receiverId:'mandate.testnet',methodName:action,args:{},gas:'100000000000000',deposit:'0'});
  const issued=await read();
  const restarted=createPublicJourney({...h.config,ownerOperations:h.ownerOperations}),server=createServer(restarted.handle);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(()=>{assert.equal(server.listening,false);assert.equal(server.address(),null);resolve();})));
  const reload=await h.send('/owner/prepare',{action},{},server.address().port);
  assert.equal(reload.status,200);assert.equal(reload.body.walletEligible,false);
  assert.equal(reload.body.operation.operationId,original.operationId);
  assert.deepEqual(reload.body.operation.request,retried.body.operation.request);
  assert.equal((await h.retry(issued.preparation.attemptId,action)).body.walletEligible,false);
  assert.deepEqual(await read(),issued);assert.equal(h.prepares(),2);
  const persisted=await h.raw.runTransaction(tx=>tx.get('jobs',h.job.jobId));
  assert.deepEqual(persisted.publicManifest,h.manifest);assert.equal(persisted.sourceRefs.length,2);
});

test('retry rate limit bounds claims durably without bypassing the pure preparer', async t => {
  const h = await fixture(t);
  for (let i = 0; i < 20; i++) assert.equal((await h.retry('unreserved')).status, 200);
  assert.equal((await h.retry('unreserved')).status, 429); assert.equal(h.prepares(), 1);
});

test('replayed original failure callback cannot clear a real explicitly claimed successor', async t => {
  const h = await fixture(t); let originalFailure;
  h.hook(callback => h.raw.runTransaction(tx => callback({ ...tx, set(collection, id, value) {
    if (collection === 'ownerOperations' && value.preparation?.state === 'UNISSUED_FAILED') originalFailure = callback;
    tx.set(collection, id, value);
  } })));
  h.prepare(async () => { throw new Error('pure failure'); });
  await h.send('/owner/prepare', { action: 'stop' }); const failed = await h.read();
  assert.equal(typeof originalFailure, 'function');
  h.prepare(input => h.concrete.prepare(input));
  const retried = await h.retry(failed.preparation.attemptId);
  assert.equal(retried.body.walletEligible, true); const successor = await h.read();
  await h.raw.runTransaction(originalFailure);
  assert.deepEqual(await h.read(), successor);
});

test('request-save error before delayed commit never creates unissued failure proof', async t => {
  const h = await fixture(t), entered = deferred(), release = deferred(), uncertain = deferred();
  let inFlight, held = false;
  h.hook(callback => {
    const pending = h.raw.runTransaction(async tx => {
      const result = await callback(tx);
      if (!held && result?.status === 'AWAITING_WALLET') {
        held = true; entered.resolve(); uncertain.resolve(); await release.promise;
      }
      return result;
    });
    inFlight = pending;
    return Promise.race([pending, uncertain.promise.then(() => { throw new Error('uncertain request-save'); })]);
  });
  const pending = h.send('/owner/prepare', { action: 'stop' }); await entered.promise;
  assert.equal((await pending).status, 500, 'HTTP failure is not remote rollback');
  h.hook((_callback, run) => run());
  const commit = inFlight; release.resolve(); await commit;
  const row = await h.read(); assert.equal(row.preparation.state, 'ISSUED'); assert.ok(row.request);
  assert.equal((await h.retry(row.preparation.attemptId)).body.walletEligible, false);
  assert.equal((await h.retry('unreserved')).body.walletEligible, false); assert.equal(h.prepares(), 1);
});

for (const phase of ['completion', 'error']) test(`changed immutable job scope fences preparation ${phase}`, async t => {
  const h = await fixture(t), entered = deferred(), release = deferred();
  h.prepare(async input => { const request = await h.concrete.prepare(input); entered.resolve(); await release.promise;
    if (phase === 'error') throw new Error('pure error'); return request;
  });
  const pending = h.send('/owner/prepare', { action: 'stop' }); await entered.promise;
  const before = await h.read();
  await h.raw.runTransaction(async tx => { const job = await tx.get('jobs', h.job.jobId);
    tx.set('jobs', job.jobId, { ...job, scope: { ...job.scope, budgetAtomic: '31' } }); });
  release.resolve(); assert.notEqual((await pending).status, 200);
  assert.deepEqual(await h.read(), before);
});

for (const outcome of ['completion', 'error']) test(`receipt ${outcome} is fenced by exact issuance generation`, async t => {
  const h = await fixture(t), entered = deferred(), release = deferred();
  const prepared = await h.send('/owner/prepare', { action: 'stop' });
  h.ownerOperations.reconcile = async input => { entered.resolve(); await release.promise;
    if (outcome === 'error') throw new Error('stale receipt error');
    return { networkId: 'testnet', ownerId: input.ownerId, mandateId: 'mandate.testnet', action: 'stop', transactionHash: hash,
      signerId: input.ownerId, finality: 'final', status: 'CONFIRMED', receiptId: hash };
  };
  const pending = h.send('/owner/receipt', { operationId: prepared.body.operation.operationId, transactionHash: hash, signerId: 'alice.testnet' });
  await entered.promise; const old = await h.read();
  const changed = { ...old, preparation: { attemptId: '22222222-2222-4222-8222-222222222222', state: 'ISSUED' } };
  await h.raw.runTransaction(tx => tx.set('ownerOperations', old.operationId, changed));
  release.resolve(); const response = await pending;
  assert.notEqual(response.status, 200);
  assert.deepEqual(await h.read(), changed);
  assert.equal((await h.send()).body.job.state, 'ACTIVE');
});
