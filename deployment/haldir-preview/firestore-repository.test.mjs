import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { Firestore } from '@google-cloud/firestore';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { randomBytes } from 'node:crypto';
import { createWalletSessions } from '../../src/server/wallet-session.mjs';
import { openFirestoreRepository } from './firestore-repository.mjs';

const config = { projectId: 'loadout-haldir-demo', databaseId: 'preview-auth',
  namespace: 'haldirPreviewTestnetV1', timeoutMs: 1000 };
const database = 'projects/loadout-haldir-demo/databases/preview-auth';
const stamp = { seconds: '1', nanos: 0 };
const rpcError = (code, message) => Object.assign(new Error(message), { code });

// TEST ONLY: closed protobuf RPC boundary, not a production repository/emulator.
// Actual Firestore Transaction, DocumentReference, serializer, DocumentReader and
// retry runner execute. No ADC, gRPC/HTTP or real database is exercised here.
function boundary(t, shared = { records: new Map(), version: 0 }) {
  let forbidden = 0;
  const deny = () => { forbidden++; throw new Error('OFFLINE_TRANSPORT_FORBIDDEN'); };
  for (const [object, method] of [[globalThis, 'fetch'], [net.Socket.prototype, 'connect'],
    [tls, 'connect'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [http2, 'connect']])
    t.mock.method(object, method, deny);
  const calls = [], clients = new Set(), ended = new Set(), transactions = new Map();
  let serial = 0;
  let racing = 0, releaseRace;
  const raceGate = new Promise(resolve => { releaseRace = resolve; });
  const controls = { abortCommits: 0, abortCode: 10, abortWritesOnly: false,
    raceSessions: false, conflicts: 0, rejectSessionCreate: false, denyReads: false, holdReads: false, released: [], commits: 0 };
  const check = (client, request) => {
    clients.add(client);
    assert.equal(client.projectId, config.projectId);
    assert.equal(client.databaseId, config.databaseId);
    assert.equal(request.database, database);
    assert.equal(ended.has(client), false, 'SDK must not be used after terminate');
  };
  t.mock.method(Firestore.prototype, 'initializeIfNeeded', async function () {
    clients.add(this);
    assert.equal(ended.has(this), false);
    // Explicit project/database are populated by the real constructor.
    assert.equal(this.projectId, config.projectId);
  });
  const originalTerminate = Firestore.prototype.terminate;
  t.mock.method(Firestore.prototype, 'terminate', async function () {
    ended.add(this);
    return originalTerminate.call(this);
  });
  t.mock.method(Firestore.prototype, 'requestStream', async function (method, bidirectional, request) {
    check(this, request);
    assert.equal(method, 'batchGetDocuments'); assert.equal(bidirectional, false);
    calls.push({ method, request: structuredClone(request), client: this });
    if (controls.denyReads) throw rpcError(7, 'synthetic permission denied');
    if (controls.holdReads) await new Promise(resolve => controls.released.push(resolve));
    let transaction = request.transaction;
    if (request.newTransaction) {
      transaction = Buffer.from(String(++serial));
      transactions.set(transaction.toString(), { records: new Map(shared.records), version: shared.version });
    }
    const records = transaction ? transactions.get(Buffer.from(transaction).toString()).records : shared.records;
    return Readable.from(request.documents.map(name => {
      assert.ok(name.startsWith(`${database}/documents/namespaces/${config.namespace}/`));
      return { ...(records.has(name) ? { found: records.get(name) } : { missing: name }),
        readTime: stamp, ...(transaction ? { transaction } : {}) };
    }), { objectMode: true });
  });
  t.mock.method(Firestore.prototype, 'request', async function (method, request) {
    check(this, request);
    calls.push({ method, request: structuredClone(request), client: this });
    assert.ok(['commit', 'rollback'].includes(method), `unexpected RPC ${method}`);
    if (method === 'rollback') { transactions.delete(Buffer.from(request.transaction).toString()); return {}; }
    controls.commits++;
    if (controls.abortCommits > 0 && (!controls.abortWritesOnly || request.writes.length)) {
      controls.abortCommits--; throw rpcError(controls.abortCode, 'synthetic aborted');
    }
    if (controls.rejectSessionCreate && request.writes.some(w => w.update.name.includes('/walletSessions/')))
      throw rpcError(6, 'synthetic session create conflict');
    if (controls.raceSessions && request.writes.some(w => w.update.name.includes('/walletSessions/')) && racing < 2) {
      if (++racing === 2) releaseRace();
      await raceGate;
    }
    const tx = request.transaction && transactions.get(Buffer.from(request.transaction).toString());
    if (tx && tx.version !== shared.version) {
      controls.conflicts++; throw rpcError(10, 'synthetic concurrent change');
    }
    const next = new Map(shared.records);
    for (const write of request.writes) {
      assert.ok(write.update && !write.delete && !write.transform && !write.updateMask);
      if (write.currentDocument?.exists === false && next.has(write.update.name))
        throw rpcError(6, 'record already exists');
      next.set(write.update.name, { ...structuredClone(write.update), createTime: stamp, updateTime: stamp });
    }
    shared.records = next;
    if (request.writes.length) shared.version++;
    if (request.transaction) transactions.delete(Buffer.from(request.transaction).toString());
    return { commitTime: stamp, writeResults: request.writes.map(() => ({ updateTime: stamp })) };
  });
  t.after(() => { assert.equal(forbidden, 0, 'no hidden network/ADC transport attempts'); });
  return { shared, calls, clients, ended, controls };
}
async function fixture(t, options = {}) {
  const wire = boundary(t);
  const repo = await openFirestoreRepository({ ...config, ...options });
  t.after(() => repo.close());
  return { repo, ...wire };
}

test('hosted configuration is explicit, pinned and forbids credential/emulator overrides', async t => {
  const wire = boundary(t);
  for (const patch of [{ projectId: undefined }, { projectId: 'wrong-project' },
    { databaseId: undefined }, { databaseId: '' }, { databaseId: 'bad/db' }, { databaseId: 'preview-auth\n' },
    { namespace: undefined }, { namespace: '../foreign' }, { namespace: 'other' },
    { timeoutMs: 0 }, { timeoutMs: 30001 }, { timeoutMs: 1.5 },
    { credentials: {} }, { host: 'localhost:1' }, { keyFilename: '/must-not-read' }]) {
    assert.throws(() => openFirestoreRepository({ ...config, ...patch }), /FIRESTORE_CONFIG_INVALID/);
  }
  for (const name of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIRESTORE_EMULATOR_HOST']) {
    for (const value of ['', 'synthetic-forbidden-value']) {
      const old = process.env[name]; process.env[name] = value;
      try { assert.throws(() => openFirestoreRepository(config), /HOSTED_CREDENTIAL_OVERRIDE_FORBIDDEN/); }
      finally { if (old === undefined) delete process.env[name]; else process.env[name] = old; }
    }
  }
  assert.equal(wire.clients.size, 0, 'invalid config must not initialize SDK/ADC');
});

test('verifyReadiness performs an actual SDK exact-document read before returning, with explicit RPC deadlines', async t => {
  const { repo, calls, shared, clients } = await fixture(t);
  assert.equal(typeof repo.verifyReadiness, 'function', 'bootstrap requires verifyReadiness');
  await repo.verifyReadiness();
  assert.equal(shared.records.size, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'batchGetDocuments');
  assert.equal(calls[0].request.newTransaction, undefined);
  assert.equal(calls[0].request.transaction, undefined);
  assert.equal(calls[0].request.documents.length, 1);
  const [client] = clients;
  assert.equal(client._settings.credentials, undefined);
  assert.equal(client._settings.keyFilename, undefined);
  assert.equal(client._settings.servicePath, 'firestore.googleapis.com');
  // Build real GAPIC CallSettings too: a look-alike override object is not proof
  // that Google GAX actually accepts the timeout/retry configuration.
  const gapic = new Firestore.v1.FirestoreClient(client._settings);
  t.after(() => gapic.close());
  for (const method of ['batchGetDocuments', 'commit', 'rollback']) {
    assert.equal(gapic._defaults[method].timeout, config.timeoutMs);
    assert.deepEqual(gapic._defaults[method].retry.retryCodes, []);
  }
});

test('denied readiness closes the SDK and permanently fails closed', async t => {
  const { repo, controls, ended } = await fixture(t);
  assert.equal(typeof repo.verifyReadiness, 'function', 'bootstrap requires verifyReadiness');
  controls.denyReads = true;
  await assert.rejects(repo.verifyReadiness(), e => e.code === 7);
  await repo.close();
  assert.equal(ended.size, 1);
  await assert.rejects(repo.runTransaction(tx => tx.get('jobs', 'one')), /FIRESTORE_REPOSITORY_CLOSED/);
  await assert.rejects(repo.verifyReadiness(), /FIRESTORE_REPOSITORY_CLOSED/);
});

test('readiness has a wall-clock deadline including initialization; timeout cannot later become ready', async t => {
  const { repo, controls, ended } = await fixture(t, { timeoutMs: 25 });
  assert.equal(typeof repo.verifyReadiness, 'function', 'bootstrap requires verifyReadiness');
  controls.holdReads = true;
  const started = performance.now();
  await assert.rejects(repo.verifyReadiness(), /FIRESTORE_READINESS_TIMEOUT/);
  assert.ok(performance.now() - started < 1000, 'hung SDK read must not hang bootstrap');
  assert.equal(ended.size, 0, 'do not terminate an active SDK stream/retry runner');
  await assert.rejects(repo.verifyReadiness(), /FIRESTORE_REPOSITORY_CLOSED/);
  controls.released.forEach(resolve => resolve());
  await repo.close();
  assert.equal(ended.size, 1);
  await assert.rejects(repo.verifyReadiness(), /FIRESTORE_REPOSITORY_CLOSED/);
});

test('transaction ports cannot escape their callback or outlive close', async t => {
  const { repo, calls } = await fixture(t);
  let escaped;
  await repo.runTransaction(tx => { escaped = tx; });
  const count = calls.length;
  await assert.rejects(escaped.get('jobs', 'one'), /FIRESTORE_TRANSACTION_FINISHED/);
  assert.throws(() => escaped.create('jobs', 'one', {}), /FIRESTORE_TRANSACTION_FINISHED/);
  assert.throws(() => escaped.set('jobs', 'one', {}), /FIRESTORE_TRANSACTION_FINISHED/);
  assert.equal(calls.length, count, 'escaped callback must not start an SDK read');
  await repo.close();
  await assert.rejects(repo.runTransaction(() => {}), /FIRESTORE_REPOSITORY_CLOSED/);
});

test('real SDK exact-key create/read/replacement-set and callback return contract', async t => {
  const { repo, shared, calls, clients } = await fixture(t);
  const value = { owner: 'alice.testnet', amount: '3000000000000000000000000' };
  assert.equal(await repo.runTransaction(async tx => {
    assert.equal(await tx.get('jobs', 'one'), null);
    tx.create('jobs', 'one', value);
    return 'committed';
  }), 'committed');
  value.owner = 'mutated outside';
  assert.deepEqual(await repo.runTransaction(tx => tx.get('jobs', 'one')),
    { owner: 'alice.testnet', amount: '3000000000000000000000000' });
  await repo.runTransaction(tx => tx.set('jobs', 'one', { replaced: true }));
  assert.deepEqual(await repo.runTransaction(tx => tx.get('jobs', 'one')), { replaced: true });
  assert.equal(shared.records.size, 1);
  const writes = calls.filter(c => c.method === 'commit').flatMap(c => c.request.writes);
  assert.deepEqual(writes[0].currentDocument, { exists: false });
  assert.equal(writes[1].currentDocument, undefined);
  assert.equal(clients.size, 1);
});

test('port validation rejects invalid exact keys and non-JSON/oversize writes atomically', async t => {
  const { repo, shared } = await fixture(t);
  for (const [collection, key] of [['bad/name', 'x'], ['jobs\n', 'x'], ['1jobs', 'x'],
    ['a'.repeat(33), 'x'], ['jobs', ''], ['jobs', 'a'.repeat(2049)], ['jobs', 1]]) {
    await assert.rejects(repo.runTransaction(tx => tx.get(collection, key)), /invalid repository key/);
    await assert.rejects(repo.runTransaction(tx => tx.create(collection, key, {})), /invalid repository key/);
    await assert.rejects(repo.runTransaction(tx => tx.set(collection, key, {})), /invalid repository key/);
  }
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, () => {}, Symbol('x'), 1n, cycle, 'x'.repeat(512 * 1024)]) {
    await assert.rejects(repo.runTransaction(tx => {
      tx.create('jobs', 'must-rollback', {});
      tx.set('jobs', 'invalid', value);
    }));
    assert.equal(shared.records.size, 0);
  }
});

