import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { readFile, symlink, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { request, createServer } from 'node:http';
import { once } from 'node:events';
const entry = new URL('./main.mjs', import.meta.url);
function run(env = {}) {
  return spawnSync(process.execPath, [entry.pathname], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, ...env } });
}
test('actual auto-invoked entrypoint rejects absent exact HTTPS origin before listening', () => {
  const child = run();
  assert.equal(child.status, 1);
  assert.equal(child.stderr.trim(), 'EXACT_HTTPS_ORIGIN_REQUIRED');
  assert.equal(child.stdout, '');
});
const configured = { HALDIR_APPROVED_ORIGIN: 'https://haldir.example', GOOGLE_CLOUD_PROJECT: 'loadout-haldir-demo',
  HALDIR_PROJECT_NUMBER: '147018706305', HALDIR_REGION: 'europe-west1', HALDIR_FIRESTORE_DATABASE_ID: 'preview-auth' };
test('startup rejects configuration drift and hosted credential/emulator overrides without importing any cloud client', () => {
  for (const [patch, code] of [
    [{ HALDIR_APPROVED_ORIGIN: 'http://haldir.example' }, 'EXACT_HTTPS_ORIGIN_REQUIRED'],
    [{ HALDIR_APPROVED_ORIGIN: 'https://haldir.example/' }, 'EXACT_HTTPS_ORIGIN_REQUIRED'],
    [{ HALDIR_PROJECT_NUMBER: 'wrong' }, 'TARGET_PROJECT_REQUIRED'],
    [{ GOOGLE_CLOUD_PROJECT: 'wrong' }, 'TARGET_PROJECT_REQUIRED'],
    [{ HALDIR_REGION: 'us-central1' }, 'REGION_REQUIRED'],
    [{ PORT: '0' }, 'PORT_INVALID'], [{ PORT: '65536' }, 'PORT_INVALID'],
    [{ HALDIR_FIRESTORE_DATABASE_ID: '' }, 'DATABASE_ID_REQUIRED'],
    [{ FIRESTORE_EMULATOR_HOST: 'localhost:1' }, 'HOSTED_CREDENTIAL_OVERRIDE_FORBIDDEN'],
    [{ GOOGLE_APPLICATION_CREDENTIALS: '/never-read-this-file' }, 'HOSTED_CREDENTIAL_OVERRIDE_FORBIDDEN'],
  ]) {
    const child = run({ ...configured, ...patch });
    assert.equal(child.status, 1); assert.equal(child.stderr.trim(), code); assert.equal(child.stdout, '');
  }
});
const preload = new URL('./test-support/entrypoint-preload.mjs', import.meta.url).href;
const uiReceipt = JSON.parse(await readFile(new URL('./ui-build-receipt.json', import.meta.url), 'utf8'));
const matched = { ...configured, HALDIR_APPROVED_ORIGIN: uiReceipt.approvedOrigin };
function guarded(env = {}) {
  const child = spawnSync(process.execPath, ['--import', preload, entry.pathname], {
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, ...matched, ...env } });
  const marker = child.stderr.match(/HALDIR_TEST_RECEIPT (.+)/);
  assert.ok(marker, child.stderr);
  const receipt = JSON.parse(marker[1]);
  assert.equal(receipt.ppid, process.pid);
  assert.equal(receipt.forbiddenTransport, 0);
  return { ...child, receipt, errorCode: child.stderr.split('\n')[0] };
}
test('actual startup enforces Node 26.13.1, not an obsolete absent-adapter expectation', () => {
  const child = guarded({ HALDIR_TEST_NODE_VERSION: '26.13.0' });
  assert.equal(child.status, 1); assert.equal(child.errorCode, 'NODE_26_13_1_REQUIRED');
  assert.equal(child.receipt.readinessReads, 0); assert.equal(child.stdout, '');
});
test('actual entrypoint rejects a UI/server origin mismatch before any database read or listener', () => {
  const child = guarded({ HALDIR_APPROVED_ORIGIN: 'https://wrong-build-origin.invalid', HALDIR_TEST_READINESS: 'deny' });
  assert.equal(child.status, 1); assert.equal(child.errorCode, 'UI_APPROVED_ORIGIN_MISMATCH');
  assert.equal(child.receipt.readinessReads, 0); assert.equal(child.stdout, '');
});
test('actual entrypoint does not advertise readiness when genuine adapter SDK read fails', () => {
  const child = guarded({ HALDIR_TEST_READINESS: 'deny' });
  assert.equal(child.status, 1); assert.equal(child.errorCode, 'PREVIEW_STARTUP_FAILED');
  assert.equal(child.receipt.readinessReads, 1); assert.equal(child.stdout, '');
});
function call(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method,
      headers: { host: new URL(matched.HALDIR_APPROVED_ORIGIN).host, ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(method === 'POST' ? '{}' : undefined);
  });
}
test('actual runtime entrypoint smoke: await adapter readiness, serve UI, keep auth/financial fences, close SDK', async t => {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const name = '.runtime-test-' + randomUUID();
  const artifact = new URL('./' + name + '/', import.meta.url);
  t.after(async () => { await rm(artifact, { recursive: true, force: true });
    await rm(new URL('./' + name + '-manifest.json', import.meta.url), { force: true }); });
  const prepared = spawnSync(process.execPath, [new URL('./prepare-runtime.mjs', import.meta.url).pathname,
    '--out', name, '--test-fixture'], { encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, HALDIR_APPROVED_ORIGIN: matched.HALDIR_APPROVED_ORIGIN } });
  assert.equal(prepared.status, 0, prepared.stderr);
  // Local smoke reuses installed dependencies ONLY in this disposable test tree.
  // The finite retained/upload artifact never contains this symlink or Mac packages.
  await symlink(new URL('./node_modules', import.meta.url), new URL('node_modules', artifact), 'dir');
  const child = spawn(process.execPath, ['--import', preload,
    new URL('deployment/haldir-preview/main.mjs', artifact).pathname], {
    cwd: artifact,
    env: { PATH: process.env.PATH, ...matched, PORT: String(port), HALDIR_TEST_READINESS: 'hold' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; });
  const [message] = await once(child, 'message');
  assert.equal(message.event, 'readiness-read'); assert.equal(message.pid, child.pid);
  assert.equal(stdout, '');
  await assert.rejects(call(port, '/healthz'), { code: 'ECONNREFUSED' });
  child.send('release-readiness');
  while (!stdout.includes('HALDIR_LOGIN_PREVIEW_LISTENING_FINANCIAL_ACTIONS_DISABLED')) {
    const result = await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error(stderr); })]);
    assert.ok(result);
  }
  assert.equal((await call(port, '/healthz')).status, 200);
  assert.equal((await call(port, '/?mode=wallet-auth-qualification')).status, 200);
  assert.equal((await call(port, '/api/pay', {}, 'POST')).status, 404);
  assert.equal((await call(port, '/', { host: 'wrong.invalid' })).status, 403);
  const authHeaders = { origin: matched.HALDIR_APPROVED_ORIGIN, 'content-type': 'application/json', 'x-haldir-csrf': '1' };
  assert.equal((await call(port, '/api/wallet-auth/session', authHeaders, 'POST')).status, 401);
  assert.equal((await call(port, '/api/wallet-auth/session', {}, 'POST')).status, 403);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  const receipt = JSON.parse(stderr.match(/HALDIR_TEST_RECEIPT (.+)/)[1]);
  assert.equal(receipt.pid, child.pid); assert.equal(receipt.ppid, process.pid);
  assert.equal(receipt.nativeNode, process.versions.node); assert.equal(receipt.readinessReads, 1);
  assert.equal(receipt.sdkTerminations, 1); assert.equal(receipt.forbiddenTransport, 0);
  t.diagnostic(JSON.stringify(receipt));
});
