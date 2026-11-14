import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from '../node_modules/vite/dist/node/index.js';
import { chromium } from '../node_modules/@playwright/test/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = fileURLToPath(new URL('../../.hermes/reviews/haldir-wallet-association-fix/', import.meta.url));
const origin = 'https://approved-login.invalid'; // intercepted fixture, NOT TLS/deployment proof
const virtual = '\0haldir-closed-wallet-boundary';
const realSdk = fileURLToPath(new URL('../../node_modules/@meteorwallet/sdk/dist/index.js', import.meta.url));
const publicKey = 'ed25519:11111111111111111111111111111111';

// Real installed SDK initialization, action construction, execution, registry writes,
// targeted-account expansion and reads. ONLY its UI and provider transport are synthetic.
const boundary = `
import { MeteorConnect as RealMeteorConnect, webpage_local_storage } from ${JSON.stringify(realSdk)};
export { webpage_local_storage };
window.__boundary = { initialized: 0, requests: [], prompts: [], reads: [], selection: 'chosen.testnet', mode: 'ok' };
export class MeteorConnect extends RealMeteorConnect {
  async initialize(config) {
    await super.initialize(config);
    window.__boundary.initialized++;
    this.clients.v1.makeRequest = async (request, connection) => {
      const state = window.__boundary;
      state.requests.push({ id: request.id, expandedInput: request.expandedInput, connection });
      if (state.mode === 'cancel') throw new Error('Action was cancelled');
      if (request.id === 'near::sign_in') return {
        identifier: { blockchain: 'near', network: state.mode === 'wrong-network' ? 'mainnet' : 'testnet', accountId: state.selection },
        publicKeys: [], connection: { executionTarget: 'v1_web' }
      };
      if (request.id === 'near::sign_message') return {
        accountId: request.expandedInput.target.accountId,
        publicKey: { toString: () => ${JSON.stringify(publicKey)} }, signature: new Uint8Array(64).fill(1)
      };
      throw new Error('UNEXPECTED_WALLET_ACTION');
    };
  }
  async getAccount(target, fallback) {
    const result = await super.getAccount(target, fallback);
    window.__boundary.reads.push({ target, identifier: result?.identifier ?? null });
    return result;
  }
  async createAction(request) {
    if (!['near::sign_in', 'near::sign_message'].includes(request.id)) throw new Error('FORBIDDEN_WALLET_ACTION');
    const action = await super.createAction(request);
    // Keep real promptForExecution -> tryFunctionCallKey -> execute -> _execute.
    // Replace just ActionUi: no real wallet UI/extension/popup/signature permitted.
    action._promptForExecution = async () => {
      window.__boundary.prompts.push(request);
      return action.execute('v1_web');
    };
    return action;
  }
}
`;

