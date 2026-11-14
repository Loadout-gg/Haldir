import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { transform } from '../../node_modules/esbuild/lib/main.js';
import { KeyPair } from 'near-api-js';
import { serializeMessageNep413 } from '@meteorwallet/sdk';
import { createWalletAuthHttp } from '../../src/server/wallet-auth-http.mjs';
import { openLocalRepository } from '../../src/server/orders.mjs';

// Actual current client + original server parser/NEP413 verification. Only the
// request transport is adapted in-memory; NO listener, fetch, RPC or cookie jar.
const previousFetch = globalThis.fetch;
let forbiddenFetch = 0;
globalThis.fetch = () => { forbiddenFetch++; throw new Error('EXTERNAL_FETCH_FORBIDDEN'); };
const source = await readFile(new URL('../src/integration/wallet-auth.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { createWalletAuth } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const origin = 'https://approved-login.invalid', recipient = 'approved-login.invalid';
const accountId = 'alice.testnet', now = 1_800_000_000_000;

function fixture(t, validSignature = true) {
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => repository.close());
  const pair = KeyPair.fromRandom('ed25519'), publicKey = pair.getPublicKey().toString();
  const app = createWalletAuthHttp({ repository, approvedOrigin: origin, approvedRecipient: recipient, now: () => now,
    trustedAccessKeyReader: async tuple => ({ ...tuple, permission: 'FullAccess', finality: 'final', blockHeight: 123,
      blockHash: '11111111111111111111111111111111', observedAt: now }) });
  t.after(() => app.close());
  const requests = [], statuses = [], issuedCookies = [];
  const transport = async (url, init) => {
    assert.equal(new URL(url).origin, origin);
    assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), null); assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('origin'), null); assert.equal(headers.get('host'), null);
    const path = new URL(url).pathname;
    requests.push({ path, body: JSON.parse(init.body) });
    const req = new PassThrough();
    req.url = path; req.method = init.method;
    // Browser-generated headers, supplied solely by this closed request adapter.
    req.headers = { ...Object.fromEntries(headers), host: recipient, origin, 'sec-fetch-site': 'same-origin' };
    req.rawHeaders = Object.entries(req.headers).flat();
    const result = new Promise(resolve => {
      let status, responseHeaders;
      const res = { writeHead(s, h) { status = s; responseHeaders = h; }, end(body) {
        statuses.push(status);
        if (responseHeaders['set-cookie']) issuedCookies.push(responseHeaders['set-cookie']);
        resolve(new Response(body, { status, headers: responseHeaders }));
      } };
      void app.handle(req, res);
    });
    req.end(init.body);
    return result;
  };
  let prompts = 0, loads = 0, signedRequest;
  const loadMeteor = async () => { loads++; return {
    getAccount: async target => { assert.deepEqual(target, target.accountId === undefined ? { blockchain: 'near', network: 'testnet' } : { blockchain: 'near', network: 'testnet', accountId }); return { identifier: { ...target, accountId } }; },
    createAction: async request => {
      signedRequest = request;
      assert.equal(request.id, 'near::sign_message');
      assert.deepEqual(request.input.target, { blockchain: 'near', network: 'testnet', accountId });
      assert.equal(request.input.messageParams.nonce.length, 32);
      return { promptForExecution: async () => { prompts++; return { accountId, publicKey: pair.getPublicKey(),
        signature: validSignature ? pair.sign(serializeMessageNep413(request.input.messageParams)).signature : new Uint8Array(64) }; } };
    },
  }; };
  const makeClient = () => createWalletAuth({ origin, recipient, approvedOrigin: origin, secureContext: true, transport, loadMeteor, now: () => now });
  return { makeClient, requests, statuses, issuedCookies, publicKey, counts: () => ({ prompts, loads }), signed: () => signedRequest };
}

test('hosted client exact request shapes pass actual server parser/NEP413 but a missing cookie session never becomes authenticated', async t => {
  const f = fixture(t), client = f.makeClient();
  await client.resume(); assert.deepEqual(f.counts(), { prompts: 0, loads: 0 });
  await client.login();
  assert.deepEqual(f.statuses, [401, 200, 200, 401]);
  assert.deepEqual(f.requests[1], { path: '/api/wallet-auth/challenge', body: { accountId, networkId: 'testnet' } });
  const proof = f.requests[2].body;
  assert.deepEqual(Object.keys(proof).sort(), ['accountId', 'challengeId', 'networkId', 'publicKey', 'signature']);
  assert.equal(proof.publicKey, f.publicKey);
  assert.equal(proof.challengeId, JSON.parse(f.signed().input.messageParams.message).challengeId);
  assert.match(f.issuedCookies[0], /^__Host-haldir_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=900$/);
  assert.deepEqual(client.getSnapshot(), { principal: null, busy: false, error: 'UNAUTHENTICATED' });
  const reloaded = f.makeClient();
  await reloaded.resume(); await reloaded.logout();
  assert.deepEqual(reloaded.getSnapshot(), { principal: null, busy: false, error: null });
  assert.deepEqual(f.requests.slice(-2), [{ path: '/api/wallet-auth/session', body: {} }, { path: '/api/wallet-auth/logout', body: {} }]);
  assert.deepEqual(f.counts(), { prompts: 1, loads: 1 });
  assert.match(f.issuedCookies.at(-1), /Max-Age=0$/);
  assert.equal(forbiddenFetch, 0);
});

test('actual server signature rejection is redacted and cannot produce client authenticated state or a session read', async t => {
  const f = fixture(t, false), client = f.makeClient();
  await client.login();
  assert.deepEqual(f.statuses, [200, 401]);
  assert.deepEqual(client.getSnapshot(), { principal: null, busy: false, error: 'UNAUTHENTICATED' });
  assert.deepEqual(f.counts(), { prompts: 1, loads: 1 });
  assert.deepEqual(f.issuedCookies, []);
  assert.equal(forbiddenFetch, 0);
});

test.after(() => { globalThis.fetch = previousFetch; assert.equal(forbiddenFetch, 0); });
