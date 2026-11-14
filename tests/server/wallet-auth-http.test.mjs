import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KeyPair } from 'near-api-js';
import { serializeMessageNep413 } from '@meteorwallet/sdk';
import { openLocalRepository } from '../../src/server/orders.mjs';
import { createNearOwnerKeyReader } from '../../src/server/near-owner-keys.mjs';
import { createWalletAuthHttp } from '../../src/server/wallet-auth-http.mjs';

// Only owned ephemeral loopback HTTP is real. RPC uses actual SDK methods and an
// injected, closed transport. No wallet prompts, external calls or credentials.
globalThis.fetch = () => { throw new Error('wallet-auth-http qualification forbids external fetch'); };
const origin = 'https://haldir.example';
const recipient = 'haldir.example';
const accountId = 'alice.testnet';
const networkId = 'testnet';
const prefix = '/api/wallet-auth/';
const context = { accountId, networkId };
const cookieName = '__Host-haldir_session';
const initialTime = 1_799_999_999_000;
function call(base, route, body = {}, options = {}) {
  const bytes = options.raw ?? Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(route.startsWith('/') ? route : prefix + route, base), {
      method: options.method ?? 'POST', path: options.rawPath ?? new URL(route.startsWith('/') ? route : prefix + route, base).pathname + new URL(route.startsWith('/') ? route : prefix + route, base).search, headers: { host: 'haldir.example', origin,
        'x-haldir-csrf': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
        ...options.headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, text, body: JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (options.slow) { req.write('{'); return; }
    req.end(bytes);
  });
}
async function fixture(t, options = {}) {
  const repository = options.repository ?? openLocalRepository({ filename: ':memory:', localTestOnly: true });
  if (!options.repository) t.after(() => repository.close());
  const pair = KeyPair.fromRandom('ed25519');
  const publicKey = pair.getPublicKey().toString();
  const requests = [];
  let time = initialTime;
  let handler;
  const transport = async (url, init) => {
    assert.equal(url, 'https://rpc.testnet.near.org');
    assert.equal(init.redirect, 'error');
    const r = JSON.parse(init.body); requests.push(r);
    const result = handler ? await handler(r, init) : undefined;
    if (result instanceof Response) return result;
    if (r.method === 'status') return Response.json({ jsonrpc: '2.0', id: r.id,
      result: result ?? { chain_id: 'testnet', sync_info: { syncing: false } } });
    assert.equal(r.method, 'query');
    assert.equal(r.params.request_type, 'view_access_key');
    assert.equal(r.params.finality, 'final');
    return Response.json({ jsonrpc: '2.0', id: r.id, result: result ?? {
      permission: r.params.public_key === publicKey ? 'FullAccess' : { FunctionCall: {} },
      nonce: 1, block_height: 123, block_hash: '11111111111111111111111111111111',
    } });
  };
  const trustedAccessKeyReader = createNearOwnerKeyReader({ rpcUrl: 'https://rpc.testnet.near.org',
    transport, now: () => time, timeoutMs: 1000 });
  const config = { repository, approvedOrigin: origin, approvedRecipient: recipient,
    trustedAccessKeyReader, now: () => time, ...options };
  const app = createWalletAuthHttp(config);
  const { origin: base } = await app.listen();
  t.after(() => app.close());
  const f = { app, base, config, repository, pair, publicKey, requests,
    setHandler: value => { handler = value; }, setTime: value => { time = value; } };
  f.challenge = async () => {
    const res = await call(base, 'challenge', context); assert.equal(res.status, 200, res.text); return res.body;
  };
  f.proof = (c, payload = c.payload, signingPair = pair) => ({ ...context, challengeId: c.challengeId,
    publicKey: signingPair.getPublicKey().toString(), signature: Buffer.from(signingPair.sign(
      serializeMessageNep413({ ...payload, nonce: Buffer.from(payload.nonce, 'base64') })).signature).toString('base64') });
  f.login = async () => {
    const c = await f.challenge(); const proof = f.proof(c);
    const res = await call(base, 'verify', proof); assert.equal(res.status, 200, res.text);
    const cookie = res.headers['set-cookie'][0].split(';')[0]; return { ...res, cookie, c, proof };
  };
  return f;
}