test('JSON stringify/parse and 512-KiB limit match the port without Firestore value-type restrictions', async t => {
  const { repo } = await fixture(t);
  const values = [null, true, 7, 'text', [[1], [2]], { absent: undefined, nan: NaN, when: new Date(0) },
    { '__proto__': null, toJSON() { return ['custom', 'JSON']; } }, 'x'.repeat(512 * 1024 - 2)];
  for (const [i, value] of values.entries()) {
    await repo.runTransaction(tx => tx.set('records', String(i), value));
    assert.deepEqual(await repo.runTransaction(tx => tx.get('records', String(i))), JSON.parse(JSON.stringify(value)));
  }
});

test('SDK create conflicts and callback failures roll back all writes; reads must precede writes', async t => {
  const { repo, shared, calls } = await fixture(t);
  await repo.runTransaction(tx => tx.create('jobs', 'one', { original: true }));
  const before = new Map(shared.records);
  await assert.rejects(repo.runTransaction(async tx => {
    await tx.get('jobs', 'one');
    tx.set('jobs', 'one', { replaced: true });
    tx.create('claims', 'new', {});
    throw new Error('callback abort');
  }), /callback abort/);
  assert.deepEqual(shared.records, before);
  await assert.rejects(repo.runTransaction(tx => {
    tx.create('claims', 'new', {});
    tx.create('jobs', 'one', {});
  }), /already exists/);
  assert.deepEqual(shared.records, before);
  await assert.rejects(repo.runTransaction(async tx => {
    tx.set('jobs', 'one', {});
    await tx.get('claims', 'new');
  }), /reads.*(before|precede).*writes/i);
  assert.deepEqual(shared.records, before);
  assert.ok(calls.some(c => c.method === 'rollback'));
});

