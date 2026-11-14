import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
const scratchRoot = join(homedir(), '.hermes/cache/scratch');
import { createRequire } from 'node:module';
import { request } from 'node:http';
import { startLocalJourneyUi, advanceLocalFixture } from './local-journey-ui.mjs';
const { chromium, expect } = createRequire(new URL('../prototype/package.json', import.meta.url))('@playwright/test');

test('served Chrome + real HTTP: unknown/unpaid pending, paid missing delivery, same artifact across reload and backend restart', async t => {
  const directory = await mkdtemp(join(scratchRoot, 'haldir-local-ui-proof-'));
  let app = await startLocalJourneyUi({ directory });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const remoteAttempts = [], calls = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== app.origin) { remoteAttempts.push(url.href); return route.abort(); }
    return route.continue();
  });
  page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/')) calls.push({ path: new URL(req.url()).pathname, method: req.method(), body: req.postData() }); });
  await page.goto(app.origin + '/?mode=local-qualification');
  await expect(page.getByRole('region', { name: 'Preview notice' })).toContainText('LOCAL backend');
  await page.getByRole('button', { name: 'Open approved local job' }).click();
  await expect(page.getByTestId('local-lifecycle')).toHaveText('PAYMENT_PENDING');
  const jobId = await page.getByTestId('local-job-id').innerText();
  const path = `/api/jobs/${jobId}/order`;
  const readOrder = async () => { const res = await fetch(app.origin + path); assert.equal(res.status, 200); return res.json(); };
  await page.getByRole('button', { name: 'Check local receipt' }).click();
  await expect(page.getByText('EVIDENCE_UNAVAILABLE', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retrieve same local delivery' })).toBeDisabled();
  assert.equal((await readOrder()).proof, null);
  await advanceLocalFixture({ directory, stage: 'unpaid' });
  await page.getByRole('button', { name: 'Check local receipt' }).click();
  await expect(page.getByText('NOT_FINAL', { exact: true })).toBeVisible();
  assert.equal((await readOrder()).lifecycle, 'PAYMENT_PENDING');
  await page.reload();
  await expect(page.getByTestId('local-job-id')).toHaveText(jobId);
  await expect(page.getByTestId('local-lifecycle')).toHaveText('PAYMENT_PENDING');
  await page.screenshot({ path: join(directory, 'pending-desktop.png') });

  await advanceLocalFixture({ directory, stage: 'paid' });
  await page.getByRole('button', { name: 'Check local receipt' }).click();
  await expect(page.getByTestId('local-lifecycle')).toHaveText('PAID_NOT_DELIVERED');
  const paid = await readOrder();
  assert.equal(paid.artifact, null);
  assert.ok(paid.proof.proofId);
  await page.screenshot({ path: join(directory, 'paid-missing-desktop.png') });
  await page.reload();
  await expect(page.getByTestId('local-lifecycle')).toHaveText('PAID_NOT_DELIVERED');
  await expect(page.getByTestId('local-job-id')).toHaveText(jobId);
  await page.getByRole('button', { name: 'Retrieve same local delivery' }).click();
  await expect(page.getByTestId('local-lifecycle')).toHaveText('DELIVERED');
  const delivered = await readOrder();
  assert.deepEqual(delivered.proof, paid.proof);
  assert.equal(delivered.artifact.fictionalSample, true);
  await expect(page.getByTestId('local-artifact-id')).toHaveText(delivered.artifact.artifactId);
  await expect(page.getByTestId('local-artifact-digest')).toHaveText(delivered.artifact.contentDigest);
  await page.getByRole('article', { name: 'Fictional local artifact' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, 'delivered-desktop.png') });
  await page.reload();
  await expect(page.getByTestId('local-lifecycle')).toHaveText('DELIVERED');
  await page.getByRole('button', { name: 'Retrieve same local delivery' }).click();
  await expect(page.getByRole('button', { name: 'Retrieve same local delivery' })).toBeEnabled();
  assert.deepEqual(await readOrder(), delivered);

  const port = new URL(app.origin).port;
  await app.close();
  app = await startLocalJourneyUi({ directory, port: Number(port) });
  await page.reload();
  await expect(page.getByTestId('local-lifecycle')).toHaveText('DELIVERED');
  assert.deepEqual(await readOrder(), delivered);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('article', { name: 'Fictional local artifact' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, 'delivered-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole('button', { name: 'Task panel' }).click();
  await expect(page.getByRole('dialog')).toContainText('Local qualification only');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Task panel' })).toBeFocused();

  // Default simulation remains isolated even through this same-origin launcher.
  const beforeSimulation = calls.length;
  await page.goto(app.origin + '/');
  // The approved simulation now enters through its composer, not a Shape button.
  await page.getByRole('textbox', { name: 'Your message' }).fill('budget 30');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('region', { name: 'Spending review' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Preview notice' })).toContainText('Scripted simulation');
  assert.equal(calls.length, beforeSimulation);
  assert.deepEqual(await readOrder(), delivered);
  assert.equal(calls.filter(call => call.path === '/api/jobs' && call.method === 'POST').length, 1);
  for (const call of calls.filter(call => call.method === 'POST')) {
    assert.deepEqual(JSON.parse(call.body), call.path === '/api/jobs' ? { approvalId: 'local-ui-v1', admissionKey: 'local-ui-v1' } : {});
  }
  assert.deepEqual(remoteAttempts, []);
  assert.deepEqual(errors, []);
  const receipt = { qualification: 'LOCAL_SYNTHETIC_ONLY', origin: app.origin, directory, jobId, artifact: delivered.artifact, proof: delivered.proof, calls, remoteAttempts, errors };
  await writeFile(join(directory, 'browser-evidence.json'), JSON.stringify(receipt, null, 2));
  assert.equal(JSON.parse(await readFile(join(directory, 'browser-evidence.json'))).jobId, jobId);
  console.log(JSON.stringify({ evidence: directory, jobId, requests: calls.length, result: 'PASS' }));
});

test('launcher preserves strict incoming and backend origin/body boundaries without a public operator route', async t => {
  const directory = await mkdtemp(join(scratchRoot, 'haldir-local-ui-boundary-'));
  const app = await startLocalJourneyUi({ directory });
  t.after(() => app.close());
  const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId: 'local-ui-v1', admissionKey: 'local-ui-v1' }) };
  const foreign = await fetch(app.origin + '/api/jobs', { ...options, headers: { ...options.headers, origin: 'https://foreign.invalid' } });
  assert.equal(foreign.status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = request(app.origin + '/', { headers: { host: 'foreign.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  const admitted = await fetch(app.origin + '/api/jobs', { ...options, headers: { ...options.headers, origin: app.origin } });
  assert.equal(admitted.status, 201);
  const job = await admitted.json();
  for (const suffix of ['/check', '/delivery']) {
    const res = await fetch(`${app.origin}/api/jobs/${job.jobId}/order${suffix}`, { ...options, body: JSON.stringify({ paid: true, proof: {} }) });
    assert.equal(res.status, 400);
  }
  for (const route of ['/api/pay', '/api/stop', '/api/withdraw', '/api/fixture', '/internal/advance', '/src/server/orders.mjs']) {
    assert.equal((await fetch(app.origin + route, options)).status, 404);
  }
  assert.equal((await fetch(app.backendOrigin + '/api/jobs', { ...options, headers: { ...options.headers, origin: app.origin } })).status, 403);
});

test('served Chrome recovers a persisted job after fresh-state restart on the exact same origin', async t => {
  const directory = await mkdtemp(join(scratchRoot, 'haldir-local-ui-fresh-restart-'));
  const freshDirectory = await mkdtemp(join(scratchRoot, 'haldir-local-ui-fresh-successor-'));
  let app = await startLocalJourneyUi({ directory });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage();
  const calls = [], remoteAttempts = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== app.origin) {
      remoteAttempts.push(route.request().url()); return route.abort();
    }
    return route.continue();
  });
  page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/')) calls.push({ path: new URL(req.url()).pathname, method: req.method(), body: req.postData() }); });
  await page.goto(app.origin + '/?mode=local-qualification');
  await page.getByRole('button', { name: 'Open approved local job' }).click();
  await expect(page.getByTestId('local-lifecycle')).toHaveText('PAYMENT_PENDING');
  const oldJobId = await page.getByTestId('local-job-id').innerText();
  const origin = app.origin;
  const storageKey = `haldir-local-ui-v1:${origin}`;
  assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), oldJobId);
  await app.close();
  app = await startLocalJourneyUi({ directory: freshDirectory, port: Number(new URL(origin).port) });
  assert.equal(app.origin, origin);
  const missing = await fetch(`${origin}/api/jobs/${oldJobId}`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'NOT_FOUND', qualification: 'LOCAL_SYNTHETIC_ONLY' });
  await page.reload();
  await expect(page.getByTestId('local-lifecycle')).toHaveText('PAYMENT_PENDING');
  const newJobId = await page.getByTestId('local-job-id').innerText();
  assert.notEqual(newJobId, oldJobId);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), newJobId);
  assert.deepEqual(calls.slice(2).map(call => [call.path, call.method]), [
    [`/api/jobs/${oldJobId}`, 'GET'], ['/api/jobs', 'POST'], [`/api/jobs/${newJobId}/order`, 'GET'],
  ]);
  await page.reload();
  await expect(page.getByTestId('local-job-id')).toHaveText(newJobId);
  await expect(page.getByTestId('local-lifecycle')).toHaveText('PAYMENT_PENDING');
  const admissions = calls.filter(call => call.method === 'POST');
  assert.equal(admissions.length, 2);
  for (const call of admissions) assert.deepEqual(JSON.parse(call.body), { approvalId: 'local-ui-v1', admissionKey: 'local-ui-v1' });
  const order = await (await fetch(`${origin}/api/jobs/${newJobId}/order`)).json();
  assert.equal(order.proof, null);
  assert.equal(order.artifact, null);
  assert.deepEqual(remoteAttempts, []);
  assert.deepEqual(errors, []);
  const evidence = { origin, directory, freshDirectory, oldJobId, newJobId, calls, remoteAttempts, errors, order };
  await writeFile(join(directory, 'fresh-restart-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ freshRestartEvidence: directory, origin, oldJobId, newJobId, result: 'PASS' }));
});
