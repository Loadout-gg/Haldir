import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { serializeMessageNep413 } from '@meteorwallet/sdk';
import { openLocalRepository } from '../../src/server/orders.mjs';
import { createWalletSessions } from '../../src/server/wallet-session.mjs';

// No credentials, wallet prompts, providers or network in this qualification.
globalThis.fetch = () => { throw new Error('offline wallet-session test forbids fetch'); };
const origin = 'https://haldir.example';
const recipient = 'haldir.example';
const accountId = 'alice.testnet';
const networkId = 'testnet';
const initialTime = Date.parse('2026-11-12T12:00:00Z');
function fixture(t, overrides = {}) {
  let time = initialTime;
  const pair = KeyPair.fromRandom('ed25519'); // ephemeral, never serialized to disk
  const publicKey = pair.getPublicKey().toString();
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => repository.close());
  const reads = [];
  const reader = async query => {
    reads.push(structuredClone(query));
    return { ...query, permission: 'FullAccess', observedAt: time, finality: 'final',
      blockHeight: 123, blockHash: '11111111111111111111111111111111' };
  };
  const options = { repository, approvedOrigin: origin, approvedRecipient: recipient,
    now: () => time, random: randomBytes, trustedAccessKeyReader: reader, ...overrides };
  const service = createWalletSessions(options);
  return { service, repository, pair, publicKey, reads, options,
    setTime: value => { time = value; }, getTime: () => time };
}
const request = { origin, networkId, accountId };
const walletPayload = c => ({ ...c.payload, nonce: Buffer.from(c.payload.nonce, 'base64') });
async function signed(f, c, payload = walletPayload(c), pair = f.pair) {
  const output = await new KeyPairSigner(pair).signNep413Message(accountId, payload);
  return { ...request, challengeId: c.challengeId, publicKey: output.publicKey.toString(),
    signature: Buffer.from(output.signature).toString('base64') };
}
const rejectsCode = (promise, code) => assert.rejects(promise, e => e.code === code);

test('trusted configuration and challenge input fail closed instead of normalizing', async t => {
  const f = fixture(t);
  for (const override of [
    { approvedOrigin: 'https://haldir.example/' }, { approvedOrigin: 'http://haldir.example' },
    { approvedOrigin: undefined }, { approvedRecipient: '' }, { approvedRecipient: 'bad\nrecipient' },
    { approvedRecipient: 'haldir.example\n' },
    { repository: {} }, { trustedAccessKeyReader: undefined },
    { challengeTtlMs: 0 }, { challengeTtlMs: 300_001 }, { challengeTtlMs: 1.5 },
    { sessionTtlMs: 0 }, { sessionTtlMs: 3_600_001 }, { keyMaxAgeMs: 30_001 },
  ]) assert.throws(() => createWalletSessions({ ...f.options, ...override }), e => e.code === 'INVALID_CONFIG');
  for (const override of [
    { origin: `${origin}/` }, { origin: 'https://evil.example' }, { networkId: 'mainnet' },
    { accountId: 'Alice.testnet' }, { accountId: 'a..testnet' }, { accountId: 'a'.repeat(65) },
    { accountId: 'alice.testnet\n' }, { accountId: 'alice.testnet\r\n' },
  ]) await rejectsCode(f.service.issueChallenge({ ...request, ...override }), 'INVALID_CONTEXT');
  await rejectsCode(createWalletSessions({ ...f.options, now: () => NaN }).issueChallenge(request), 'INVALID_CLOCK');
  await rejectsCode(createWalletSessions({ ...f.options, random: () => new Uint8Array(31) }).issueChallenge(request), 'INVALID_RANDOM');
});

