import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth } from 'google-auth-library';
import { openFirestoreRepository } from './firestore-repository.mjs';

// Qualification of the installed SDK's actual GAX/gRPC/protobuf transport on
// ephemeral loopback. This tiny closed service is NOT the Firestore emulator
// and proves neither hosted ADC/IAM nor real database transaction isolation.
test('actual SDK gRPC transport: selected database, exact create precondition, rollback and deadline', { timeout: 10_000 }, async t => {
  const protoDir = fileURLToPath(new URL('./node_modules/@google-cloud/firestore-api/build/protos/', import.meta.url));
  const definition = loader.loadSync(`${protoDir}google/firestore/v1/firestore.proto`,
    { includeDirs: [protoDir, fileURLToPath(new URL('./node_modules/google-gax/build/protos/', import.meta.url))],
      longs: String, enums: String, defaults: false, oneofs: true });
  const api = grpc.loadPackageDefinition(definition).google.firestore.v1;
  const database = 'projects/loadout-haldir-demo/databases/preview-auth';
  const stamp = { seconds: '1', nanos: 0 };
  const records = new Map(), seen = [], held = [];
  let holdReads = false, serial = 0, receiveRollback;
  const rolledBack = new Promise(resolve => { receiveRollback = resolve; });
  const server = new grpc.Server();
  server.addService(api.Firestore.service, {
    batchGetDocuments(call) {
      seen.push({ method: 'read', request: call.request, deadline: call.getDeadline() });
      assert.equal(call.request.database, database);
      assert.equal(call.metadata.get('authorization')[0], 'Bearer owner');
      if (holdReads) { held.push(call); return; }
      const transaction = call.request.newTransaction ? Buffer.from(String(++serial)) : call.request.transaction;
      for (const name of call.request.documents) {
        assert.ok(name.startsWith(`${database}/documents/namespaces/haldirPreviewTestnetV1/`));
        call.write({ ...(records.has(name) ? { found: records.get(name) } : { missing: name }),
          readTime: stamp, ...(transaction ? { transaction } : {}) });
      }
      call.end();
    },
    commit(call, callback) {
      seen.push({ method: 'commit', request: call.request });
      assert.equal(call.request.database, database);
      const next = new Map(records);
      for (const write of call.request.writes ?? []) {
        assert.ok(write.update && !write.updateMask);
        if (write.currentDocument?.exists === false && next.has(write.update.name)) {
          callback({ code: grpc.status.ALREADY_EXISTS, details: 'synthetic exact-key conflict' }); return;
        }
        next.set(write.update.name, { ...write.update, createTime: stamp, updateTime: stamp });
      }
      records.clear(); for (const [key, value] of next) records.set(key, value);
      callback(null, { commitTime: stamp, writeResults: (call.request.writes ?? []).map(() => ({ updateTime: stamp })) });
    },
    rollback(call, callback) {
      seen.push({ method: 'rollback', request: call.request }); callback(null, {}); receiveRollback();
    },
  });
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0',
    grpc.ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value)));
  let repo, timed;
  const releaseReads = () => {
    holdReads = false;
    for (const call of held.splice(0)) {
      if (!call.cancelled) {
        for (const name of call.request.documents) call.write({ missing: name, readTime: stamp });
        call.end();
      }
    }
  };
  t.after(async () => {
    releaseReads();
    await Promise.allSettled([repo?.close(), timed?.close()]);
    server.forceShutdown();
    assert.deepEqual(forbidden, [], 'no late non-fixture transport/ADC attempts during SDK drain');
  });

  const forbidden = [];
  let connections = 0;
  const deny = () => {
    const error = new Error('NON_FIXTURE_TRANSPORT_OR_ADC_FORBIDDEN');
    forbidden.push(error.stack); throw error;
  };
  for (const [object, method] of [[globalThis, 'fetch'], [tls, 'connect'], [http, 'request'],
    [http, 'get'], [https, 'request'], [https, 'get'], [GoogleAuth.prototype, 'getClient'],
    [GoogleAuth.prototype, 'getApplicationDefault'], [GoogleAuth.prototype, 'getProjectId']])
    t.mock.method(object, method, deny);
  // GAX looks up the credential universe even for an insecure channel. Supply
  // that noncredential value at the test boundary, rather than discovering ADC.
  t.mock.method(GoogleAuth.prototype, 'getUniverseDomain', async () => 'googleapis.com');
  const connect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (!options || options.host !== '127.0.0.1' || Number(options.port) !== port) return deny();
    connections++;
    return connect.apply(this, args);
  });
  const connectHttp2 = http2.connect;
  t.mock.method(http2, 'connect', function (authority, ...args) {
    if (String(authority) !== `http://127.0.0.1:${port}`) return deny();
    return connectHttp2.call(this, authority, ...args);
  });
  // Test-only SDK setting seam. Hosted options/ADC/emulator exclusions in the
  // production adapter remain unchanged, with no configurable transport escape.
  const apply = Firestore.prototype.validateAndApplySettings;
  t.mock.method(Firestore.prototype, 'validateAndApplySettings', function (settings) {
    assert.equal(settings.servicePath, 'firestore.googleapis.com');
    return apply.call(this, { ...settings, servicePath: '127.0.0.1', port, ssl: false });
  });
  const config = { projectId: 'loadout-haldir-demo', databaseId: 'preview-auth',
    namespace: 'haldirPreviewTestnetV1', timeoutMs: 2000 };
  repo = openFirestoreRepository(config);
  await repo.verifyReadiness();
  assert.ok(seen[0].deadline - Date.now() <= 2000);
  await repo.runTransaction(async tx => {
    assert.equal(await tx.get('walletChallenges', 'long/key/' + 'x'.repeat(2000)), null);
    tx.create('walletChallenges', 'long/key/' + 'x'.repeat(2000), { nested: [[1], [2]] });
  });
  assert.deepEqual(await repo.runTransaction(tx => tx.get('walletChallenges', 'long/key/' + 'x'.repeat(2000))), { nested: [[1], [2]] });
  const before = new Map(records);
  await assert.rejects(repo.runTransaction(tx => {
    tx.set('walletChallenges', 'must-rollback', {});
    tx.create('walletChallenges', 'long/key/' + 'x'.repeat(2000), {});
  }), error => error.code === grpc.status.ALREADY_EXISTS);
  assert.deepEqual(records, before);
  await assert.rejects(repo.runTransaction(async tx => {
    await tx.get('walletChallenges', 'other'); throw new Error('callback failure');
  }), /callback failure/);
  await rolledBack; // SDK explicitly sends rollback best-effort, asynchronously.
  assert.ok(seen.some(row => row.method === 'rollback'));
  const writes = seen.filter(row => row.method === 'commit').flatMap(row => row.request.writes ?? []);
  assert.ok(writes.some(write => write.currentDocument?.exists === false));

  holdReads = true;
  timed = openFirestoreRepository({ ...config, timeoutMs: 100 });
  const started = performance.now();
  await assert.rejects(timed.verifyReadiness(), error => error.message === 'FIRESTORE_READINESS_TIMEOUT' || error.code === grpc.status.DEADLINE_EXCEEDED);
  assert.ok(performance.now() - started < 1000);
  releaseReads();
  await timed.close();
  await assert.rejects(timed.verifyReadiness(), /FIRESTORE_REPOSITORY_CLOSED/);
  assert.ok(connections > 0, 'actual SDK must open loopback gRPC transport');
  assert.deepEqual(forbidden, [], 'no ADC or non-fixture transport attempted');
});