test('real loopback challenge -> Meteor NEP413 -> HttpOnly cookie -> session -> logout, without JSON bearer', async t => {
  const f = await fixture(t);
  const c = await f.challenge();
  assert.equal(c.origin, origin); assert.equal(c.networkId, networkId);
  assert.equal(Buffer.from(c.payload.nonce, 'base64').length, 32);
  assert.equal(c.payload.recipient, recipient);
  assert.match(JSON.parse(c.payload.message).notice, /does not authorize create\/pay\/stop\/withdraw/);
  assert.equal(f.requests.length, 0, 'challenge does not query keys or prompt a wallet');
  const res = await call(f.base, 'verify', f.proof(c));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(Object.keys(res.body), ['principal']);
  assert.equal(res.body.principal.authenticationOnly, true);
  const setCookie = res.headers['set-cookie'][0];
  assert.match(setCookie, /^__Host-haldir_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=900$/);
  const cookie = setCookie.split(';')[0];
  assert.equal(res.text.includes(cookie.split('=')[1]), false);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.deepEqual((await call(f.base, 'session', {}, { headers: { cookie } })).body, res.body);
  const logout = await call(f.base, 'logout', {}, { headers: { cookie } });
  assert.deepEqual(logout.body, { loggedOut: true });
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await call(f.base, 'session', {}, { headers: { cookie } })).status, 401);
});

test('every route requires exact Origin, Host, CSRF and same-origin fetch metadata before any authority', async t => {
  const f = await fixture(t);
  const login = await f.login();
  for (const [route, body] of [['challenge', context], ['verify', login.proof], ['session', {}], ['logout', {}]]) {
    for (const headers of [
      { origin: '' }, { origin: 'null' }, { origin: origin + '/' }, { origin: 'https://evil.example' },
      { host: 'evil.example', 'x-forwarded-host': 'haldir.example' },
      { 'x-haldir-csrf': '' }, { 'x-haldir-csrf': 'true' }, { 'sec-fetch-site': 'cross-site' },
      { origin: [origin, origin] }, { 'x-haldir-csrf': ['1', '1'] }, { 'sec-fetch-site': ['same-origin', 'same-origin'] },
    ]) {
      const r = await call(f.base, route, body, { headers: { cookie: login.cookie, ...headers } });
      assert.equal(r.status, 403, `${route} ${JSON.stringify(headers)} ${r.text}`);
      assert.equal(r.headers['set-cookie'], undefined);
    }
  }
  assert.equal((await call(f.base, 'session', {}, { headers: { cookie: login.cookie } })).status, 200);
  assert.equal(f.requests.length, 4, 'blocked calls do not query keys or revoke the session');
});

test('exact flat JSON shapes exclude browser origin/owner-key/evidence/token inputs and duplicates', async t => {
  const f = await fixture(t), c = await f.challenge(), proof = f.proof(c);
  for (const [route, body] of [['challenge', context], ['verify', proof], ['session', {}], ['logout', {}]]) {
    for (const field of ['origin', 'ownerKeys', 'trustedAccessKeyReader', 'permission', 'payload', 'token', 'privateKey', 'testOnlySession']) {
      const r = await call(f.base, route, { ...body, [field]: 'PRIVATE_SENTINEL' });
      assert.equal(r.status, 400, `${route} ${field} ${r.text}`);
      assert.equal(r.text.includes('PRIVATE_SENTINEL'), false);
    }
    for (const bad of [null, [], 'string']) assert.equal((await call(f.base, route, bad)).status, 400);
    for (const key of Object.keys(body)) {
      const omitted = { ...body }; delete omitted[key];
      assert.equal((await call(f.base, route, omitted)).status, 400);
      assert.equal((await call(f.base, route, { ...body, [key]: null })).status, 400);
    }
  }
  for (const raw of [
    '{"accountId":"bob.testnet","accountId":"alice.testnet","networkId":"testnet"}',
    '{"accountId":"bob.testnet","account\\u0049d":"alice.testnet","networkId":"testnet"}',
    '{"accountId":"alice.testnet","networkId":"testnet","extra":{}}',
  ]) assert.equal((await call(f.base, 'challenge', {}, { raw: Buffer.from(raw) })).status, 400);
  assert.equal(f.requests.length, 0);
});

