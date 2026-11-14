import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from '../../node_modules/esbuild/lib/main.js';
import { MeteorConnect } from '@meteorwallet/sdk';

const { code } = await transform(await readFile(new URL('../src/integration/wallet-auth.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { createWalletAuth } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const origin = 'https://approved-login.invalid', recipient = 'approved-login.invalid';
const target = { blockchain: 'near', network: 'testnet' };
const publicKey = 'ed25519:11111111111111111111111111111111';

for (const reject of [false, true]) test(`actual Meteor V1 synthetic extension transport: association ${reject ? 'rejection retains empty registry' : 'populates registry before separate login'}`, { timeout: 5000 }, async t => {
  assert.equal(JSON.parse(await readFile(new URL('../../node_modules/@meteorwallet/sdk/package.json', import.meta.url))).version, '3.24.1');
  let fetches = 0, popups = 0, keys = 0, prompts = 0, selection = 'chosen.testnet';
  const wire = [], actions = [], http = [], values = new Map();
  const storage = { getItem: async k => values.get(k) ?? null, setItem: async (k, v) => { values.set(k, v); }, removeItem: async k => { values.delete(k); }, getKeys: async () => [...values.keys()] };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window; });
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'debug', () => {});
  t.mock.method(globalThis, 'fetch', () => { fetches++; throw new Error('PUBLIC_TRANSPORT_FORBIDDEN'); });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get localStorage() { assert.fail('PERSISTENT_STORAGE_FORBIDDEN'); },
    open() { popups++; assert.fail('REAL_POPUP_FORBIDDEN'); }, meteorCom: {}, meteorComV2: {
      async sendMessageDataAndRespond(message) {
        if (['closed_success', 'closed_fail'].includes(message.status)) return;
        wire.push(structuredClone(message));
        if (reject) return { uid: message.uid, status: 'closed_fail', endTags: ['INCOMPLETE_ACTION'] };
        if (message.actionType === 'login') {
          assert.equal(message.inputs.public_key, undefined); assert.equal(message.inputs.contract_id, undefined);
          assert.equal(message.inputs.messageParams, undefined); assert.deepEqual(message.inputs.methods, []);
          return { uid: message.uid, status: 'closed_success', payload: { accountId: selection, allKeys: [] } };
        }
        assert.equal(message.actionType, 'sign_message');
        assert.equal(message.inputs.accountId, 'second.testnet');
        return { uid: message.uid, status: 'closed_success', payload: { accountId: selection, publicKey, signature: Buffer.alloc(64, 1).toString('base64') } };
      }
    }
  } });
  const sdk = new MeteorConnect(); sdk.setLoggingLevel('none');
  await sdk.initialize({ storage, mobileBridge: { enabled: false, autoOpenPairedWallet: false, transferAccounts: { enabled: false, persistStagedAccounts: false }, newKeyTransfer: { enabled: false } }, nearKeyStoreProvider: { getKeyStore: () => new Proxy({}, { get() { keys++; throw new Error('KEY_ACCESS_FORBIDDEN'); } }) } });
  assert.equal(await sdk.getAccount(target), undefined);
  const create = async request => {
    actions.push(request);
    const action = await sdk.createAction(request);
    // Synthetic UI delegates to the real execute/V1/postmessenger/parser path.
    action._promptForExecution = async () => { prompts++; return action.execute('v1_ext'); };
    return action;
  };
  let authenticated = false;
  const principal = () => ({ sessionId: 'a'.repeat(64), accountId: selection, networkId: 'testnet', publicKey, origin, recipient, expiresAt: Date.now() + 900_000, authenticationOnly: true });
  const transport = async (url, init) => {
    const route = new URL(url).pathname.split('/').at(-1), body = JSON.parse(init.body); http.push({ route, body });
    if (route === 'challenge') {
      const c = { challengeId: 'a'.repeat(43), origin, networkId: 'testnet', accountId: body.accountId, issuedAt: Date.now(), expiresAt: Date.now() + 120_000 };
      return Response.json({ ...c, payload: { message: JSON.stringify({ type: 'haldir.wallet-login.v1', ...c, recipient, notice: 'Session authentication only; does not authorize create/pay/stop/withdraw.' }), recipient, nonce: Buffer.alloc(32, 2).toString('base64') } });
    }
    if (route === 'verify') authenticated = true;
    assert.ok(['verify', 'session'].includes(route));
    return authenticated ? Response.json({ principal: principal() }) : Response.json({}, { status: 401 });
  };
  const client = createWalletAuth({ origin, recipient, approvedOrigin: origin, secureContext: true, transport, loadMeteor: async () => ({
    getAccount: target => sdk.getAccount(target), createAction: create,
    associateTestnet: async () => (await create({ id: 'near::sign_in', input: { target } })).promptForExecution(),
  }) });
  await client.resume(); assert.equal(prompts, 0);
  await client.login(); assert.equal(prompts, 0); assert.equal(client.getSnapshot().error, 'CONNECT_TESTNET_ACCOUNT_FIRST');
  await client.connect();
  assert.equal(prompts, 1); assert.deepEqual(http.map(x => x.route), ['session']);
  if (reject) {
    assert.equal(await sdk.getAccount(target), undefined);
    assert.equal(client.getSnapshot().connectedAccount, undefined);
    assert.equal(client.getSnapshot().principal, null);
    assert.ok(client.getSnapshot().error);
    assert.equal(wire.length, 1);
  } else {
    assert.equal((await sdk.getAccount(target)).identifier.accountId, 'chosen.testnet');
    assert.deepEqual(client.getSnapshot().connectedAccount, { ...target, accountId: selection });
    assert.equal(client.getSnapshot().principal, null);
    selection = 'second.testnet'; await client.connect();
    assert.deepEqual((await sdk.getAllAccounts(target)).map(x => x.identifier.accountId), ['chosen.testnet', 'second.testnet']);
    assert.equal(prompts, 2); assert.deepEqual(http.map(x => x.route), ['session']);
    await client.login();
    assert.equal(client.getSnapshot().principal?.accountId, 'second.testnet');
    assert.equal(prompts, 3);
    assert.deepEqual(actions.map(x => x.id), ['near::sign_in', 'near::sign_in', 'near::sign_message']);
    assert.deepEqual(http.map(x => x.route), ['session', 'challenge', 'verify', 'session']);
    assert.deepEqual(http[1].body, { accountId: 'second.testnet', networkId: 'testnet' });
    assert.equal(wire.at(-1).inputs.accountId, 'second.testnet');
    assert.ok(wire.filter(x => x.actionType === 'login').every(x => x.network === 'testnet'));
  }
  assert.deepEqual({ fetches, popups, keys }, { fetches: 0, popups: 0, keys: 0 });
});