test('SDK bounds retriable attempts to five and does not retry create conflicts', { timeout: 30_000 }, async t => {
  const { repo, controls } = await fixture(t);
  // Exercise the actual SDK ABORTED retry runner and ordinary jitter backoff.
  controls.abortCommits = 6;
  let attempts = 0;
  await assert.rejects(repo.runTransaction(tx => { attempts++; tx.set('jobs', 'one', {}); }), e => e.code === 10);
  assert.equal(attempts, 5); assert.equal(controls.commits, 5);
  controls.abortCommits = 0;
  await repo.runTransaction(tx => tx.create('jobs', 'one', {}));
  attempts = 0;
  await assert.rejects(repo.runTransaction(tx => { attempts++; tx.create('jobs', 'one', {}); }), e => e.code === 6);
  assert.equal(attempts, 1);
});

const request = { origin: 'https://haldir.example', networkId: 'testnet', accountId: 'alice.testnet' };
const now = 1_794_484_800_000;
function wallet(repository, overrides = {}) {
  return createWalletSessions({ repository, approvedOrigin: request.origin, approvedRecipient: 'haldir.example',
    now: () => now, trustedAccessKeyReader: async query => ({ ...query, permission: 'FullAccess',
      finality: 'final', blockHeight: 123, blockHash: '11111111111111111111111111111111', observedAt: now }), ...overrides });
}
async function proof(challenge) {
  const pair = KeyPair.fromRandom('ed25519'); // disposable in-memory signing fixture
  const signed = await new KeyPairSigner(pair).signNep413Message(request.accountId,
    { ...challenge.payload, nonce: Buffer.from(challenge.payload.nonce, 'base64') });
  return { ...request, challengeId: challenge.challengeId, publicKey: signed.publicKey.toString(),
    signature: Buffer.from(signed.signature).toString('base64') };
}

