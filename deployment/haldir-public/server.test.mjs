import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublicServer } from './server.mjs';
import { KeyPair } from 'near-api-js';
import { serializeMessageNep413 } from '@meteorwallet/sdk';
import { openLocalRepository } from '../../src/server/orders.mjs';
import { quoteKey } from '../../src/shared/job-contract.mjs';

const approvedOrigin = 'https://haldir.example';
// SYNTHETIC static assets: no claim of a compiled or qualified public UI.
const syntheticHtml = '<!doctype html><div id="root">SYNTHETIC HOST FIXTURE</div><script src="/assets/synthetic.js"></script>';
const syntheticJs = '/* SYNTHETIC HOST FIXTURE, not the public build */';
globalThis.fetch = () => { throw new Error('EXTERNAL_TRANSPORT_FORBIDDEN'); };
async function ui(t) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'haldir-public-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'assets')); await mkdir(join(dir, 'fonts'));
  await writeFile(join(dir, 'index.html'), syntheticHtml);
  await writeFile(join(dir, 'assets/synthetic.js'), syntheticJs);
  await writeFile(join(dir, 'fonts/Synthetic[wght].ttf'), 'SYNTHETIC FONT');
  return dir;
}
function call(server, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { host: 'haldir.example', ...headers } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(t, options = {}) {
  const server = await createPublicServer({ uiDir: await ui(t), approvedOrigin,
    repository: { runTransaction: () => { throw new Error('SYNTHETIC STATIC TEST MUST NOT TOUCH REPOSITORY'); } },
    trustedAccessKeyReader: async () => null, ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    assert.equal(server.listening, false); assert.equal(server.address(), null);
  });
  return server;
}
const apiHeaders = { origin: approvedOrigin, 'x-haldir-csrf': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
test('synthetic assets: finite document mount; no SPA or filesystem fallback', async t => {
  const s = await fixture(t);
  const root = await call(s, '/');
  assert.equal(root.status, 200); assert.equal(root.headers.location, undefined);
  const page = await call(s, '/?mode=public-testnet');
  assert.equal(page.status, 200); assert.equal(page.text, syntheticHtml);
  assert.equal((await call(s, '/assets/synthetic.js')).text, syntheticJs);
  const head = await call(s, '/fonts/Synthetic%5Bwght%5D.ttf', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.text, ''); assert.equal(head.headers['content-type'], 'font/ttf');
  for (const path of ['/?mode=testnet', '/?mode=local-qualification', '/?mode=wallet-auth-qualification',
    '/index.html', '/other-spa-route', '/assets/../index.html', '/assets/%2e%2e/index.html',
    '/src/server/orders.mjs', '/node_modules/x', '/.env', '/api/jobs', '/internal/tick', '/readyz']) {
    assert.equal((await call(s, path)).status, 404, path);
  }
  assert.equal((await call(s, '/', { headers: { host: 'evil.example', 'x-forwarded-host': 'haldir.example' } })).status, 403);
  assert.equal((await call(s, '/healthz', { headers: { host: 'probe.internal' } })).status, 200);
  assert.deepEqual(JSON.parse((await call(s, '/healthz')).text), { alive: true });
  assert.equal((await call(s, '/', { method: 'POST' })).status, 404);
});

async function authenticatedFixture(t, options = {}) {
  // SYNTHETIC in-memory persistence and chain observation, never hosted proof.
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => repository.close());
  const keys = new Map(); let observations = 0;
  const trustedAccessKeyReader = async ({ accountId, publicKey, networkId }) => {
    observations++;
    assert.equal(networkId, 'testnet');
    if (keys.get(accountId)?.getPublicKey().toString() !== publicKey) return null;
    return { accountId, publicKey, networkId, permission: 'FullAccess', finality: 'final',
      blockHeight: 123, blockHash: '11111111111111111111111111111111', observedAt: Date.now() };
  };
  const server = await fixture(t, { repository, trustedAccessKeyReader, ...options });
  const post = (path, body = {}, extra = {}) => call(server, path, { method: 'POST', body, headers: { ...apiHeaders, ...extra } });
  async function login(accountId = 'synthetic.testnet') {
    const pair = KeyPair.fromRandom('ed25519'); // disposable SYNTHETIC signing fixture only
    keys.set(accountId, pair);
    const context = { accountId, networkId: 'testnet' };
    const challenge = await post('/api/wallet-auth/challenge', context);
    assert.equal(challenge.status, 200, challenge.text);
    const c = JSON.parse(challenge.text);
    assert.equal(c.payload.recipient, 'haldir.example');
    const proof = { ...context, challengeId: c.challengeId, publicKey: pair.getPublicKey().toString(),
      signature: Buffer.from(pair.sign(serializeMessageNep413({ ...c.payload, nonce: Buffer.from(c.payload.nonce, 'base64') })).signature).toString('base64') };
    assert.equal((await post('/api/wallet-auth/verify', proof, { origin: 'https://evil.example' })).status, 403);
    const verified = await post('/api/wallet-auth/verify', proof);
    assert.equal(verified.status, 200, verified.text);
    assert.match(verified.headers['set-cookie'][0], /; Path=\/; HttpOnly; Secure; SameSite=Strict;/);
    const cookie = verified.headers['set-cookie'][0].split(';')[0];
    assert.equal(verified.text.includes(cookie.split('=')[1]), false);
    assert.equal((await post('/api/wallet-auth/verify', proof)).status, 401);
    return cookie;
  }
  return { server, repository, post, login, observations: () => observations };
}
test('real Node HTTP mounts unchanged auth and public handler over one repository/reader; model absence fails closed', async t => {
  let providerCalls = 0;
  const f = await authenticatedFixture(t, {
    trustedManifestProvider: async () => { providerCalls++; throw new Error('SYNTHETIC MUST NOT BE CALLED'); },
    trustedSignerProvider: async () => { providerCalls++; throw new Error('SYNTHETIC MUST NOT BE CALLED'); },
    capabilities: { financialActions: true, publicTestnet: true, qualifiedModel: true, qualifiedSigning: true },
  });
  assert.equal((await f.post('/api/public/config')).status, 401);
  const cookie = await f.login();
  assert.equal((await f.post('/api/wallet-auth/session', {}, { cookie })).status, 200);
  const config = await f.post('/api/public/config', {}, { cookie });
  assert.equal(config.status, 200, config.text);
  const value = JSON.parse(config.text);
  assert.equal(value.networkId, 'testnet'); assert.equal(value.financialActions, false);
  assert.ok(value.missingConfiguration.includes('model'));
  assert.equal(value.vendorData, 'FICTIONAL_SAMPLE');
  const disabled = await f.post('/api/public/jobs', { approvalId: 'synthetic', admissionKey: 'one' }, { cookie });
  assert.equal(disabled.status, 503); assert.equal(JSON.parse(disabled.text).error, 'FINANCIAL_NOT_CONFIGURED');
  assert.equal(providerCalls, 0); assert.ok(f.observations() >= 3);
  for (const extra of [{ origin: 'https://evil.example' }, { 'x-haldir-csrf': '' }, { 'sec-fetch-site': 'cross-site' }, { host: 'evil.example', 'x-forwarded-host': 'haldir.example' }]) {
    assert.equal((await f.post('/api/public/config', {}, { cookie, ...extra })).status, 403);
    assert.equal((await f.post('/api/wallet-auth/session', {}, { cookie, ...extra })).status, 403);
  }
  for (const injected of [{ provider: 'evil' }, { model: 'evil' }, { apiKey: 'SYNTHETIC' }, { ownerId: 'other.testnet' }, { localTestOnly: 'true' }]) {
    assert.equal((await f.post('/api/public/config', injected, { cookie })).status, 400);
  }
  assert.equal((await f.post('/api/public/config?model=evil', {}, { cookie })).status, 404);
  assert.equal((await f.post('/api/public/unknown', {}, { cookie })).status, 404);
  assert.equal((await f.post('/api/wallet-auth/logout', {}, { cookie })).status, 200);
  assert.equal((await f.post('/api/public/config', {}, { cookie })).status, 401);
});
test('trusted composition rejects unknown/local identity/environment switches rather than inventing adapter defaults', async t => {
  const base = { uiDir: await ui(t), approvedOrigin,
    repository: { runTransaction: async () => null }, trustedAccessKeyReader: async () => null };
  for (const option of [{ localTestOnly: true }, { testOnlySession: () => ({ accountId: 'evil.testnet' }) },
    { provider: 'evil' }, { env: { HALDIR_FINANCIAL_ACTIONS: 'true' } }, { modelRuntimePath: './evil.mjs' }]) {
    await assert.rejects(createPublicServer({ ...base, ...option }), /PUBLIC_HOST_CONFIGURATION_INVALID/);
  }
  await assert.rejects(createPublicServer({ ...base, approvedOrigin: 'http://haldir.example' }), /EXACT_HTTPS_ORIGIN_REQUIRED/);
  await assert.rejects(createPublicServer({ ...base, approvedOrigin: approvedOrigin + '/' }), /EXACT_HTTPS_ORIGIN_REQUIRED/);
  await assert.rejects(createPublicServer({ ...base, trustedAccessKeyReader: undefined }), /AUTH_ADAPTERS_REQUIRED/);
});
test('static loader rejects symlinked ancestors and unsupported private files before constructing a listener', async t => {
  const original = await ui(t), parent = await mkdtemp(join(await realpath(tmpdir()), 'haldir-public-symlink-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await symlink(dirname(original), join(parent, 'alias'));
  const base = { approvedOrigin, repository: { runTransaction: async () => null }, trustedAccessKeyReader: async () => null };
  await assert.rejects(createPublicServer({ ...base, uiDir: join(parent, 'alias', basename(original)) }), /UI_(?:ROOT_INVALID|SYMLINK_FORBIDDEN)/);
  await writeFile(join(original, 'assets/private.pem'), 'SYNTHETIC FORBIDDEN FILE');
  await assert.rejects(createPublicServer({ ...base, uiDir: original }), /UI_FILE_FORBIDDEN/);
});
test('delivered recovery contract: model-absent same-job POST read and qualified owner stop remain available without financial success claims', async t => {
  let prepares = 0, reconciles = 0;
  const f = await authenticatedFixture(t, { capabilities: { publicTestnet: true },
    ownerOperations: {
      async prepare(input) {
        prepares++; assert.equal(input.ownerId, 'synthetic.testnet'); assert.equal(input.action, 'stop');
        return { network: 'testnet', signerId: input.ownerId, receiverId: 'synthetic-mandate.testnet', methodName: 'stop', args: {}, gas: '100000000000000', deposit: '0' };
      },
      async reconcile(input) {
        reconciles++;
        return { networkId: 'testnet', ownerId: input.ownerId, mandateId: input.manifest.binding.mandateId,
          action: input.action, transactionHash: input.transactionHash, signerId: input.ownerId, status: 'UNKNOWN' };
      },
    } });
  // SYNTHETIC existing records, not an admission or chain qualification receipt.
  const syntheticScope = { networkId: 'testnet', mandateId: 'synthetic-mandate.testnet', purpose: 'SYNTHETIC HOST RECOVERY',
    output: 'SYNTHETIC observations only', vendorIds: ['synthetic-vendor.testnet'], budgetAtomic: '30', expiresAt: '2026-11-13T18:00:00Z' };
  const syntheticQuote = { networkId: 'testnet', mandateId: syntheticScope.mandateId,
    vendorId: syntheticScope.vendorIds[0], amountAtomic: '8', orderId: 'synthetic-order', content: 'SYNTHETIC recovery sample' };
  const quoteId = quoteKey(syntheticQuote);
  await f.repository.runTransaction(async tx => {
    tx.create('jobs', 'synthetic-job', { jobId: 'synthetic-job', ownerId: 'synthetic.testnet', quoteId,
      state: 'LOCAL_ACTIVE', qualification: 'PUBLIC_TESTNET_FICTIONAL_VENDOR', scope: syntheticScope,
      publicManifest: { manifestId: 'synthetic-manifest', approved: { job: syntheticScope, quote: syntheticQuote }, binding: { mandateId: syntheticScope.mandateId },
        rpcUrl: 'https://offline-economics.invalid', allowedRpcUrls: ['https://offline-economics.invalid'],
        chainEvidence: { networkId: 'testnet', finality: 'final', blockHash: '11111111111111111111111111111111',
          blockHeight: 123, observedAt: Date.now(), deployment: 'MANDATE_READY' } } });
    tx.create('quotes', quoteId, { jobId: 'synthetic-job', ownerId: 'synthetic.testnet', quote: syntheticQuote });
    tx.create('orders', quoteId, { jobId: 'synthetic-job', quoteId, quote: syntheticQuote, orderId: 'synthetic-order', lifecycle: 'PAYMENT_PENDING', proof: null, artifact: null });
    tx.create('nativeOperations', quoteId, { status: 'UNKNOWN' });
  });
  const cookie = await f.login(), path = '/api/public/jobs/synthetic-job';
  const read = await f.post(path, {}, { cookie });
  assert.equal(read.status, 200, read.text);
  const observed = JSON.parse(read.text);
  assert.equal(observed.job.jobId, 'synthetic-job'); assert.equal(observed.job.state, 'ACTIVE');
  assert.equal(observed.job.ownerCreationRequired, false);
  assert.equal(observed.ownerApproval.manifestId, 'synthetic-manifest');
  assert.deepEqual(observed.ownerApproval.actions.stop, { network: 'testnet', owner: 'synthetic.testnet',
    mandate: syntheticScope.mandateId, kind: 'stop', gas: '100000000000000' });
  assert.equal(observed.ownerApproval.actions.create, null);
  assert.equal(observed.payment.status, 'ATTENTION_REQUIRED'); assert.equal(observed.payment.transactionHash, null);
  assert.equal(observed.order.lifecycle, 'PAYMENT_PENDING'); assert.equal(observed.order.proof, null); assert.equal(observed.run, null);
  assert.equal((await call(f.server, path, { headers: { ...apiHeaders, cookie } })).status, 200);
  assert.equal((await call(f.server, path, { headers: { cookie, 'x-haldir-csrf': '1' } })).status, 403, 'legacy GET still requires actual Origin');
  const other = await f.login('other-synthetic.testnet');
  assert.equal((await f.post(path, {}, { cookie: other })).status, 404);
  assert.equal((await f.post(path, { ownerId: 'synthetic.testnet' }, { cookie: other })).status, 400);
  for (const route of ['run', 'resume']) assert.equal((await f.post(path + '/' + route, {}, { cookie })).status, 503);
  assert.equal((await f.post(path + '/owner/prepare', { action: 'create' }, { cookie })).status, 503);
  const prepared = await f.post(path + '/owner/prepare', { action: 'stop' }, { cookie });
  assert.equal(prepared.status, 200, prepared.text);
  const op = JSON.parse(prepared.text).operation;
  assert.equal(op.status, 'AWAITING_WALLET'); assert.equal(op.receipt, null);
  assert.equal((await f.post(path + '/owner/receipt', { operationId: op.operationId,
    transactionHash: '11111111111111111111111111111111', signerId: 'synthetic.testnet' }, { cookie })).status, 200);
  const after = JSON.parse((await f.post(path, {}, { cookie })).text);
  assert.equal(after.job.state, 'ACTIVE'); assert.equal(after.ownerOperations[0].status, 'UNKNOWN');
  assert.deepEqual(after.ownerApproval, observed.ownerApproval, 'immutable approval terms do not derive from the candidate request or unknown wallet outcome');
  assert.equal(after.ownerOperations[0].receipt, null); assert.equal(after.order.proof, null);
  assert.equal(prepares, 1); assert.equal(reconciles, 1);
});

test('economics HTTP host passes the trusted reader after its read-only snapshot and preserves the prior view', async t => {
  // Constructor reader fixture ONLY: not the real RPC reader/composition proof.
  const base = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => base.close());
  let depth = 0, writes = 0, calls = 0, retainedSignal, state = 'known';
  const repository = { async runTransaction(cb) {
    return base.runTransaction(async tx => { depth++;
      try { return await cb({ ...tx, set(...args) { writes++; return tx.set(...args); }, create(...args) { writes++; return tx.create(...args); } }); }
      finally { depth--; }
    });
  } };
  const publicKey = KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const clock = Date.now(), blockHash = '11111111111111111111111111111111';
  const scope = { networkId: 'testnet', mandateId: 'economics.testnet', purpose: 'Synthetic economic read', output: 'Synthetic report',
    vendorIds: ['vendor.testnet'], budgetAtomic: '30', expiresAt: new Date(clock + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
  const manifest = { manifestId: 'economic-approval', ownerId: 'synthetic.testnet', approved: { job: scope,
    quote: { networkId: 'testnet', mandateId: scope.mandateId, vendorId: 'vendor.testnet', amountAtomic: '8', orderId: 'economic-order', content: 'Synthetic sample' } },
    binding: { networkId: 'testnet', ownerId: 'synthetic.testnet', signerId: 'agent.testnet', mandateId: scope.mandateId, publicKey, maxAllowanceAtomic: '1000', codeHash: blockHash },
    rpcUrl: 'https://offline-economics.invalid', allowedRpcUrls: ['https://offline-economics.invalid'],
    chainEvidence: { networkId: 'testnet', finality: 'final', blockHash, blockHeight: 123, observedAt: clock } };
  const observed = () => ({ schemaVersion: 'haldir.mandate-economics.v1', state, networkId: 'testnet', ownerId: manifest.ownerId, mandateId: scope.mandateId,
    source: { rpcUrl: manifest.rpcUrl, method: 'get_status', finality: 'final' },
    observation: { blockHash, blockHeight: 124, blockTimestampNs: String(BigInt(clock - (state === 'stale' ? 31000 : 0)) * 1000000n), observedAt: clock },
    amounts: { capAtomic: '30', spentAtomic: '8', reservedAtomic: '4', availableAtomic: '15', refundedAtomic: '3' }, reason: state === 'stale' ? 'STALE_BLOCK' : null });
  const f = await authenticatedFixture(t, { repository,
    trustedManifestProvider: async () => structuredClone(manifest), trustedSignerProvider: async () => assert.fail('read cannot resolve signer'),
    model: { propose: async () => assert.fail('read cannot infer') },
    capabilities: { financialActions: true, publicTestnet: true, qualifiedModel: true, qualifiedSigning: true },
    trustedMandateStatusReader: async input => {
      calls++; assert.equal(depth, 0, 'RPC/reader must not run inside retriable storage transaction');
      assert.deepEqual(Object.keys(input).sort(), ['jobId', 'manifest', 'ownerId', 'signal']);
      assert.equal(input.ownerId, manifest.ownerId); assert.deepEqual(input.manifest, manifest);
      assert.ok(input.signal instanceof AbortSignal); assert.equal(input.signal.aborted, false); retainedSignal = input.signal;
      return observed();
    } });
  const cookie = await f.login();
  const admitted = await f.post('/api/public/jobs', { approvalId: 'economic-approval', admissionKey: 'economic' }, { cookie });
  assert.equal(admitted.status, 201, admitted.text);
  const first = JSON.parse(admitted.text); assert.deepEqual(first.economics, observed());
  assert.equal(retainedSignal.aborted, true, 'bounded read capability closes after return');
  const { economics, ...prior } = first;
  assert.deepEqual(Object.keys(prior).sort(), ['contractVersion', 'job', 'order', 'run', 'payment', 'ownerOperations', 'ownerApproval', 'disclosures'].sort());
  assert.equal(prior.order.quote.amountAtomic, '8'); assert.equal(prior.payment.status, 'NOT_STARTED'); assert.equal(prior.run, null);
  const path = `/api/public/jobs/${first.job.jobId}`, before = writes;
  state = 'stale';
  const read = await f.post(path, {}, { cookie }); assert.equal(read.status, 200, read.text);
  const { economics: stale, ...unchanged } = JSON.parse(read.text);
  assert.deepEqual(stale, observed()); assert.deepEqual(unchanged, prior); assert.equal(writes, before, 'view creates no durable economic/financial/model state');
  assert.equal(calls, 2);
  assert.equal((await f.post(path, {}, { cookie, origin: 'https://evil.invalid' })).status, 403);
  const other = await f.login('other.testnet'); assert.equal((await f.post(path, {}, { cookie: other })).status, 404); assert.equal(calls, 2);
});

test('landing routing: GET and HEAD finite documents and in-place legacy aliases', async t => {
  const s = await fixture(t);
  for (const path of ['/', '/app', '/demo', '/?mode=public-testnet',
    '/?mode=public-testnet&utm_source=colleague', '/?mode=simulation',
    '/?mode=public-testnet&extra=1', '/?utm_source=colleague',
    '/?next=https%3A%2F%2Fevil.invalid', '/app?returnTo=%2F%2Fevil.invalid']) {
    await t.test(path, async () => {
      for (const method of ['GET', 'HEAD']) {
        const page = await call(s, path, { method });
        assert.equal(page.status, 200, `${method} ${path}`);
        assert.equal(page.text, method === 'HEAD' ? '' : syntheticHtml, path);
        assert.equal(page.headers.location, undefined, path);
        assert.match(page.headers['content-type'], /^text\/html/);
        assert.equal(page.headers['cache-control'], 'no-store');
        assert.equal(page.headers['x-content-type-options'], 'nosniff');
        assert.equal(page.headers['x-frame-options'], 'DENY');
      }
    });
  }
});

test('landing routing: query-bearing known assets keep exact bytes and MIME, including HEAD', async t => {
  const s = await fixture(t);
  for (const [path, bytes, type] of [
    ['/assets/synthetic.js?v=1', syntheticJs, 'text/javascript; charset=utf-8'],
    ['/fonts/Synthetic%5Bwght%5D.ttf?v=1', 'SYNTHETIC FONT', 'font/ttf'],
  ]) {
    await t.test(path, async () => {
      for (const method of ['GET', 'HEAD']) {
        const asset = await call(s, path, { method });
        assert.equal(asset.status, 200, `${method} ${path}`);
        assert.equal(asset.text, method === 'HEAD' ? '' : bytes);
        assert.equal(asset.headers['content-type'], type);
        assert.equal(asset.headers.location, undefined);
        assert.equal(asset.headers['x-content-type-options'], 'nosniff');
      }
    });
  }
});

test('landing routing: unknown documents, modes, APIs and missing assets stay JSON 404 without fallback', async t => {
  const s = await fixture(t);
  for (const path of ['/app/', '/demo/', '/app/jobs/untrusted', '/missing', '/login',
    '/?mode=unknown', '/?mode=', '/?mode=public-testnet&mode=simulation',
    '/?mode=public-testnet&mode=public-testnet', '/?mode=simulation&%6dode=simulation',
    '/app?mode=simulation', '/demo?mode=public-testnet', '/app?mode=',
    '/?mode=testnet', '/?mode=local-qualification', '/?mode=wallet-auth-qualification',
    '/assets/missing-hash.js', '/assets/missing-hash.css?v=1', '/fonts/missing.ttf',
    '/assets/../index.html', '/assets/%2e%2e/index.html', '/assets/%2F..%2Findex.html',
    '/assets/synthetic.js/extra', '/./app', '/%61pp', '//app', '/app%2f',
    '/index.html', '/api/unknown', '/.env', '/node_modules/x', '/src/server/orders.mjs', '/readyz']) {
    for (const method of ['GET', 'HEAD']) {
      const missing = await call(s, path, { method });
      assert.equal(missing.status, 404, `${method} ${path}`);
      assert.match(missing.headers['content-type'], /^application\/json/);
      assert.equal(missing.text, method === 'HEAD' ? '' : '{"error":"NOT_FOUND"}', path);
      assert.equal(missing.headers.location, undefined, path);
    }
  }
  for (const path of ['/', '/app', '/demo', '/?mode=public-testnet', '/?mode=simulation']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const rejected = await call(s, path, { method });
      assert.equal(rejected.status, 404, `${method} ${path}`);
      assert.deepEqual(JSON.parse(rejected.text), { error: 'NOT_FOUND' });
    }
  }
});

function callRawHeaders(server, path, rawHeaders, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: rawHeaders, setHost: false }, res => {
      const chunks = []; res.on('data', b => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
}

test('landing routing: exact raw Host required; forwarded spoofing cannot authorize documents or assets', async t => {
  const s = await fixture(t);
  const invalid = [['Host', 'evil.example'], ['Host', 'haldir.example:443'],
    ['Host', 'HALDIR.EXAMPLE'], ['Host', 'haldir.example', 'hOsT', 'haldir.example'],
    ['Host', 'haldir.example', 'Host', 'evil.example']];
  for (const path of ['/', '/app', '/demo', '/?mode=public-testnet', '/?mode=simulation', '/assets/synthetic.js?v=1']) {
    for (const headers of invalid) {
      const res = await callRawHeaders(s, path, [...headers, 'X-Forwarded-Host', 'haldir.example',
        'Forwarded', 'host=haldir.example;proto=https']);
      assert.equal(res.status, 403, `${path}: ${JSON.stringify(headers)}`);
      assert.deepEqual(JSON.parse(res.text), { error: 'HOST_REQUIRED' });
      assert.equal(res.headers.location, undefined);
    }
    // Node 26 rejects missing HTTP/1.1 Host before the application handler.
    assert.equal((await callRawHeaders(s, path, [])).status, 400);
    assert.equal((await call(s, path, { headers: { 'x-forwarded-host': 'evil.example' } })).status, 200);
  }
});

test('landing routing: only exact GET health is the Host-exempt liveness probe', async t => {
  const s = await fixture(t);
  assert.equal((await callRawHeaders(s, '/healthz', [])).status, 400, 'Node parser rejects absent HTTP/1.1 Host before health exception');
  for (const headers of [['Host', 'probe.internal'], ['Host', 'bad', 'Host', 'duplicate']]) {
    const alive = await callRawHeaders(s, '/healthz', headers);
    assert.equal(alive.status, 200);
    assert.deepEqual(JSON.parse(alive.text), { alive: true });
    assert.equal(alive.headers.location, undefined);
  }
  for (const [path, method] of [['/healthz', 'HEAD'], ['/healthz', 'POST'], ['/healthz?x=1', 'GET'], ['/readyz', 'GET']]) {
    const rejected = await call(s, path, { method });
    assert.equal(rejected.status, 404, `${method} ${path}`);
    assert.equal(rejected.text, method === 'HEAD' ? '' : '{"error":"NOT_FOUND"}');
    assert.equal((await callRawHeaders(s, path, ['Host', 'probe.internal'], method)).status, 403);
  }
});

test('landing routing: unknown mounted APIs preserve Origin/CSRF then route then authentication guard order', async t => {
  const f = await authenticatedFixture(t);
  const cookie = await f.login();
  const before = f.observations();
  for (const path of ['/api/wallet-auth/unknown', '/api/public/unknown',
    '/api/wallet-auth/session?extra=1', '/api/public/config?extra=1']) {
    for (const method of ['GET', 'POST']) {
      for (const authenticated of [false, true]) {
        const headers = { ...apiHeaders, ...(authenticated ? { cookie } : {}) };
        const unknown = await call(f.server, path, { method, body: method === 'POST' ? {} : undefined, headers });
        assert.equal(unknown.status, 404, `${method} ${path}`);
        assert.equal(JSON.parse(unknown.text).error, 'NOT_FOUND');
        assert.match(unknown.headers['content-type'], /^application\/json/);
        assert.equal(unknown.headers.location, undefined);
        for (const bad of ['missing-origin', 'wrong-origin', 'missing-csrf', 'cross-site']) {
          const deniedHeaders = { ...headers };
          if (bad === 'missing-origin') delete deniedHeaders.origin;
          if (bad === 'wrong-origin') deniedHeaders.origin = 'https://evil.example';
          if (bad === 'missing-csrf') delete deniedHeaders['x-haldir-csrf'];
          if (bad === 'cross-site') deniedHeaders['sec-fetch-site'] = 'cross-site';
          const denied = await call(f.server, path, { method, headers: deniedHeaders });
          assert.equal(denied.status, 403, `${method} ${path}: ${bad}`);
          assert.equal(JSON.parse(denied.text).error, 'ORIGIN_CSRF_REQUIRED');
        }
      }
    }
  }
  assert.equal(f.observations(), before, 'unknown routes never reach session key observations');
  assert.equal((await f.post('/api/public/jobs/missing-job')).status, 401);
  assert.equal((await f.post('/api/public/jobs/missing-job', {}, { cookie })).status, 404);
  assert.equal((await f.post('/api/wallet-auth/session')).status, 401);
  assert.equal((await f.post('/api/wallet-auth/session', {}, { cookie })).status, 200);
});