test('server issues a persisted, bounded, exact-context NEP-413 login challenge', async t => {
  const f = fixture(t);
  const c = await f.service.issueChallenge(request);
  assert.match(c.challengeId, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual({ origin: c.origin, networkId: c.networkId, accountId: c.accountId }, request);
  assert.equal(c.payload.recipient, recipient);
  assert.equal(Buffer.from(c.payload.nonce, 'base64').length, 32);
  assert.equal(c.expiresAt - c.issuedAt, 120_000);
  assert.equal(c.issuedAt, initialTime);
  assert.deepEqual(JSON.parse(c.payload.message), { type: 'haldir.wallet-login.v1',
    origin, recipient, networkId, accountId, challengeId: c.challengeId,
    issuedAt: c.issuedAt, expiresAt: c.expiresAt,
    notice: 'Session authentication only; does not authorize create/pay/stop/withdraw.' });
  const persisted = await f.repository.runTransaction(tx => tx.get('walletChallenges', c.challengeId));
  assert.deepEqual(persisted.challenge, c);
  assert.equal(persisted.consumedAt, null);
  assert.notEqual((await f.service.issueChallenge(request)).payload.nonce, c.payload.nonce);
});

test('actual Meteor and near-api-js agree on login digest/signature; trusted ownership yields one opaque session', async t => {
  const f = fixture(t);
  const c = await f.service.issueChallenge(request);
  const proof = await signed(f, c);
  const meteorDigest = serializeMessageNep413(walletPayload(c));
  assert.equal(Buffer.from(f.pair.sign(meteorDigest).signature).toString('base64'), proof.signature);
  // RFC 8410 Ed25519 SPKI prefix; Node/OpenSSL independently verifies the digest.
  const nodeKey = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(f.pair.getPublicKey().data),
  ]) });
  assert.equal(nodeVerify(null, meteorDigest, nodeKey, Buffer.from(proof.signature, 'base64')), true);
  assert.equal(nodeVerify(null, createHash('sha256').update(c.payload.message).digest(), nodeKey,
    Buffer.from(proof.signature, 'base64')), false);
  const result = await f.service.verifyChallenge(proof);
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.expiresAt - initialTime, 900_000);
  assert.equal(result.principal.accountId, accountId);
  assert.equal(result.principal.authenticationOnly, true);
  assert.equal(result.principal.networkId, networkId);
  assert.equal(result.principal.origin, origin);
  assert.deepEqual(f.reads, [{ networkId, accountId, publicKey: f.publicKey }]);
  const hash = createHash('sha256').update(result.token, 'ascii').digest('hex');
  const session = await f.repository.runTransaction(tx => tx.get('walletSessions', hash));
  assert.equal(session.tokenHash, hash);
  assert.equal(JSON.stringify(session).includes(result.token), false);
  assert.equal(session.revokedAt, null);
  assert.equal((await f.repository.runTransaction(tx => tx.get('walletChallenges', c.challengeId))).consumedAt, initialTime);
  await rejectsCode(f.service.verifyChallenge(proof), 'CHALLENGE_UNAVAILABLE');
});

test('verification checks the original signed bytes, not edited metadata or a different key', async t => {
  const f = fixture(t);
  const c = await f.service.issueChallenge(request);
  const good = await signed(f, c);
  for (const [field, value, code] of [
    ['origin', 'https://evil.example', 'INVALID_CONTEXT'],
    ['networkId', 'mainnet', 'INVALID_CONTEXT'],
    ['accountId', 'bob.testnet', 'CHALLENGE_UNAVAILABLE'],
    ['challengeId', randomBytes(32).toString('base64url'), 'CHALLENGE_UNAVAILABLE'],
    ['publicKey', KeyPair.fromRandom('ed25519').getPublicKey().toString(), 'INVALID_SIGNATURE'],
    ['publicKey', f.publicKey.replace('ed25519:', ''), 'INVALID_PROOF'],
    ['signature', 'A'.repeat(88), 'INVALID_PROOF'],
    ['signature', Buffer.alloc(64).toString('base64'), 'INVALID_SIGNATURE'],
  ]) await rejectsCode(f.service.verifyChallenge({ ...good, [field]: value }), code);
  for (const change of [
    { message: c.payload.message + ' ' }, { message: JSON.stringify({ ...JSON.parse(c.payload.message), accountId: 'bob.testnet' }) },
    { message: JSON.stringify({ ...JSON.parse(c.payload.message), networkId: 'mainnet' }) },
    { message: JSON.stringify({ ...JSON.parse(c.payload.message), origin: 'https://evil.example' }) },
    { recipient: 'evil.example' }, { nonce: randomBytes(32) }, { callbackUrl: origin + '/callback' },
  ]) await rejectsCode(f.service.verifyChallenge(await signed(f, c, { ...walletPayload(c), ...change })), 'INVALID_SIGNATURE');
  // Invalid attempts do not consume a legitimate challenge or create a session.
  assert.equal((await f.repository.runTransaction(tx => tx.get('walletChallenges', c.challengeId))).consumedAt, null);
  assert.equal((await f.service.verifyChallenge(good)).principal.accountId, accountId);
});