test('wallet sessions through SDK adapter: exact signed bytes, replay, reopen, logout and revocation', async t => {
  const { repo, shared } = await fixture(t);
  const first = wallet(repo);
  const c = await first.issueChallenge(request);
  const signed = await proof(c);
  await assert.rejects(first.verifyChallenge({ ...signed, accountId: 'bob.testnet' }), e => e.code === 'CHALLENGE_UNAVAILABLE');
  const result = await first.verifyChallenge(signed);
  assert.equal(shared.records.size, 2);
  assert.equal(JSON.stringify([...shared.records]).includes(result.token), false, 'bearer must not be persisted');
  const pending = await first.issueChallenge(request);
  const pendingProof = await proof(pending);
  await repo.close();
  // New real SDK client, shared *synthetic RPC* state, not real restart durability.
  const reopened = await openFirestoreRepository(config); t.after(() => reopened.close());
  const second = wallet(reopened);
  const credentials = { token: result.token, origin: request.origin, networkId: 'testnet' };
  assert.deepEqual(await second.authenticate(credentials), result.principal);
  await assert.rejects(second.verifyChallenge(signed), e => e.code === 'CHALLENGE_UNAVAILABLE');
  assert.equal((await second.verifyChallenge(pendingProof)).principal.accountId, request.accountId);
  assert.equal(await second.logout(credentials), true);
  await assert.rejects(second.authenticate(credentials), e => e.code === 'UNAUTHENTICATED');
  assert.equal(await second.logout(credentials), false);
  const third = await second.issueChallenge(request);
  const next = await second.verifyChallenge(await proof(third));
  assert.equal(await second.revokeSession({ sessionId: next.principal.sessionId }), true);
  await assert.rejects(second.authenticate({ ...credentials, token: next.token }), e => e.code === 'UNAUTHENTICATED');
});