test('bounded bytes, fatal UTF8, JSON media type, exact routes and finite slow-body deadline', async t => {
  const f = await fixture(t, { bodyTimeoutMs: 30 });
  for (const [raw, status] of [[Buffer.alloc(4097, 65), 413], [Buffer.from('{'), 400], [Buffer.from([0xff]), 400]]) {
    assert.equal((await call(f.base, 'challenge', {}, { raw })).status, status);
  }
  assert.equal((await call(f.base, 'challenge', context, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call(f.base, 'challenge', context, { headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await call(f.base, 'challenge', {}, { slow: true })).status, 408);
  for (const route of ['/api/wallet-auth/challenge?x=1', '/api/wallet-auth/%63hallenge',
    '/api/wallet-auth/../wallet-auth/challenge', '/api/wallet-auth/challenge/', '/api/jobs', '/api/pay', '/api/stop', '/api/withdraw', '/api/wallet-auth/revoke']) {
    // Raw path is set below for traversal tests because URL() normally normalizes it.
    const r = await call(f.base, route, context, { rawPath: route });
    assert.equal(r.status, 404, route);
  }
  for (const method of ['GET', 'OPTIONS', 'PUT']) assert.equal((await call(f.base, 'challenge', context, { method })).status, 404);
  assert.equal(f.requests.length, 0);
});

test('signature, account/network/origin/nonce tampering and replay fail without consuming an honest proof', async t => {
  const f = await fixture(t), c = await f.challenge(), proof = f.proof(c);
  for (const change of [{ accountId: 'bob.testnet' }, { networkId: 'mainnet' },
    { signature: Buffer.alloc(64).toString('base64') }, { challengeId: 'A'.repeat(43) }]) {
    assert.equal((await call(f.base, 'verify', { ...proof, ...change })).status, 401);
  }
  for (const payload of [{ ...c.payload, nonce: Buffer.alloc(32, 8).toString('base64') },
    { ...c.payload, message: c.payload.message.replace(origin, 'https://evil.example') },
    { ...c.payload, recipient: 'evil.example' },
    { ...c.payload, message: c.payload.message.replace('testnet', 'mainnet') },
    { ...c.payload, message: c.payload.message.replace(accountId, 'bob.testnet') }]) {
    assert.equal((await call(f.base, 'verify', f.proof(c, payload))).status, 401);
  }
  const good = await call(f.base, 'verify', proof);
  assert.equal(good.status, 200);
  const replay = await call(f.base, 'verify', proof);
  assert.equal(replay.status, 401); assert.equal(replay.headers['set-cookie'], undefined);
});

test('wrong, removed and FunctionCall-only keys never authenticate even with genuine signatures', async t => {
  const f = await fixture(t), c = await f.challenge();
  const other = KeyPair.fromRandom('ed25519');
  assert.equal((await call(f.base, 'verify', { ...f.proof(c, c.payload, other), publicKey: f.publicKey })).status, 401, 'genuine signature by the wrong key cannot verify against a current FullAccess key');
  assert.equal((await call(f.base, 'verify', f.proof(c, c.payload, other))).status, 401);
  f.setHandler(r => r.method === 'query' ? Response.json({ jsonrpc: '2.0', id: r.id, error: { data: { name: 'UNKNOWN_ACCESS_KEY' } } }) : undefined);
  const removed = await call(f.base, 'verify', f.proof(c));
  assert.equal(removed.status, 401); assert.equal(removed.headers['set-cookie'], undefined);
  // Same genuine owner signature with absent/downgraded chain membership.
  for (const permission of [null, { FunctionCall: { receiver_id: recipient, method_names: ['login'] } }]) {
    f.setHandler(r => r.method === 'query' ? { permission, nonce: 1, block_height: 123,
      block_hash: '11111111111111111111111111111111' } : undefined);
    assert.equal((await call(f.base, 'verify', f.proof(c))).status, 401);
  }
  f.setHandler(undefined);
  const login = await f.login();
  for (const make of [
    r => r.method === 'query' ? Response.json({ jsonrpc: '2.0', id: r.id, error: { message: 'PRIVATE_SENTINEL', data: { name: 'UNKNOWN_ACCESS_KEY' } } }) : undefined,
    r => r.method === 'query' ? { permission: { FunctionCall: {} }, nonce: 1, block_height: 123,
      block_hash: '11111111111111111111111111111111' } : undefined,
    r => r.method === 'status' ? { chain_id: 'mainnet', sync_info: { syncing: false } } : undefined,
  ]) {
    f.setHandler(make);
    const res = await call(f.base, 'session', {}, { headers: { cookie: login.cookie } });
    assert.equal(res.status, 401); assert.deepEqual(res.body, { error: 'UNAUTHENTICATED' });
    assert.equal(res.text.includes('PRIVATE_SENTINEL'), false);
  }
});

test('cookie-only authentication rejects bearer bodies/headers, malformed and duplicate cookies; missing logout is idempotent', async t => {
  const f = await fixture(t), login = await f.login();
  const token = login.cookie.split('=')[1];
  for (const cookie of ['', cookieName + '=garbage', login.cookie + '; ' + login.cookie,
    cookieName + '=' + token + '=', cookieName + '=' + encodeURIComponent(token + '+')]) {
    assert.equal((await call(f.base, 'session', {}, { headers: { cookie } })).status, 401);
  }
  assert.equal((await call(f.base, 'session', {}, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await call(f.base, 'session', { token })).status, 400);
  assert.equal((await call(f.base, 'logout')).status, 200);
  assert.equal((await call(f.base, 'session', {}, { headers: { cookie: login.cookie } })).status, 200);
});

test('challenge and session expire exactly at service TTL boundaries over HTTP', async t => {
  const f = await fixture(t), c = await f.challenge();
  f.setTime(c.expiresAt);
  assert.equal((await call(f.base, 'verify', f.proof(c))).status, 401);
  f.setTime(initialTime);
  const login = await f.login();
  f.setTime(login.body.principal.expiresAt);
  assert.equal((await call(f.base, 'session', {}, { headers: { cookie: login.cookie } })).status, 401);
});

test('two HTTP verifiers race one durable challenge: exactly one cookie is released', async t => {
  const f = await fixture(t), c = await f.challenge(), proof = f.proof(c);
  let arrivals = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  f.setHandler(async r => { if (r.method === 'query') { if (++arrivals === 2) release(); await gate; } });
  const responses = await Promise.all([call(f.base, 'verify', proof), call(f.base, 'verify', proof)]);
  assert.equal(arrivals, 2);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401]);
  assert.equal(responses.filter(r => r.headers['set-cookie']).length, 1);
});

test('HTTP logout during in-flight owner-key read fences session response and does not resurrect it', async t => {
  const f = await fixture(t), login = await f.login();
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.setHandler(async r => { if (r.method === 'query') { entered(); await gate; } });
  const session = call(f.base, 'session', {}, { headers: { cookie: login.cookie } });
  await waiting;
  assert.equal((await call(f.base, 'logout', {}, { headers: { cookie: login.cookie } })).status, 200);
  release();
  assert.equal((await session).status, 401);
});

test('HTTP listener/service recreation retains durable session, nonce consumption and logout', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'haldir-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = join(dir, 'sessions.sqlite');
  const a = openLocalRepository({ filename, localTestOnly: true });
  const f = await fixture(t, { repository: a });
  const login = await f.login();
  await f.app.close(); a.close();
  const b = openLocalRepository({ filename, localTestOnly: true });
  t.after(() => b.close());
  const app = createWalletAuthHttp({ ...f.config, repository: b });
  const { origin: base } = await app.listen(); t.after(() => app.close());
  assert.equal((await call(base, 'session', {}, { headers: { cookie: login.cookie } })).status, 200);
  assert.equal((await call(base, 'verify', login.proof)).status, 401);
  assert.equal((await call(base, 'logout', {}, { headers: { cookie: login.cookie } })).status, 200);
  assert.equal((await call(base, 'session', {}, { headers: { cookie: login.cookie } })).status, 401);
});

test('missing real configuration never falls back to testOnlySession; public bind remains unavailable', async t => {
  assert.throws(() => createWalletAuthHttp({ testOnlySession: () => accountId }), e => e.code === 'INVALID_CONFIG');
  const f = await fixture(t);
  await assert.rejects(f.app.listen({ host: '0.0.0.0' }), e => e.code === 'LOOPBACK_ONLY');
});

test('repository failures and upstream errors are redacted without logging proofs, cookies or owner-key claims', async t => {
  const logs = [];
  const originals = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(k => [k, console[k]]));
  for (const k of Object.keys(originals)) console[k] = (...args) => { logs.push(args); };
  try {
    const f = await fixture(t);
    const login = await f.login();
    f.setHandler(() => { throw new Error('PRIVATE_SENTINEL ' + login.cookie + ' ' + login.proof.signature); });
    const denied = await call(f.base, 'session', {}, { headers: { cookie: login.cookie } });
    assert.deepEqual(denied.body, { error: 'UNAUTHENTICATED' });
    const broken = createWalletAuthHttp({ ...f.config, repository: { runTransaction() {
      throw new Error('PRIVATE_SENTINEL ' + login.cookie);
    } } });
    const { origin: base } = await broken.listen(); t.after(() => broken.close());
    const failure = await call(base, 'challenge', context);
    assert.equal(failure.status, 500); assert.deepEqual(failure.body, { error: 'INTERNAL_ERROR' });
    assert.equal(failure.headers['set-cookie'], undefined);
    assert.deepEqual(logs, []);
  } finally { for (const [k, original] of Object.entries(originals)) console[k] = original; }
});