test('a signed claimed key is never ownership: require exact fresh final FullAccess chain evidence', async t => {
  const f = fixture(t);
  const c = await f.service.issueChallenge(request);
  const good = await signed(f, c);
  const baseline = { networkId, accountId, publicKey: f.publicKey, permission: 'FullAccess',
    observedAt: initialTime, finality: 'final', blockHeight: 123, blockHash: '11111111111111111111111111111111' };
  for (const change of [
    null, { networkId: 'mainnet' }, { accountId: 'bob.testnet' },
    { publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString() },
    { permission: { FunctionCall: { receiver_id: recipient, method_names: ['login'], allowance: '1' } } },
    { permission: null }, { observedAt: initialTime - 30_001 }, { observedAt: initialTime + 1 },
    { finality: 'optimistic' }, { blockHeight: 0 }, { blockHash: '' },
  ]) {
    const service = createWalletSessions({ ...f.options,
      trustedAccessKeyReader: async () => change === null ? null : { ...baseline, ...change } });
    await rejectsCode(service.verifyChallenge(good), 'OWNERSHIP_UNVERIFIED');
  }
  const unavailable = createWalletSessions({ ...f.options, trustedAccessKeyReader: async () => { throw new Error('offline'); } });
  await rejectsCode(unavailable.verifyChallenge(good), 'OWNERSHIP_UNVERIFIED');
  // A key's mathematical relationship to an implicit account is not chain membership.
  const implicit = Buffer.from(f.pair.getPublicKey().data).toString('hex');
  const ic = await unavailable.issueChallenge({ ...request, accountId: implicit });
  await rejectsCode(unavailable.verifyChallenge({ ...await signed(f, ic), accountId: implicit }), 'OWNERSHIP_UNVERIFIED');
  assert.equal((await f.repository.runTransaction(tx => tx.get('walletChallenges', c.challengeId))).consumedAt, null);
  const result = await f.service.verifyChallenge(good);
  await rejectsCode(unavailable.authenticate({ token: result.token, origin, networkId }), 'UNAUTHENTICATED');
  const removed = createWalletSessions({ ...f.options, trustedAccessKeyReader: async () => null });
  await rejectsCode(removed.authenticate({ token: result.token, origin, networkId }), 'UNAUTHENTICATED');
});

test('challenge TTL expires exactly at the boundary, including time spent awaiting trusted ownership', async t => {
  const f = fixture(t);
  const c = await f.service.issueChallenge(request);
  const proof = await signed(f, c);
  f.setTime(c.expiresAt);
  await rejectsCode(f.service.verifyChallenge(proof), 'CHALLENGE_EXPIRED');
  f.setTime(initialTime);
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const delayed = createWalletSessions({ ...f.options, trustedAccessKeyReader: async query => {
    entered(); await gate;
    return { ...query, permission: 'FullAccess', observedAt: f.getTime(), finality: 'final',
      blockHeight: 123, blockHash: '11111111111111111111111111111111' };
  } });
  const attempt = delayed.verifyChallenge(proof);
  const rejection = rejectsCode(attempt, 'CHALLENGE_EXPIRED');
  await waiting;
  f.setTime(c.expiresAt); release();
  await rejection;
  assert.equal((await f.repository.runTransaction(tx => tx.get('walletChallenges', c.challengeId))).consumedAt, null);
  f.setTime(c.expiresAt - 1);
  assert.equal((await f.service.verifyChallenge(proof)).principal.accountId, accountId);
});

test('repository-backed authentication expires and supports durable logout and server revocation', async t => {
  const f = fixture(t);
  const login = async () => {
    const c = await f.service.issueChallenge(request);
    return f.service.verifyChallenge(await signed(f, c));
  };
  const a = await login();
  const credentials = { token: a.token, origin, networkId };
  assert.deepEqual(await f.service.authenticate(credentials), a.principal);
  for (const change of [
    { token: randomBytes(32).toString('base64url') }, { token: a.token + '=' },
    { token: a.principal.sessionId }, { origin: `${origin}/` }, { networkId: 'mainnet' },
  ]) await rejectsCode(f.service.authenticate({ ...credentials, ...change }), 'UNAUTHENTICATED');
  assert.equal(await f.service.logout({ ...credentials, origin: 'https://evil.example' }), false);
  assert.deepEqual(await f.service.authenticate(credentials), a.principal);
  assert.equal(await f.service.logout(credentials), true);
  await rejectsCode(f.service.authenticate(credentials), 'UNAUTHENTICATED');
  assert.equal(await f.service.logout(credentials), false);
  const b = await login();
  assert.notEqual(a.token, b.token);
  assert.equal(await f.service.revokeSession({ sessionId: b.principal.sessionId }), true);
  await rejectsCode(f.service.authenticate({ ...credentials, token: b.token }), 'UNAUTHENTICATED');
  const c = await login();
  f.setTime(c.expiresAt - 1);
  assert.equal((await f.service.authenticate({ ...credentials, token: c.token })).accountId, accountId);
  f.setTime(c.expiresAt);
  await rejectsCode(f.service.authenticate({ ...credentials, token: c.token }), 'UNAUTHENTICATED');
});