test('two independent SDK clients race one wallet challenge; only one session is committed', async t => {
  const { repo, shared, calls, clients, controls } = await fixture(t);
  controls.raceSessions = true;
  const other = await openFirestoreRepository(config); t.after(() => other.close());
  let arrived = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const reader = async query => {
    if (++arrived === 2) release();
    await gate;
    return { ...query, permission: 'FullAccess', finality: 'final', blockHeight: 123,
      blockHash: '11111111111111111111111111111111', observedAt: now };
  };
  const a = wallet(repo, { trustedAccessKeyReader: reader });
  const b = wallet(other, { trustedAccessKeyReader: reader });
  const challenge = await a.issueChallenge(request);
  const signed = await proof(challenge);
  const outcomes = await Promise.allSettled([a.verifyChallenge(signed), b.verifyChallenge(signed)]);
  assert.equal(arrived, 2);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(r => r.status === 'rejected').reason.code, 'CHALLENGE_UNAVAILABLE');
  assert.equal([...shared.records.keys()].filter(k => k.includes('/walletSessions/')).length, 1);
  assert.equal(shared.records.size, 2);
  assert.equal(clients.size, 2);
  assert.equal(controls.conflicts, 1, 'both commits saw the same challenge snapshot; loser receives ABORTED');
  assert.ok(calls.some(c => c.method === 'rollback'), 'SDK conflict must roll back/retry');
});

test('failed SDK session commit preserves challenge; callback replay repeats no random/clock/ownership effects', async t => {
  const { repo, controls, calls } = await fixture(t);
  let randomness = 0, clocks = 0, ownership = 0;
  const service = wallet(repo, { random: size => { randomness++; return randomBytes(size); },
    now: () => { clocks++; return now; }, trustedAccessKeyReader: async query => {
      ownership++;
      return { ...query, permission: 'FullAccess', finality: 'final', blockHeight: 123,
        blockHash: '11111111111111111111111111111111', observedAt: now };
    } });
  const challenge = await service.issueChallenge(request);
  const signed = await proof(challenge);
  controls.rejectSessionCreate = true;
  await assert.rejects(service.verifyChallenge(signed), e => e.code === 6);
  assert.equal((await repo.runTransaction(tx => tx.get('walletChallenges', challenge.challengeId))).consumedAt, null);
  controls.rejectSessionCreate = false;
  controls.abortCommits = 1; controls.abortWritesOnly = true;
  // Observe retry boundaries without replacing SDK transaction behavior.
  const original = Firestore.prototype.request;
  let beforeReplay;
  t.mock.method(Firestore.prototype, 'request', async function (method, input, ...rest) {
    if (method === 'commit' && input.writes.some(w => w.update.name.includes('/walletSessions/'))) {
      const effects = { randomness, clocks, ownership };
      if (beforeReplay) assert.deepEqual(effects, beforeReplay);
      else beforeReplay = effects;
    }
    return original.call(this, method, input, ...rest);
  });
  const result = await service.verifyChallenge(signed);
  assert.equal(randomness, 4, 'challenge ID, nonce, failed token, successful token only');
  assert.equal(ownership, 2, 'one ownership read per top-level proof, never in retry');
  assert.ok(beforeReplay);
  const commits = calls.filter(c => c.method === 'commit' && c.request.writes.length === 2);
  assert.equal(commits.length, 3, 'failed create + aborted attempt + successful replay');
  assert.deepEqual(commits[1].request.writes, commits[2].request.writes);
  assert.equal(result.principal.authenticationOnly, true);
});

test('keys are reversible stable exact identities for slashes, long strings and UTF-16 code units', async t => {
  const { repo, shared } = await fixture(t);
  const keys = ['a/b', 'a//b', 'a%2Fb', '.', '..', '__reserved__', 'é', 'e\u0301',
    '\ud800', '\ufffd', 'a'.repeat(2048), '😀'.repeat(1024), '\u0000'.repeat(2048)];
  for (const [i, key] of keys.entries()) await repo.runTransaction(tx => tx.create('jobs', key, { i }));
  assert.equal(shared.records.size, keys.length);
  const reopened = await openFirestoreRepository(config); t.after(() => reopened.close());
  for (const [i, key] of keys.entries()) assert.deepEqual(await reopened.runTransaction(tx => tx.get('jobs', key)), { i });
  for (const name of shared.records.keys()) {
    assert.ok(Buffer.byteLength(name) < 6 * 1024);
    const path = name.split('/documents/')[1].split('/');
    assert.equal(path.length % 2, 0);
    assert.ok(path.every(segment => segment.length && Buffer.byteLength(segment) <= 1500));
  }
});