test('disconnecting an incomplete HTTP body cannot crash or bypass the bounded parser', async t => {
  const f = await fixture(t, { bodyTimeoutMs: 50 });
  await new Promise(resolve => {
    const req = httpRequest(f.base + prefix + 'challenge', { method: 'POST', headers: {
      host: 'haldir.example', origin, 'x-haldir-csrf': '1', 'content-type': 'application/json',
    } });
    req.on('error', () => {});
    req.write('{');
    req.on('socket', () => setTimeout(() => { req.destroy(); resolve(); }, 10));
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await call(f.base, 'challenge', context)).status, 200);
  assert.equal(f.requests.length, 0);
});

test('a fresh Node process serves persisted HTTP session and pending challenge, then persists logout', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'haldir-http-process-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = join(dir, 'sessions.sqlite');
  const repository = openLocalRepository({ filename, localTestOnly: true });
  const f = await fixture(t, { repository });
  const login = await f.login();
  const pending = await f.challenge(), pendingProof = f.proof(pending);
  await f.app.close(); repository.close();
  const source = `
    import { readFileSync } from 'node:fs';
    globalThis.fetch = () => { throw new Error('child forbids external fetch'); };
    const { createWalletAuthHttp } = await import('./src/server/wallet-auth-http.mjs');
    const { createNearOwnerKeyReader } = await import('./src/server/near-owner-keys.mjs');
    const { openLocalRepository } = await import('./src/server/orders.mjs');
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const repository = openLocalRepository({ filename: input.filename, localTestOnly: true });
    const transport = async (url, init) => {
      if (url !== 'https://rpc.testnet.near.org') throw new Error('wrong endpoint');
      const r = JSON.parse(init.body);
      let result;
      if (r.method === 'status') result = { chain_id: 'testnet', sync_info: { syncing: false } };
      else if (r.method === 'query' && r.params.request_type === 'view_access_key' &&
        r.params.finality === 'final' && r.params.public_key === input.publicKey) result = {
          permission: 'FullAccess', nonce: 1, block_height: 123, block_hash: '11111111111111111111111111111111' };
      else throw new Error('unexpected RPC');
      return Response.json({ jsonrpc: '2.0', id: r.id, result });
    };
    const trustedAccessKeyReader = createNearOwnerKeyReader({ rpcUrl: 'https://rpc.testnet.near.org', transport, now: () => input.time });
    const app = createWalletAuthHttp({ repository, approvedOrigin: input.origin,
      approvedRecipient: input.recipient, trustedAccessKeyReader, now: () => input.time });
    process.once('SIGTERM', async () => { await app.close(); repository.close(); process.exit(0); });
    process.stdout.write(JSON.stringify(await app.listen()) + String.fromCharCode(10));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('../..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.fromEntries(['PATH', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
  });
  let stdout = '', stderr = '';
  child.stderr.on('data', c => { stderr += c; });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exit; });
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', c => { stdout += c; if (stdout.includes('\n')) resolve(JSON.parse(stdout.trim())); });
    child.once('exit', () => reject(new Error('child exited before readiness: ' + stderr)));
  });
  child.stdin.end(JSON.stringify({ filename, origin, recipient, publicKey: f.publicKey, time: initialTime }));
  const { origin: base } = await ready;
  assert.equal((await call(base, 'session', {}, { headers: { cookie: login.cookie } })).status, 200);
  assert.equal((await call(base, 'verify', login.proof)).status, 401);
  assert.equal((await call(base, 'verify', pendingProof)).status, 200);
  assert.equal((await call(base, 'logout', {}, { headers: { cookie: login.cookie } })).status, 200);
  child.kill('SIGTERM');
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.equal(stderr, '');
  assert.equal(stdout.trim().split('\n').length, 1, 'child logs readiness only, never proofs or cookies');
  const reopened = openLocalRepository({ filename, localTestOnly: true });
  try {
    const row = await reopened.runTransaction(tx => tx.get('walletSessions', login.body.principal.sessionId));
    assert.equal(row.revokedAt, initialTime);
    assert.equal((await reopened.runTransaction(tx => tx.get('walletChallenges', pending.challengeId))).consumedAt, initialTime);
    assert.equal(JSON.stringify(row).includes(login.cookie.split('=')[1]), false);
  } finally { reopened.close(); }
});



