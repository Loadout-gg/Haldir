import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from '../node_modules/vite/dist/node/index.js';
import { chromium } from '../node_modules/@playwright/test/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Test-only intercepted origin. Never a deployment default; no DNS/TLS/public IO.
const origin = 'https://approved-login.invalid';

test('actual configured App loads real installed Meteor Vite chunk only on click; no account, prompts, cookies or public network', { timeout: 60_000 }, async t => {
  const previousApproval = process.env.VITE_HALDIR_APPROVED_ORIGIN;
  process.env.VITE_HALDIR_APPROVED_ORIGIN = origin;
  let output;
  try {
    output = await build({ root, configFile: root + 'vite.config.ts', logLevel: 'warn', build: { write: false } });
  } finally {
    if (previousApproval === undefined) delete process.env.VITE_HALDIR_APPROVED_ORIGIN;
    else process.env.VITE_HALDIR_APPROVED_ORIGIN = previousApproval;
  }
  assert.ok(!Array.isArray(output));
  const meteor = output.output.find(x => x.type === 'chunk' && Object.keys(x.modules).some(id => id.endsWith('/@meteorwallet/sdk/dist/index.js')));
  assert.ok(meteor && !meteor.isEntry, 'actual installed SDK remains a dynamic chunk');
  const assets = new Map(output.output.map(x => ['/' + x.fileName, x.type === 'chunk' ? x.code : x.source]));
  for (const name of ['Manrope[wght].ttf', 'OFL.txt', 'METADATA.pb']) assets.set('/fonts/manrope/' + name, await readFile(root + 'public/fonts/manrope/' + name));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const denied = [], requests = [], errors = [], popups = [], dialogs = [];
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    requests.push({ path: url.pathname, method: req.method(), body: req.postData(), headers: req.headers() });
    if (url.origin === origin && req.method() === 'GET' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: assets.get('/index.html') });
    if (url.origin === origin && req.method() === 'GET' && assets.has(decodeURI(url.pathname))) {
      const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.ttf') ? 'font/ttf' : 'image/png';
      return route.fulfill({ contentType: type, body: assets.get(decodeURI(url.pathname)) });
    }
    if (url.origin === origin && req.method() === 'POST' && ['/api/wallet-auth/session', '/api/wallet-auth/logout'].includes(url.pathname)) {
      assert.equal(req.postData(), '{}');
      assert.equal(req.headers()['x-haldir-csrf'], '1');
      assert.equal(req.headers()['content-type'], 'application/json');
      assert.equal(req.headers().authorization, undefined);
      return route.fulfill({ status: url.pathname.endsWith('logout') ? 200 : 401, contentType: 'application/json', body: JSON.stringify(url.pathname.endsWith('logout') ? { loggedOut: true } : { error: 'UNAUTHENTICATED' }) });
    }
    denied.push(req.url()); return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', socket => { denied.push(socket.url()); socket.close(); });
  context.on('page', page => { if (context.pages().length > 1) { popups.push(page.url()); void page.close(); } });
  await context.addInitScript(() => { window.__blockedWalletOpens = 0; window.open = () => { window.__blockedWalletOpens++; throw new Error('WALLET_OPEN_FORBIDDEN'); }; });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { dialogs.push(d.type()); void d.dismiss(); });
  await page.goto(origin + '/?mode=wallet-auth-qualification');
  await page.getByText('Not logged in. No mandate is active.', { exact: true }).waitFor();
  assert.equal(requests.some(r => r.path === '/' + meteor.fileName), false);
  await page.getByRole('button', { name: 'Log in with connected testnet wallet' }).click();
  await page.getByText(/Click Connect testnet account to associate an account with this site/).waitFor();
  assert.equal(requests.filter(r => r.path === '/' + meteor.fileName).length, 1);
  assert.equal(requests.filter(r => r.path.startsWith('/api/')).length, 1, 'no challenge without a connected account');
  await page.getByRole('button', { name: 'Log out of session' }).click();
  await page.getByText('Not logged in. No mandate is active.', { exact: true }).waitFor();
  const beforeReload = requests.length;
  await page.reload();
  await page.getByText('Not logged in. No mandate is active.', { exact: true }).waitFor();
  assert.equal(requests.slice(beforeReload).some(r => r.path === '/' + meteor.fileName), false);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no page overflow at ${width}`);
  }
  assert.equal(await page.evaluate(() => window.__blockedWalletOpens), 0);
  assert.equal(await page.evaluate(() => typeof global), 'undefined');
  assert.deepEqual(await context.cookies(), []);
  assert.deepEqual(denied, []); assert.deepEqual(errors, []); assert.deepEqual(popups, []); assert.deepEqual(dialogs, []);
  console.log(JSON.stringify({ browser: await browser.version(), sdkVersion: JSON.parse(await readFile(root + '../node_modules/@meteorwallet/sdk/package.json')).version, sdkChunk: meteor.fileName,
    apiRequests: requests.filter(r => r.path.startsWith('/api/')).map(r => r.path), denied, errors, popups, dialogs,
    evidence: 'INTERCEPTED_FIXTURE_ORIGIN_REAL_APP_REAL_SDK_NO_ACCOUNT_NOT_PUBLIC_LOGIN' }));
});
