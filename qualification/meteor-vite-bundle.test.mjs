import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from '../prototype/node_modules/vite/dist/node/index.js';
import { chromium } from '../prototype/node_modules/@playwright/test/index.mjs';

const root = fileURLToPath(new URL('../prototype/', import.meta.url));
const virtualEntry = '\0haldir-meteor-bundle-probe';

// Actual project Vite configuration and installed ancestor SDK, not esbuild,
// SDK mocks, copied vendor code, a global shim or a default live-wallet loader.
// A virtual TEST entry keeps this closed qualification out of the product App.
test('project Vite Meteor chunk imports and initializes in Chrome without wallet connection, prompts or network', { timeout: 60_000 }, async t => {
  const output = await build({
    root,
    configFile: fileURLToPath(new URL('../prototype/vite.config.ts', import.meta.url)),
    logLevel: 'warn',
    plugins: [{
      name: 'haldir-test-only-meteor-entry',
      resolveId: id => id === 'haldir-meteor-bundle-probe' ? virtualEntry : null,
      load: id => id === virtualEntry ? `
        export const loadMeteor = () => import('@meteorwallet/sdk');
        export { createWalletAuth } from ${JSON.stringify(root + 'src/integration/wallet-auth.ts')};
      ` : null,
    }],
    build: { write: false, minify: true, rollupOptions: { input: 'haldir-meteor-bundle-probe', preserveEntrySignatures: 'strict' } },
  });
  assert.ok(!Array.isArray(output) && 'output' in output);
  const chunks = output.output.filter(item => item.type === 'chunk');
  const entry = chunks.find(item => item.isEntry);
  const meteor = chunks.find(item => Object.keys(item.modules).some(id => id.endsWith('/@meteorwallet/sdk/dist/index.js')));
  assert.ok(entry && meteor && entry.fileName !== meteor.fileName, 'real installed SDK must be a separate dynamic Vite chunk');
  assert.ok(chunks.every(chunk => Object.keys(chunk.modules).every(id => !id.startsWith('node:'))));
  const assets = new Map(output.output.map(item => ['/' + item.fileName, item.type === 'chunk' ? item.code : item.source]));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('cache-control', 'no-store');
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Closed Meteor Vite qualification — not login</title>'); return; }
    if (!assets.has(req.url)) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', 'text/javascript'); res.end(assets.get(req.url));
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  t.after(() => new Promise(done => server.close(done)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const denied = [], errors = [], popups = [], dialogs = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && (url.pathname === '/' || assets.has(url.pathname)) && route.request().method() === 'GET') return route.continue();
    denied.push(route.request().url()); return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', socket => { denied.push(socket.url()); socket.close(); });
  context.on('page', page => { if (context.pages().length > 1) { popups.push(page.url()); void page.close(); } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss(); });
  await page.goto(origin);
  const result = await page.evaluate(async entryPath => {
    const { loadMeteor, createWalletAuth } = await import(entryPath);
    const mod = await loadMeteor(); // RED fails here with ReferenceError: global is not defined.
    const sdk = new mod.MeteorConnect();
    const values = new Map();
    const storage = {
      setItem: async (key, value) => { values.set(key, value); },
      getItem: async key => values.get(key) ?? null,
      removeItem: async key => { values.delete(key); },
      getKeys: async (prefix = '') => [...values.keys()].filter(key => key.startsWith(prefix)),
    };
    // Empty ephemeral storage; bridge, transfers and native-app opening disabled.
    // No connect, signIn, createAction, promptForExecution or real signature.
    await sdk.initialize({ storage, mobileBridge: { enabled: false, autoOpenPairedWallet: false, transferAccounts: { enabled: false, persistStagedAccounts: false }, newKeyTransfer: { enabled: false } } });
    const account = await sdk.getAccount({ blockchain: 'near', network: 'testnet' });
    const bytes = mod.serializeMessageNep413({ message: 'SYNTHETIC PACKAGING PROBE ONLY', recipient: 'localhost', nonce: new Uint8Array(32) });
    let authRequests = 0;
    const client = createWalletAuth({ origin: 'https://localhost:5443', recipient: 'localhost', secureContext: true, transport: async () => { authRequests++; throw new Error('NO_AUTH_TRANSPORT_ALLOWED'); } });
    await client.login(); // Still fail-closed; successful SDK init is NOT login.
    return { initialized: sdk.localStorageImplementation === storage, accountAbsent: account === undefined, serializedBytes: bytes.length, defaultAuth: client.getSnapshot(), authRequests, browserGlobal: typeof global, persistentStorageKeys: localStorage.length };
  }, '/' + entry.fileName);
  assert.deepEqual(result, {
    initialized: true, accountAbsent: true, serializedBytes: 32,
    defaultAuth: { principal: null, busy: false, error: 'METEOR_BROWSER_BUNDLE_REQUIRED' },
    authRequests: 0, browserGlobal: 'undefined', persistentStorageKeys: 0,
  });
  assert.deepEqual(denied, []); assert.deepEqual(errors, []); assert.deepEqual(popups, []); assert.deepEqual(dialogs, []);
  assert.ok(requests.includes('/' + meteor.fileName), 'Chrome fetched the actual generated Meteor chunk');
  assert.equal((await context.cookies()).length, 0);
  const installed = JSON.parse(await readFile(new URL('../node_modules/@meteorwallet/sdk/package.json', import.meta.url), 'utf8'));
  console.log(JSON.stringify({ browser: await browser.version(), sdkVersion: installed.version, config: 'prototype/vite.config.ts', entry: entry.fileName, meteorChunk: meteor.fileName, moduleId: Object.keys(meteor.modules).find(id => id.endsWith('/@meteorwallet/sdk/dist/index.js')), ...result, deniedRequests: denied, pageErrors: errors, popups, dialogs, login: 'NOT_AUTHENTICATED', tls: 'NOT_REQUIRED_FOR_BUNDLE_PROOF' }));
});
