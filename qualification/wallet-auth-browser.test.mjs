import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, transform } from 'esbuild';
import { KeyPair } from 'near-api-js';
import { serializeMessageNep413 } from '@meteorwallet/sdk';
import { chromium } from '../prototype/node_modules/@playwright/test/index.mjs';
import { createWalletAuthHttp } from '../src/server/wallet-auth-http.mjs';
import { createNearOwnerKeyReader } from '../src/server/near-owner-keys.mjs';
import { openLocalRepository } from '../src/server/orders.mjs';
import { startWalletAuthBrowser } from './wallet-auth-browser.mjs';

// This runner permits only owned loopback HTTP and browser static assets. No
// public RPC, real wallet prompt, cloud, system trust change or TLS bypass.
globalThis.fetch = () => { throw new Error('QUALIFICATION_EXTERNAL_FETCH_DENIED'); };
const scratch = join(homedir(), '.hermes/cache/scratch');
const approvedOrigin = 'https://localhost:5443';
const accountId = 'alice.testnet';
const target = { blockchain: 'near', network: 'testnet', accountId };
function syntheticReader(publicKey) {
  return createNearOwnerKeyReader({ rpcUrl: 'https://rpc.testnet.near.org', transport: async (url, init) => {
    assert.equal(url, 'https://rpc.testnet.near.org');
    const r = JSON.parse(init.body);
    if (r.method === 'status') return Response.json({ jsonrpc: '2.0', id: r.id, result: { chain_id: 'testnet', sync_info: { syncing: false } } });
    assert.deepEqual(r.params, { finality: 'final', request_type: 'view_access_key', account_id: accountId, public_key: publicKey });
    return Response.json({ jsonrpc: '2.0', id: r.id, result: { permission: 'FullAccess', nonce: 1, block_height: 123, block_hash: '11111111111111111111111111111111' } });
  } });
}
async function clientModule() {
  const directory = await mkdtemp(join(scratch, 'haldir-wallet-client-'));
  const source = await readFile(new URL('../prototype/src/integration/wallet-auth.ts', import.meta.url), 'utf8');
  const output = await transform(source, { loader: 'ts', format: 'esm', target: 'es2023' });
  const path = join(directory, 'client.mjs'); await writeFile(path, output.code);
  return import(pathToFileURL(path).href);
}

test('actual browser-client -> real loopback handler -> unchanged genuine NEP413 verification (MANUAL COOKIE RELAY, NOT browser-cookie proof)', async t => {
  const { createWalletAuth } = await clientModule();
  const pair = KeyPair.fromRandom('ed25519'); // SYNTHETIC TEST KEY, not an owner key
  const publicKey = pair.getPublicKey().toString();
  const repository = openLocalRepository({ localTestOnly: true, filename: ':memory:' });
  t.after(() => repository.close());
  const server = createWalletAuthHttp({ repository, approvedOrigin, approvedRecipient: 'localhost', trustedAccessKeyReader: syntheticReader(publicKey) });
  const { origin: base } = await server.listen(); t.after(() => server.close());
  let cookie, replay;
  const receipts = [];
  const transport = (url, init) => new Promise((done, reject) => {
    const actual = new URL(url);
    assert.equal(actual.origin, approvedOrigin);
    const req = request(base + actual.pathname, { method: init.method, headers: { ...init.headers, origin: approvedOrigin, host: new URL(approvedOrigin).host, 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) } }, res => {
      const parts = []; res.on('data', c => parts.push(c)); res.on('error', reject);
      res.on('end', () => {
        if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
        if (actual.pathname.endsWith('/verify')) replay = init.body;
        receipts.push({ route: actual.pathname, status: res.statusCode });
        done(new Response(Buffer.concat(parts), { status: res.statusCode }));
      });
    }); req.on('error', reject); req.end(init.body);
  });
  let promptCount = 0;
  const client = createWalletAuth({ origin: approvedOrigin, recipient: 'localhost', secureContext: true, transport, loadMeteor: async () => ({
    getAccount: async () => ({ identifier: target }),
    createAction: async input => {
      assert.equal(input.id, 'near::sign_message'); assert.deepEqual(input.input.target, target);
      assert.equal(input.input.messageParams.nonce.length, 32);
      assert.deepEqual(Object.keys(input.input.messageParams).sort(), ['message', 'nonce', 'recipient']);
      return { promptForExecution: async () => { promptCount++; return { accountId, publicKey: pair.getPublicKey(), signature: pair.sign(serializeMessageNep413(input.input.messageParams)).signature }; } };
    },
  }) });
  await client.resume(); assert.equal(client.getSnapshot().principal, null); assert.equal(promptCount, 0);
  await client.login();
  assert.equal(client.getSnapshot().error, null); assert.equal(client.getSnapshot().principal.accountId, accountId);
  assert.equal(client.getSnapshot().principal.authenticationOnly, true); assert.equal(promptCount, 1);
  const retained = client.getSnapshot().principal;
  assert.equal((await transport(approvedOrigin + '/api/wallet-auth/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-haldir-csrf': '1' }, body: replay })).status, 401);
  const reload = createWalletAuth({ origin: approvedOrigin, recipient: 'localhost', secureContext: true, transport, loadMeteor: async () => { throw new Error('RELOAD_MUST_NOT_LOAD_WALLET'); } });
  await reload.resume(); assert.deepEqual(reload.getSnapshot().principal, retained);
  await reload.logout(); assert.deepEqual(reload.getSnapshot(), { principal: null, busy: false, error: null });
  await client.resume(); assert.equal(client.getSnapshot().principal, null); assert.equal(promptCount, 1);
  assert.ok(receipts.every(r => /^\/api\/wallet-auth\/(challenge|verify|session|logout)$/.test(r.route)));
});

