import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

// Isolate a potentially fatal regression from the test runner and any live UI.
async function launch(t, fault) {
  const directory = await mkdtemp(join(homedir(), '.hermes/cache/scratch/haldir-proxy-regression-'));
  const args = fault ? ['--input-type=module', '--eval', `
    import http from 'node:http';
    import { syncBuiltinESMExports } from 'node:module';
    let armed = true;
    const originalRequest = http.request;
    const originalPipe = http.IncomingMessage.prototype.pipe;
    http.request = function (...args) {
      if (armed && String(args[0]).endsWith('/api/jobs/injected') && ${JSON.stringify(fault)} !== 'handler') {
        armed = false;
        if (${JSON.stringify(fault)} === 'sync') throw new Error('TEST_SYNC_REQUEST_FAILURE');
        const upstream = originalRequest(...args);
        queueMicrotask(() => upstream.destroy(new Error('TEST_ASYNC_REQUEST_FAILURE')));
        return upstream;
      }
      return originalRequest(...args);
    };
    http.IncomingMessage.prototype.pipe = function (destination, ...args) {
      if (armed && this.url === '/api/jobs/injected' && ${JSON.stringify(fault)} === 'handler') {
        armed = false; setImmediate(() => destination.destroy()); throw new Error('TEST_HANDLER_REJECTION');
      }
      return originalPipe.call(this, destination, ...args);
    };
    syncBuiltinESMExports();
    const { startLocalJourneyUi } = await import('./qualification/local-journey-ui.mjs');
    const app = await startLocalJourneyUi({ directory: ${JSON.stringify(directory)} });
    console.log(JSON.stringify({ url: app.origin }));
    process.once('SIGTERM', async () => { await app.close(); process.exitCode = 0; });
  `] : ['qualification/local-journey-ui.mjs', `--state-dir=${directory}`];
  const child = spawn(process.execPath, args, {
    cwd: new URL('..', import.meta.url),
    env: { HOME: homedir(), PATH: process.env.PATH, TMPDIR: join(homedir(), '.hermes/cache/scratch') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; } });
  const line = await Promise.race([
    once(child.stdout, 'data').then(([chunk]) => String(chunk)),
    once(child, 'exit').then(([code]) => { throw new Error(`Launcher exited ${code}: ${stderr}`); }),
  ]);
  const { url } = JSON.parse(line.trim());
  return { origin: new URL(url).origin, child, stderr: () => stderr };
}

function raw(origin, path, headers = {}, { method = 'GET', body } = {}) {
  return new Promise(resolve => {
    const req = request(origin, { path, headers, method, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', error => resolve({ error: error.message }));
    req.setTimeout(3000, () => req.destroy(new Error('LOCAL_TEST_TIMEOUT')));
    req.end(body);
  });
}

for (const fault of ['sync', 'async', 'handler']) {
  test(`real HTTP injected ${fault} failure is contained and the next API request still works`, { timeout: 15_000 }, async t => {
    const app = await launch(t, fault);
    const response = await raw(app.origin, '/api/jobs/injected');
    assert.equal(response.status, fault === 'handler' ? 500 : 502, JSON.stringify({ response, stderr: app.stderr() }));
    assert.deepEqual(JSON.parse(response.body), {
      error: fault === 'handler' ? 'LOCAL_INTERNAL_ERROR' : 'LOCAL_BACKEND_UNAVAILABLE', qualification: 'LOCAL_SYNTHETIC_ONLY',
    });
    assert.equal((await raw(app.origin, '/api/jobs/missing')).status, 404);
    assert.equal((await raw(app.origin, '/')).status, 200);
    assert.equal(app.child.exitCode, null, app.stderr());
  });
}

for (const kind of ['absolute', 'malformed']) {
  test(`real HTTP ${kind} request cannot terminate the local launcher`, { timeout: 15_000 }, async t => {
    const app = await launch(t);
    const target = kind === 'absolute' ? 'http://foreign.invalid/api/jobs/missing' : 'http://[';
    const result = await raw(app.origin, target);
    assert.equal(result.status, kind === 'absolute' ? 404 : 400, JSON.stringify({ result, stderr: app.stderr() }));
    assert.equal((await raw(app.origin, '/')).status, 200, app.stderr());
    assert.equal(app.child.exitCode, null, app.stderr());
    if (kind === 'absolute') {
      assert.deepEqual(JSON.parse(result.body), { error: 'NOT_FOUND', qualification: 'LOCAL_SYNTHETIC_ONLY' });
      // A dropped query would wrongly turn this valid admission into a 201.
      const headers = { 'content-type': 'application/json', origin: app.origin };
      const admission = { method: 'POST', body: JSON.stringify({ approvalId: 'local-ui-v1', admissionKey: 'local-ui-v1' }) };
      assert.equal((await raw(app.origin, 'http://foreign.invalid/api/jobs?unexpected=1', headers, admission)).status, 404);
      assert.equal((await raw(app.origin, 'http://foreign.invalid/api/jobs#fragment', headers, admission)).status, 404);
      const admitted = await raw(app.origin, 'http://foreign.invalid/api/jobs', headers, admission);
      assert.equal(admitted.status, 201);
      const job = JSON.parse(admitted.body);
      assert.equal((await raw(app.origin, `/api/jobs/${job.jobId}`)).status, 200);
      assert.equal((await raw(app.origin, target, { host: 'foreign.invalid' })).status, 403);
      assert.equal((await raw(app.origin, target, { origin: 'http://foreign.invalid' })).status, 403);
      for (const path of ['/src/server/app.mjs', '/assets/%', '/assets/%2e%2e/%2e%2e/src/server/app.mjs']) {
        assert.equal((await raw(app.origin, path)).status, 404);
      }
      assert.equal((await raw(app.origin, '/')).status, 200);
    }
  });
}