test('Chrome App + actual SDK 3.24.1 associates empty registry, pins selection, separates consent, rejects cancellation/network', { timeout: 90_000 }, async t => {
  await mkdir(evidence, { recursive: true });
  // Optional immutable pre-fix sources reproduce the actual SDK empty-registry
  // blocker without resetting or editing the working tree. No production seam.
  const baseline = process.env.HALDIR_ASSOCIATION_BASELINE === '1';
  const baselineFiles = baseline ? new Map(await Promise.all(['src/integration/wallet-auth.ts', 'src/components/wallet-login-qualification.tsx'].map(async path => [root + path, await readFile(evidence + 'base-prototype__' + path.replaceAll('/', '__'), 'utf8')]))) : new Map();
  const output = await build({ root, configFile: root + 'vite.config.ts', logLevel: 'warn',
    define: { 'import.meta.env.VITE_HALDIR_APPROVED_ORIGIN': JSON.stringify(origin) },
    plugins: [{ name: 'test-only-closed-wallet-boundary', enforce: 'pre', resolveId: id => id === '@meteorwallet/sdk' ? virtual : null, load: id => id === virtual ? boundary : baselineFiles.get(id) ?? null }],
    build: { write: false } });
  assert.ok(!Array.isArray(output));
  const meteor = output.output.find(x => x.type === 'chunk' && Object.keys(x.modules).includes(realSdk));
  assert.ok(meteor && !meteor.isEntry, 'real installed SDK stays lazily loaded');
  const assets = new Map(output.output.map(x => ['/' + x.fileName, x.type === 'chunk' ? x.code : x.source]));
  for (const name of ['Manrope[wght].ttf', 'OFL.txt', 'METADATA.pb']) assets.set('/fonts/manrope/' + name, await readFile(root + 'public/fonts/manrope/' + name));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const receipts = [];
  for (const scenario of ['selection', 'cancel', 'wrong-network']) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const denied = [], api = [], errors = [], popups = [], dialogs = [];
      let authenticated = false, challenge;
      const principal = accountId => ({ sessionId: 'a'.repeat(64), accountId, publicKey, networkId: 'testnet', origin, recipient: 'approved-login.invalid', expiresAt: Date.now() + 900_000, authenticationOnly: true });
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin === origin && req.method() === 'GET' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: assets.get('/index.html') });
        if (url.origin === origin && req.method() === 'GET' && assets.has(decodeURI(url.pathname))) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.ttf') ? 'font/ttf' : 'image/png', body: assets.get(decodeURI(url.pathname)) });
        if (url.origin === origin && req.method() === 'POST' && /^\/api\/wallet-auth\/(session|challenge|verify|logout)$/.test(url.pathname)) {
          const body = req.postDataJSON(), path = url.pathname.split('/').at(-1);
          api.push({ path, body });
          assert.equal(req.headers()['x-haldir-csrf'], '1'); assert.equal(req.headers().authorization, undefined);
          let status = 200, data;
          if (path === 'challenge') {
            assert.equal(body.networkId, 'testnet');
            const c = { challengeId: 'a'.repeat(43), origin, networkId: 'testnet', accountId: body.accountId, issuedAt: Date.now(), expiresAt: Date.now() + 120_000 };
            challenge = { ...c, payload: { recipient: 'approved-login.invalid', nonce: Buffer.alloc(32, 1).toString('base64'), message: JSON.stringify({ type: 'haldir.wallet-login.v1', ...c, recipient: 'approved-login.invalid', notice: 'Session authentication only; does not authorize create/pay/stop/withdraw.' }) } };
            data = challenge;
          } else if (path === 'verify') { assert.equal(body.accountId, challenge.accountId); authenticated = true; data = { principal: principal(body.accountId) }; }
          else if (path === 'logout') { authenticated = false; data = { loggedOut: true }; }
          else { status = authenticated ? 200 : 401; data = authenticated ? { principal: principal(challenge.accountId) } : { error: 'UNAUTHENTICATED' }; }
          return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
        }
        denied.push(req.url()); return route.abort('blockedbyclient');
      });
      await context.routeWebSocket('**/*', socket => { denied.push(socket.url()); socket.close(); });
      context.on('page', p => { if (context.pages().length > 1) { popups.push(p.url()); void p.close(); } });
      await context.addInitScript(() => { window.__blockedOpens = 0; window.open = () => { window.__blockedOpens++; throw new Error('REAL_WALLET_OPEN_FORBIDDEN'); }; });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      page.on('dialog', d => { dialogs.push(d.type()); void d.dismiss(); });
      await page.goto(origin + '/?mode=wallet-auth-qualification');
      await page.getByText('Not logged in. No mandate is active.', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__boundary), undefined, 'no automatic SDK load');
      if (!baseline) assert.equal(await page.getByRole('link', { name: 'Return to separate scripted simulation' }).count(), 0);
      await page.getByRole('button', { name: 'Log in with connected testnet wallet' }).click();
      await page.getByRole('status').filter({ hasText: /Connect.*testnet account/ }).waitFor();
      let state = await page.evaluate(() => window.__boundary);
      assert.deepEqual(state.prompts, []); assert.equal(state.reads[0].identifier, null);
      assert.deepEqual(api.map(x => x.path), ['session']);
      assert.equal(await page.getByRole('button', { name: 'Connect testnet account', exact: true }).count(), 1, 'empty actual SDK registry needs a reachable association control BEFORE login signing');
      await page.evaluate(mode => { window.__boundary.mode = mode; }, scenario === 'selection' ? 'ok' : scenario);
      await page.getByRole('button', { name: 'Connect testnet account', exact: true }).click();
      if (scenario === 'selection') {
        await page.getByText(/Connected chosen.testnet · testnet/).waitFor();
        state = await page.evaluate(() => window.__boundary);
        assert.deepEqual(state.prompts, [{ id: 'near::sign_in', input: { target: { blockchain: 'near', network: 'testnet' } } }]);
        assert.equal(state.reads.at(-1).target.accountId, 'chosen.testnet');
        assert.deepEqual(api.map(x => x.path), ['session'], 'association does not request challenge/signature');
        // Reconnect another selected account; SDK registry retains old account FIRST.
        await page.evaluate(() => { window.__boundary.selection = 'second.testnet'; });
        await page.getByRole('button', { name: 'Connect testnet account', exact: true }).click();
        await page.getByText(/Connected second.testnet · testnet/).waitFor();
        const registry = await page.evaluate(() => JSON.parse(localStorage.getItem('met_data_accounts')));
        assert.deepEqual(registry.map(x => x.identifier.accountId), ['chosen.testnet', 'second.testnet']);
        state = await page.evaluate(() => window.__boundary);
        assert.equal(state.prompts.length, 2); assert.ok(state.prompts.every(x => x.id === 'near::sign_in'));
        assert.deepEqual(api.map(x => x.path), ['session']);
        await page.screenshot({ path: evidence + 'connected-desktop.png', fullPage: true });
        await page.getByRole('button', { name: 'Log in with connected testnet wallet' }).click();
        await page.getByText('Logged in as second.testnet · testnet · Authentication only', { exact: true }).waitFor();
        state = await page.evaluate(() => window.__boundary);
        assert.deepEqual(state.prompts.map(x => x.id), ['near::sign_in', 'near::sign_in', 'near::sign_message']);
        assert.equal(state.prompts[2].input.target.accountId, 'second.testnet');
        assert.deepEqual(api.map(x => x.path), ['session', 'challenge', 'verify', 'session']);
        assert.equal(api[1].body.accountId, 'second.testnet');
        assert.ok(state.reads.slice(-3).every(x => x.target.accountId === 'second.testnet'));
        await page.getByRole('button', { name: 'Log out of session' }).click();
        await page.getByText('Not logged in. No mandate is active.', { exact: true }).waitFor();
        assert.equal((await page.evaluate(() => window.__boundary)).prompts.length, 3);
        for (const width of [1440, 768, 390, 320]) {
          await page.setViewportSize({ width, height: width <= 390 ? 844 : 1000 });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          for (const button of await page.getByRole('button').all()) {
            const box = await button.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width);
            if (width <= 390) assert.ok(box.height >= 44);
          }
          await page.screenshot({ path: evidence + `connected-${width}.png`, fullPage: true });
        }
        await page.reload();
        await page.getByText('Not logged in. No mandate is active.', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.__boundary), undefined, 'reload reads session only; no automatic reconnect/sign');
      } else {
        await page.getByText(scenario === 'cancel' ? /Wallet request cancelled/ : /wallet did not return a valid NEAR testnet account/).waitFor();
        state = await page.evaluate(() => window.__boundary);
        assert.deepEqual(state.prompts.map(x => x.id), ['near::sign_in']);
        assert.deepEqual(api.map(x => x.path), ['session']);
        assert.equal(await page.getByText(/Connected .* · testnet/).count(), 0);
      }
      assert.equal(await page.evaluate(() => window.__blockedOpens), 0);
      assert.deepEqual(await context.cookies(), []);
      assert.deepEqual(denied, []); assert.deepEqual(errors, []); assert.deepEqual(popups, []); assert.deepEqual(dialogs, []);
      receipts.push({ scenario, state, api, denied, errors, popups, dialogs });
    } finally { await context.close(); }
  }
  const receipt = { browser: await browser.version(), sdkVersion: JSON.parse(await readFile(root + '../node_modules/@meteorwallet/sdk/package.json')).version,
    sdkSourceSha256: createHash('sha256').update(await readFile(realSdk)).digest('hex'), sdkChunk: meteor.fileName,
    artifactHashes: Object.fromEntries([...assets].map(([p, data]) => [p, createHash('sha256').update(data).digest('hex')])),
    evidence: 'REAL_CHROME_APP_REAL_SDK_SYNTHETIC_UI_AND_TRANSPORT_NOT_LIVE_WALLET_OR_COOKIE_AUTH', receipts };
  await writeFile(evidence + 'browser-receipt.json', JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ browser: receipt.browser, sdkVersion: receipt.sdkVersion, scenarios: receipts.map(x => x.scenario), evidence: receipt.evidence }));
});