test('installed Google Chrome: actual HTTP rejection, native localhost Secure-cookie policy, browser SDK import; NOT HTTPS login PASS', { timeout: 60_000 }, async t => {
  const bundled = await build({ stdin: { contents: 'export { MeteorConnect, serializeMessageNep413 } from "@meteorwallet/sdk";', resolveDir: resolve('.') }, bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
  assert.ok(Object.keys(bundled.metafile.inputs).every(p => !p.startsWith('node:')));
  const fixed = await build({ stdin: { contents: 'export { MeteorConnect, serializeMessageNep413 } from "@meteorwallet/sdk";', resolveDir: resolve('.') }, bundle: true, platform: 'browser', format: 'esm', define: { global: 'globalThis' }, write: false, metafile: true });
  const app = await startWalletAuthBrowser({ httpProbe: true, trustedAccessKeyReader: () => { throw new Error('HTTP_REJECTION_MUST_PRECEDE_READER'); }, extraAssets: { '/qualification/sdk-probe.js': bundled.outputFiles[0].text, '/qualification/sdk-fixed-experiment.js': fixed.outputFiles[0].text } });
  t.after(() => app.close());
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const context = await browser.newContext();
  const denied = [];
  await context.route('**/*', async route => { if (new URL(route.request().url()).origin !== app.origin) { denied.push(route.request().url()); return route.abort('blockedbyclient'); } return route.continue(); });
  await context.routeWebSocket('**/*', ws => { denied.push(ws.url()); ws.close(); });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.origin + '/?mode=wallet-auth-qualification');
  await page.getByRole('button', { name: 'Log in with connected testnet wallet' }).click();
  await page.getByRole('status').filter({ hasText: 'Local HTTPS is required' }).waitFor();
  assert.equal(app.receipts.length, 0, 'blocked client does not initialize SDK or make HTTP calls');
  const result = await page.evaluate(async () => {
    const r = await fetch('/api/wallet-auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json', 'x-haldir-csrf': '1' }, body: JSON.stringify({ accountId: 'alice.testnet', networkId: 'testnet' }) });
    return { status: r.status, body: await r.json(), secureContext: window.isSecureContext };
  });
  assert.deepEqual(result, { status: 403, body: { error: 'ORIGIN_CSRF_REQUIRED' }, secureContext: true });
  // Native browser cookie store, not context.addCookies or manual Cookie headers.
  await page.evaluate(() => fetch('/qualification/cookie-policy'));
  const probe = (await context.cookies()).find(c => c.name === '__Host-haldir_policy_probe');
  assert.ok(probe); assert.equal(probe.secure, true); assert.equal(probe.httpOnly, true); assert.equal(probe.sameSite, 'Strict'); assert.equal(probe.path, '/');
  assert.equal((await page.evaluate(() => document.cookie)).includes('__Host-haldir_policy_probe'), false);
  assert.equal((await context.cookies()).some(c => c.name === '__Host-haldir_session'), false);
  const rawSdkError = await page.evaluate(async () => {
    try { await import('/qualification/sdk-probe.js'); return null; }
    catch (error) { return error.message; }
  });
  assert.match(rawSdkError, /global is not defined/);
  // Controlled scratch-bundle experiment ONLY, never patches window/global,
  // package files or the prototype Vite configuration.
  const sdk = await page.evaluate(async () => {
    const mod = await import('/qualification/sdk-fixed-experiment.js');
    const instance = new mod.MeteorConnect(); // no initialize/action/prompt
    return { constructor: typeof instance.createAction, bytes: mod.serializeMessageNep413({ message: 'SYNTHETIC BROWSER PACKAGING PROBE ONLY', recipient: 'localhost', nonce: new Uint8Array(32) }).length };
  });
  assert.deepEqual(sdk, { constructor: 'function', bytes: 32 });
  await page.reload();
  await page.getByRole('button', { name: 'Log in with connected testnet wallet' }).waitFor();
  const directory = await mkdtemp(join(scratch, 'haldir-wallet-chrome-'));
  await page.screenshot({ path: join(directory, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(directory, 'mobile.png'), fullPage: true });
  await page.goto(app.origin + '/');
  await page.getByRole('button', { name: 'Send message' }).waitFor();
  assert.equal(app.receipts.length, 1, 'default simulation and reload cannot initiate login HTTP');
  assert.deepEqual(denied, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ evidenceDirectory: directory, browser: await browser.version(), httpChallenge: result.status, localhostSecureContext: result.secureContext, nativeCookieMarker: { secure: probe.secure, httpOnly: probe.httpOnly, sameSite: probe.sameSite }, sdkDefaultBundle: rawSdkError, sdkControlledBundlerExperiment: sdk, actualAuthenticationCookie: 'NOT_ISSUED', httpsLogin: 'BLOCKED_NO_TRUSTED_TLS', externalAttempts: denied.length }));
});

test('HTTPS harness does not generate trust, ignore certificate errors or silently downgrade transport', async () => {
  await assert.rejects(startWalletAuthBrowser({ trustedAccessKeyReader: async () => null }), /BROWSER_TRUSTED_LOCAL_TLS_REQUIRED/);
});
