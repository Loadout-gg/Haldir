import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrders, openLocalRepository } from '../../src/server/orders.mjs';
import { createLocalApp } from '../../src/server/app.mjs';
import { syntheticPayment } from '../../src/vendor/fixture.mjs';

const approved = (orderId, mandateId) => ({
  job: { networkId: 'testnet', mandateId, purpose: 'Restart-qualified local sample', output: 'Fictional artifact',
    budgetAtomic: '3000000000000000000000000', vendorIds: ['vendor.testnet'], expiresAt: '2026-11-13T12:00:00Z' },
  quote: { networkId: 'testnet', mandateId, vendorId: 'vendor.testnet', amountAtomic: '3000000000000000000000000',
    orderId, content: 'Fictional supplier sample' },
});

if (process.argv[2] === '--local-child') {
  // A real isolated process, no inherited credentials, no external transport.
  // IPC fixture controls are harness-only and NEVER HTTP routes/session powers.
  globalThis.fetch = () => { throw new Error('all child fetch is forbidden'); };
  let evidenceAvailable = false, collections = 0;
  const repository = openLocalRepository({ filename: process.argv[3], localTestOnly: true });
  const orders = createOrders({ repository, localTestOnly: true, now: () => Date.parse('2026-11-12T12:00:00Z'),
    trustedReceiptCollector: ({ quote }) => { collections++; return evidenceAvailable ? syntheticPayment(quote).evidence : null; } });
  const app = createLocalApp({ orders, localTestOnly: true,
    testOnlySession: req => ({ alice: 'alice.testnet', bob: 'bob.testnet' })[req.headers['x-test-session']] ?? null,
    trustedApprovalLookup: ({ ownerId, approvalId }) => {
      if (ownerId === 'alice.testnet' && approvalId === 'alice-approval') return approved('quote-alice', 'alice-job.testnet');
      if (ownerId === 'bob.testnet' && approvalId === 'bob-approval') return approved('quote-bob', 'bob-job.testnet');
      return null;
    } });
  const { origin } = await app.listen();
  process.on('message', async message => {
    try {
      let result;
      if (message.op === 'evidence') { evidenceAvailable = message.value === true; result = true; }
      else if (message.op === 'counts') result = { collections };
      else if (message.op === 'local-stop') result = await orders.stopLocalJob({ ownerId: 'alice.testnet', jobId: message.jobId });
      else throw new Error('unknown test control');
      process.send({ id: message.id, result });
    } catch (error) { process.send({ id: message.id, error: error.message }); }
  });
  process.send({ ready: true, origin, pid: process.pid });
} else {
  test('real loopback journey across process kills preserves pending/paid/delivery IDs and blocks cross-owner/receipt reuse', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'haldir-process-restart-'));
    const filename = join(dir, 'durable.sqlite');
    const children = [];
    t.after(async () => {
      for (const p of children) if (p.exitCode === null && p.signalCode === null) { p.kill('SIGKILL'); await once(p, 'exit'); }
      await rm(dir, { recursive: true, force: true });
    });
    async function boot() {
      // Positive environment allowlist: no NODE_OPTIONS/NODE_TEST_CONTEXT,
      // provider/cloud credentials, preload flags or operator secrets forwarded.
      const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
      const child = fork(fileURLToPath(import.meta.url), ['--local-child', filename], {
        env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdout.resume();
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`local child startup timeout: ${stderr}`)), 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`child exit ${code}/${signal}: ${stderr}`)); });
        child.once('message', message => { clearTimeout(timer); resolve(message); });
      });
      assert.equal(ready.ready, true);
      assert.equal(ready.pid, child.pid);
      assert.equal(new URL(ready.origin).hostname, '127.0.0.1');
      let sequence = 0;
      async function control(op, data = {}) {
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.off('message', onMessage); reject(new Error('test IPC timeout')); }, 5000);
          function onMessage(m) {
            if (m.id !== id) return;
            clearTimeout(timer); child.off('message', onMessage);
            if (m.error) reject(new Error(m.error)); else resolve(m.result);
          }
          child.on('message', onMessage);
          child.send({ id, op, ...data });
        });
      }
      async function http(path, body, session = 'alice') {
        const response = await fetch(ready.origin + path, { method: body === undefined ? 'GET' : 'POST',
          headers: { 'x-test-session': session, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
        return { status: response.status, body: await response.json() };
      }
      return { child, control, http, async kill() {
        const exited = once(child, 'exit'); child.kill('SIGKILL');
        const [code, signal] = await exited;
        assert.equal(code, null); assert.equal(signal, 'SIGKILL');
      } };
    }
    const one = await boot();
    const created = await one.http('/api/jobs', { approvalId: 'alice-approval', admissionKey: 'same-admission' });
    assert.equal(created.status, 201);
    const job = created.body;
    const path = `/api/jobs/${job.jobId}`;
    const pending = await one.http(path + '/order/check', {});
    assert.equal(pending.body.lifecycle, 'PAYMENT_PENDING');
    assert.equal(pending.body.lastCheckCode, 'EVIDENCE_UNAVAILABLE');
    assert.equal((await one.http(path + '/order/delivery', {})).status, 409);
    await one.kill(); // abrupt process death with persisted pending identity

    const two = await boot();
    assert.notEqual(two.child.pid, one.child.pid);
    assert.deepEqual((await two.http('/api/jobs', { approvalId: 'alice-approval', admissionKey: 'same-admission' })).body, job);
    assert.deepEqual((await two.http(path + '/order')).body, pending.body);
    await two.control('evidence', { value: true });
    const paid = await two.http(path + '/order/check', {});
    assert.equal(paid.body.lifecycle, 'PAID_NOT_DELIVERED');
    assert.equal(paid.body.orderId, pending.body.orderId);
    assert.equal(paid.body.artifact, null);
    assert.equal((await two.control('local-stop', { jobId: job.jobId })).state, 'LOCAL_STOPPED');
    await two.kill(); // payment claim + missing-delivery pointer must survive

    const three = await boot();
    assert.equal((await three.http(path)).body.state, 'LOCAL_STOPPED');
    assert.deepEqual((await three.http(path + '/order')).body, paid.body);
    const delivered = await three.http(path + '/order/delivery', {});
    assert.equal(delivered.status, 200);
    assert.equal(delivered.body.lifecycle, 'DELIVERED');
    assert.equal(delivered.body.artifact.fictionalSample, true);
    assert.deepEqual(delivered.body.proof, paid.body.proof);
    assert.deepEqual((await three.http(path + '/order/delivery', {})).body, delivered.body);
    assert.deepEqual((await three.http(path + '/order/check', {})).body, delivered.body);
    assert.equal((await three.control('counts')).collections, 0, 'recovery/retrieval does not collect receipts, let alone pay');
    for (const suffix of ['', '/order', '/order/check', '/order/delivery']) {
      assert.equal((await three.http(path + suffix, suffix.endsWith('check') || suffix.endsWith('delivery') ? {} : undefined, 'bob')).status, 404);
    }
    const second = await three.http('/api/jobs', { approvalId: 'bob-approval', admissionKey: 'same-admission' }, 'bob');
    assert.equal(second.status, 201);
    assert.notEqual(second.body.jobId, job.jobId, 'admission identities are owner-scoped');
    await three.control('evidence', { value: true });
    const conflict = await three.http(`/api/jobs/${second.body.jobId}/order/check`, {}, 'bob');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'PROOF_ALREADY_CLAIMED');
    assert.equal((await three.http(`/api/jobs/${second.body.jobId}/order`, undefined, 'bob')).body.proof, null);
    await three.kill();

    const four = await boot();
    assert.deepEqual((await four.http(path + '/order/delivery', {})).body, delivered.body);
    assert.deepEqual((await four.http(path + '/order/check', {})).body, delivered.body);
    assert.equal((await four.control('counts')).collections, 0);
    await four.kill();
    t.diagnostic(JSON.stringify({ jobId: job.jobId, quoteId: job.quoteId, orderId: paid.body.orderId,
      proofId: paid.body.proof.proofId, artifactId: delivered.body.artifact.artifactId,
      distinctProcessIds: children.map(c => c.pid), qualification: 'LOCAL_SYNTHETIC_ONLY' }));
  });
}