test('two SQLite connections race one challenge: exactly one durable consumption/session survives process restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'haldir-wallet-session-'));
  const filename = join(dir, 'sessions.sqlite');
  const a = openLocalRepository({ filename, localTestOnly: true });
  const b = openLocalRepository({ filename, localTestOnly: true });
  let closed = false;
  t.after(async () => { if (!closed) { a.close(); b.close(); } await rm(dir, { recursive: true, force: true }); });
  const f = fixture(t, { repository: a });
  let arrivals = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const reader = async query => {
    if (++arrivals === 2) release();
    await gate;
    return { ...query, permission: 'FullAccess', observedAt: initialTime, finality: 'final',
      blockHeight: 123, blockHash: '11111111111111111111111111111111' };
  };
  const first = createWalletSessions({ ...f.options, repository: a, trustedAccessKeyReader: reader });
  const second = createWalletSessions({ ...f.options, repository: b, trustedAccessKeyReader: reader });
  const c = await first.issueChallenge(request);
  const proof = await signed(f, c);
  const results = await Promise.allSettled([first.verifyChallenge(proof), second.verifyChallenge(proof)]);
  assert.equal(arrivals, 2);
  const successful = results.filter(r => r.status === 'fulfilled');
  const failed = results.filter(r => r.status === 'rejected');
  assert.equal(successful.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, 'CHALLENGE_UNAVAILABLE');
  const result = successful[0].value;
  const inspect = new DatabaseSync(filename);
  try {
    const counts = inspect.prepare('SELECT collection, COUNT(*) AS count FROM records GROUP BY collection ORDER BY collection').all();
    assert.deepEqual(counts.map(r => [r.collection, r.count]), [['walletChallenges', 1], ['walletSessions', 1]]);
    const raw = inspect.prepare('SELECT value FROM records').all().map(r => r.value).join('');
    assert.equal(raw.includes(result.token), false);
    assert.equal(raw.includes('secretKey'), false);
    assert.equal(raw.includes('privateKey'), false);
  } finally { inspect.close(); }
  const count = await a.runTransaction(async tx => {
    const row = await tx.get('walletSessions', result.principal.sessionId);
    assert.equal(row.tokenHash, result.principal.sessionId);
    return (await tx.get('walletChallenges', c.challengeId)).consumedAt;
  });
  assert.equal(count, initialTime);
  // An unconsumed challenge must also survive a true process boundary.
  const pending = await first.issueChallenge(request);
  const pendingProof = await signed(f, pending);
  a.close(); b.close(); closed = true;
  const childSource = `
    import { readFileSync } from 'node:fs';
    globalThis.fetch = () => { throw new Error('offline child forbids fetch'); };
    const { openLocalRepository } = await import('./src/server/orders.mjs');
    const { createWalletSessions } = await import('./src/server/wallet-session.mjs');
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const repository = openLocalRepository({ filename: input.filename, localTestOnly: true });
    const service = createWalletSessions({ repository, approvedOrigin: input.origin,
      approvedRecipient: input.recipient, now: () => input.time,
      trustedAccessKeyReader: async q => ({ ...q, permission: 'FullAccess', observedAt: input.time,
        finality: 'final', blockHeight: 123, blockHash: '11111111111111111111111111111111' }) });
    try {
      const principal = await service.authenticate({ token: input.token, origin: input.origin, networkId: 'testnet' });
      let replayCode;
      try { await service.verifyChallenge(input.proof); } catch (e) { replayCode = e.code; }
      const pending = await service.verifyChallenge(input.pendingProof);
      const loggedOut = await service.logout({ token: input.token, origin: input.origin, networkId: 'testnet' });
      const row = await repository.runTransaction(tx => tx.get('walletSessions', principal.sessionId));
      console.log(JSON.stringify({ principal, replayCode, loggedOut, revokedAt: row.revokedAt,
        pendingAccount: pending.principal.accountId }));
    } finally { repository.close(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8', timeout: 10_000,
    env: Object.fromEntries(['PATH', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
    input: JSON.stringify({ filename, token: result.token, origin, recipient, time: initialTime, proof, pendingProof }),
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.deepEqual(output.principal, result.principal);
  assert.equal(output.replayCode, 'CHALLENGE_UNAVAILABLE');
  assert.equal(output.pendingAccount, accountId);
  assert.equal(output.loggedOut, true);
  assert.equal(output.revokedAt, initialTime);
  const reopened = openLocalRepository({ filename, localTestOnly: true });
  try {
    const resumed = createWalletSessions({ ...f.options, repository: reopened });
    await rejectsCode(resumed.authenticate({ token: result.token, origin, networkId }), 'UNAUTHENTICATED');
    await rejectsCode(resumed.verifyChallenge(pendingProof), 'CHALLENGE_UNAVAILABLE');
  } finally { reopened.close(); }
});

test('real SQL failure atomically rolls back challenge consumption and session insertion', async t => {
  const f = fixture(t);
  const c = await f.service.issueChallenge(request);
  const proof = await signed(f, c);
  const tokenBytes = Buffer.alloc(32, 7);
  const hash = createHash('sha256').update(tokenBytes.toString('base64url'), 'ascii').digest('hex');
  const broken = createWalletSessions({ ...f.options, random: () => tokenBytes,
    repository: { runTransaction: cb => f.repository.runTransaction(tx => cb({ ...tx,
      create(collection, key, value) {
        tx.create(collection, key, value);
        if (collection === 'walletSessions') tx.create(collection, key, value); // actual duplicate INSERT
      },
    })) } });
  await assert.rejects(broken.verifyChallenge(proof), /record already exists/);
  assert.equal((await f.repository.runTransaction(tx => tx.get('walletChallenges', c.challengeId))).consumedAt, null);
  assert.equal(await f.repository.runTransaction(tx => tx.get('walletSessions', hash)), null);
  assert.equal((await f.service.verifyChallenge(proof)).principal.accountId, accountId);
});

test('transaction replay does not repeat random, clock, signing or ownership side effects', async t => {
  const f = fixture(t);
  let writes = 0, randomCalls = 0, clockCalls = 0;
  const aborted = new Error('synthetic retriable abort');
  const repository = { async runTransaction(cb) {
    let retriable = false;
    try {
      return await f.repository.runTransaction(async tx => {
        const result = await cb({ ...tx, create(collection, key, value) {
          tx.create(collection, key, value);
          if (collection === 'walletSessions') { retriable = true; writes++; }
        } });
        if (retriable) throw aborted;
        return result;
      });
    } catch (e) {
      if (e !== aborted) throw e;
      const clocks = clockCalls, randomness = randomCalls, reads = f.reads.length;
      const result = await f.repository.runTransaction(cb);
      assert.equal(clockCalls, clocks);
      assert.equal(randomCalls, randomness);
      assert.equal(f.reads.length, reads);
      return result;
    }
  } };
  const service = createWalletSessions({ ...f.options, repository,
    random: size => { randomCalls++; return randomBytes(size); },
    now: () => { clockCalls++; return initialTime; } });
  const c = await service.issueChallenge(request);
  const result = await service.verifyChallenge(await signed(f, c));
  assert.equal(writes, 1);
  assert.equal(randomCalls, 3); // challenge ID, nonce, session token; never on transaction retry
  assert.equal(f.reads.length, 1);
  assert.equal((await service.authenticate({ token: result.token, origin, networkId })).accountId, accountId);
});

test('a transaction queue crossing challenge expiry never releases its committed session token', async t => {
  const f = fixture(t);
  const c = await f.service.issueChallenge(request);
  const proof = await signed(f, c);
  let crossed = false;
  const delayedRepository = { runTransaction: cb => f.repository.runTransaction(async tx => {
    let consuming = false;
    const result = await cb({ ...tx, create(collection, key, value) {
      if (collection === 'walletSessions') consuming = true;
      tx.create(collection, key, value);
    } });
    if (consuming) { crossed = true; f.setTime(c.expiresAt); }
    return result;
  }) };
  const delayed = createWalletSessions({ ...f.options, repository: delayedRepository });
  await rejectsCode(delayed.verifyChallenge(proof), 'CHALLENGE_EXPIRED');
  assert.equal(crossed, true);
  await rejectsCode(f.service.verifyChallenge(proof), 'CHALLENGE_UNAVAILABLE');
});

test('logout during an awaited ownership read cannot resurrect an authenticated session', async t => {
  const f = fixture(t);
  const c = await f.service.issueChallenge(request);
  const result = await f.service.verifyChallenge(await signed(f, c));
  const credentials = { token: result.token, origin, networkId };
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const delayed = createWalletSessions({ ...f.options, trustedAccessKeyReader: async q => {
    entered(); await gate;
    return { ...q, permission: 'FullAccess', observedAt: initialTime, finality: 'final',
      blockHeight: 123, blockHash: '11111111111111111111111111111111' };
  } });
  const rejection = rejectsCode(delayed.authenticate(credentials), 'UNAUTHENTICATED');
  await waiting;
  assert.equal(await f.service.logout(credentials), true);
  release();
  await rejection;
});

