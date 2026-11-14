import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createPreviewServer } from './server.mjs';
import { KeyPair } from 'near-api-js';
import { serializeMessageNep413 } from '@meteorwallet/sdk';
import { openLocalRepository } from '../../src/server/orders.mjs';
import { createNearOwnerKeyReader } from '../../src/server/near-owner-keys.mjs';
// Global fetch is forbidden: only owned loopback sockets and an explicit RPC fixture are used.
globalThis.fetch = () => { throw new Error('OFFLINE_ONLY'); };
const origin = 'https://haldir.example';
const uiDir = new URL('./ui/', import.meta.url); // produced by build-local-ui.mjs, not a stale prototype/dist
function call(server, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { host: 'haldir.example', ...headers } }, res => {
      const chunks = [];
      res.on('data', x => chunks.push(x));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(t, config = {}) {
  const server = await createPreviewServer({ uiDir, approvedOrigin: origin,
    repository: { runTransaction: () => { throw new Error('not used by static test'); } },
    trustedAccessKeyReader: async () => null, ...config });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server;
}
test('existing UI is served only through the login entry, with no generic SPA or filesystem fallback', async t => {
  const s = await fixture(t);
  const root = await call(s, '/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, '/?mode=wallet-auth-qualification');
  const page = await call(s, '/?mode=wallet-auth-qualification');
  assert.equal(page.status, 200); assert.match(page.text, /<div id="root">/);
  const asset = page.text.match(/src="([^" ]+\.js)"/)[1];
  assert.equal((await call(s, asset)).status, 200);
  assert.equal((await call(s, '/fonts/manrope/Manrope%5Bwght%5D.ttf')).status, 200);
  assert.equal((await call(s, '/fonts/manrope/Manrope%5Bwght%5D.ttf', { method: 'HEAD' })).headers['content-type'], 'font/ttf');
  for (const path of ['/?mode=local-qualification', '/?mode=simulation', '/src/server/orders.mjs', '/.hermes/reviews/x', '/node_modules/x', '/assets/../index.html', '/api/jobs', '/api/pay', '/api/stop', '/api/withdraw', '/internal/tick']) {
    assert.equal((await call(s, path)).status, 404, path);
  }
  assert.equal((await call(s, '/', { headers: { host: 'evil.example', 'x-forwarded-host': 'haldir.example' } })).status, 403);
  assert.equal((await call(s, '/healthz', { headers: { host: 'probe.internal' } })).status, 200);
  assert.equal((await call(s, '/readyz')).status, 404, 'no false DB-readiness endpoint');
});
test('mounted real authentication: signature, Secure cookie, session, replay, CSRF, logout; LOCAL adapters only', async t => {
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => repository.close());
  const pair = KeyPair.fromRandom('ed25519'); // disposable fixture key, never an owner credential
  const publicKey = pair.getPublicKey().toString();
  let rpcCalls = 0;
  const trustedAccessKeyReader = createNearOwnerKeyReader({ rpcUrl: 'https://rpc.testnet.near.org',
    transport: async (url, init) => {
      assert.equal(url, 'https://rpc.testnet.near.org');
      const r = JSON.parse(init.body); rpcCalls++;
      assert.ok(['status', 'query'].includes(r.method));
      if (r.method === 'query') { assert.equal(r.params.public_key, publicKey); assert.equal(r.params.finality, 'final'); }
      return Response.json({ jsonrpc: '2.0', id: r.id, result: r.method === 'status' ?
        { chain_id: 'testnet', sync_info: { syncing: false } } :
        { permission: 'FullAccess', nonce: 1, block_height: 123, block_hash: '11111111111111111111111111111111' } });
    } });
  const s = await fixture(t, { repository, trustedAccessKeyReader });
  const headers = { origin, 'content-type': 'application/json', 'x-haldir-csrf': '1', 'sec-fetch-site': 'same-origin' };
  const post = (route, body, extra = {}) => call(s, `/api/wallet-auth/${route}`, { method: 'POST', body, headers: { ...headers, ...extra } });
  const context = { accountId: 'fixture.testnet', networkId: 'testnet' };
  const challenge = await post('challenge', context);
  assert.equal(challenge.status, 200, challenge.text);
  const c = JSON.parse(challenge.text);
  assert.equal(c.origin, origin); assert.equal(c.payload.recipient, 'haldir.example');
  assert.equal(rpcCalls, 0);
  const proof = { ...context, challengeId: c.challengeId, publicKey, signature: Buffer.from(pair.sign(
    serializeMessageNep413({ ...c.payload, nonce: Buffer.from(c.payload.nonce, 'base64') })).signature).toString('base64') };
  assert.equal((await post('verify', proof, { origin: 'https://evil.example' })).status, 403);
  assert.equal(rpcCalls, 0);
  const verified = await post('verify', proof);
  assert.equal(verified.status, 200, verified.text);
  assert.match(verified.headers['set-cookie'][0], /; Path=\/; HttpOnly; Secure; SameSite=Strict;/);
  const cookie = verified.headers['set-cookie'][0].split(';')[0];
  assert.equal(verified.text.includes(cookie.split('=')[1]), false);
  assert.equal(JSON.parse(verified.text).principal.authenticationOnly, true);
  assert.equal((await post('session', {}, { cookie })).status, 200);
  assert.equal((await post('verify', proof)).status, 401);
  assert.equal((await post('session', {}, { cookie, 'x-haldir-csrf': '' })).status, 403);
  assert.equal((await call(s, '/api/pay', { method: 'POST', body: {}, headers: { ...headers, cookie } })).status, 404);
  assert.equal((await post('logout', {}, { cookie })).status, 200);
  assert.equal((await post('session', {}, { cookie })).status, 401);
  assert.equal(rpcCalls, 4);
});
