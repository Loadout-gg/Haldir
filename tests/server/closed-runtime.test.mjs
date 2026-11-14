// Public-only closed-runtime smoke checks. Synthetic HTTP host, not a UI build,
// authenticated wallet journey, hosted Firestore run or financial activation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const configured = { HALDIR_APPROVED_ORIGIN: 'https://haldir.ldt.sh',
  GOOGLE_CLOUD_PROJECT: 'loadout-haldir-demo', HALDIR_PROJECT_NUMBER: '147018706305',
  HALDIR_REGION: 'europe-west1', HALDIR_FIRESTORE_DATABASE_ID: 'haldir', PORT: '8080' };
const fence = 'data:text/javascript,' + encodeURIComponent(`
  import net from 'node:net'; import tls from 'node:tls';
  import http from 'node:http'; import https from 'node:https'; import http2 from 'node:http2';
  import { syncBuiltinESMExports } from 'node:module';
  const c={pid:process.pid,ppid:process.ppid,transport:0,listens:0};
  const deny=()=>{c.transport++;throw Error('CLOSED_SMOKE_EXTERNAL_DENIED');};
  for(const [o,k] of [[globalThis,'fetch'],[net.Socket.prototype,'connect'],[tls,'connect'],
    [http,'request'],[http,'get'],[https,'request'],[https,'get'],[http2,'connect']])o[k]=deny;
  net.Server.prototype.listen=()=>{c.listens++;throw Error('CLOSED_SMOKE_LISTEN_DENIED');};
  syncBuiltinESMExports();
  process.on('exit',()=>process.stderr.write('CLOSED_SMOKE_FENCE '+JSON.stringify(c)+'\\n'));
`);
function child(entry, patch) {
  const value = spawnSync(process.execPath, ['--import', fence, fileURLToPath(new URL(entry, root))], {
    encoding: 'utf8', timeout: 5000, cwd: root,
    // No inherited provider credentials, preload flags or parent test context.
    env: { PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir(), ...patch },
  });
  assert.equal(value.error, undefined);
  const marker = value.stderr.match(/CLOSED_SMOKE_FENCE (.+)\n/);
  assert.ok(marker, value.stderr);
  const c = JSON.parse(marker[1]);
  assert.equal(c.ppid, process.pid); assert.ok(c.pid > 0);
  assert.equal(c.transport, 0); assert.equal(c.listens, 0);
  return { ...value, stderr: value.stderr.replace(marker[0], '') };
}
test('unconfigured genuine public and preview executables refuse before network or listen', () => {
  for (const entry of ['deployment/haldir-public/main.mjs', 'deployment/haldir-preview/main.mjs']) {
    const result = child(entry, {});
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'EXACT_HTTPS_ORIGIN_REQUIRED');
  }
});
test('genuine public executable requires generated UI receipt before cloud imports', () => {
  // This assertion intentionally applies to a source-only checkout, without a
  // generated ui-build-receipt.json. Never synthesize that receipt to boot main.
  const result = child('deployment/haldir-public/main.mjs', configured);
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'UI_APPROVED_ORIGIN_MISMATCH');
});
function call(server, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port,
      path, method: options.method ?? 'GET', headers: { host: 'closed.example',
        origin: 'https://closed.example', 'x-haldir-csrf': '1', 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(options.body);
  });
}
test('public source graph starts a loopback synthetic host with closed production capabilities', async t => {
  let transports = 0;
  t.mock.method(globalThis, 'fetch', () => { transports++; throw Error('CLOSED_SMOKE_EXTERNAL_DENIED'); });
  const { openLocalRepository } = await import('../../src/server/orders.mjs');
  const { readProductionBinding } = await import('../../deployment/haldir-public/production-binding.mjs');
  const { createTrustedComposition } = await import('../../deployment/haldir-public/trusted-composition.mjs');
  const { createPublicServer } = await import('../../deployment/haldir-public/server.mjs');
  const { startPublicRuntime } = await import('../../deployment/haldir-public/main.mjs');
  assert.equal(typeof startPublicRuntime, 'function'); // inert import, not hosted startup
  assert.deepEqual(readProductionBinding(), { schemaVersion: 'haldir.production-binding.v1', state: 'closed' });
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  const uiDir = await mkdtemp(join(tmpdir(), 'haldir-closed-smoke-'));
  let server;
  try {
    await mkdir(join(uiDir, 'assets')); await mkdir(join(uiDir, 'fonts'));
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>SYNTHETIC HOST ONLY</title>');
    const composition = createTrustedComposition({ repository });
    assert.deepEqual(composition.capabilities, { publicTestnet: true, financialActions: false, qualifiedModel: false, qualifiedSigning: false });
    assert.equal(Object.hasOwn(composition, 'model'), false);
    assert.equal(Object.hasOwn(composition, 'trustedSignerProvider'), false);
    server = await createPublicServer({ uiDir, approvedOrigin: 'https://closed.example', repository, ...composition });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    assert.deepEqual(await call(server, '/healthz'), { status: 200, text: '{"alive":true}' });
    assert.equal((await call(server, '/api/public/jobs', { method: 'POST', body: '{"approvalId":"synthetic","admissionKey":"one"}' })).status, 401);
    assert.equal(transports, 0);
  } finally {
    if (server?.listening) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    repository.close(); await rm(uiDir, { recursive: true, force: true });
  }
  assert.equal(transports, 0);
});
