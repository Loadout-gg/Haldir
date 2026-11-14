import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MeteorConnect } from '@meteorwallet/sdk';
import { decodeTransaction } from '@near-js/transactions';
import { createNativeOwnerWallet } from '../src/integration/native-owner-wallet.ts';

for (const kind of ['create', 'stop', 'withdraw']) test(`Meteor 3.24.1 real V1 serialization/parser: explicit owner ${kind}, no signer or key shortcut`, { timeout: 10000 }, async t => {
  assert.equal(JSON.parse(await readFile(new URL('../../node_modules/@meteorwallet/sdk/package.json', import.meta.url))).version, '3.24.1');
  let prompts = 0, keys = 0, popups = 0, forbidden = 0, blocks = 0;
  const messages = [], values = new Map();
  const storage = { getItem: async k => values.get(k) ?? null, setItem: async (k, v) => { values.set(k, v); }, removeItem: async k => { values.delete(k); }, getKeys: async () => [...values.keys()] };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else delete globalThis.window; });
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'debug', () => {});
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(String(url), 'https://test.rpc.fastnear.com');
    if (body.method !== 'block') { forbidden++; throw new Error('UNEXPECTED_RPC'); }
    assert.deepEqual(body.params, { finality: 'optimistic' }); blocks++;
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { header: { hash: '1'.repeat(32), height: 100 } } });
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    open() { popups++; throw new Error('REAL_WALLET_FORBIDDEN'); }, meteorCom: {}, meteorComV2: {
      async sendMessageDataAndRespond(message) {
        if (['closed_success', 'closed_fail'].includes(message.status)) return;
        messages.push(structuredClone(message));
        if (message.actionType === 'login') return { uid: message.uid, status: 'closed_success', payload: { accountId: 'owner.testnet', allKeys: [] } };
        assert.equal(message.actionType, 'sign'); assert.equal(message.network, 'testnet');
        const bytes = Buffer.from(message.inputs.transactions, 'base64');
        const tx = decodeTransaction(bytes);
        assert.equal(tx.signerId, 'owner.testnet'); assert.equal(tx.actions.length, 1);
        const fc = tx.actions[0].functionCall;
        assert.equal(fc.methodName, kind === 'create' ? 'create_job' : kind);
        assert.equal(fc.gas, kind === 'create' ? 250000000000000n : 30000000000000n);
        assert.equal(fc.deposit, kind === 'create' ? 6000000000000000000000000n : 0n);
        if (kind !== 'create') assert.equal(Buffer.from(fc.args).toString(), '{}');
        return { uid: message.uid, status: 'closed_success', payload: { executionOutcomes: [{ transaction: { hash: '1'.repeat(32), signer_id: tx.signerId, receiver_id: tx.receiverId }, status: { SuccessValue: '' } }] } };
      }
    }
  } });
  const sdk = new MeteorConnect(); sdk.setLoggingLevel('none');
  await sdk.initialize({ storage, mobileBridge: { enabled: false, autoOpenPairedWallet: false, transferAccounts: { enabled: false, persistStagedAccounts: false }, newKeyTransfer: { enabled: false } }, nearKeyStoreProvider: { getKeyStore: () => new Proxy({}, { get() { keys++; throw new Error('KEY_ACCESS_FORBIDDEN'); } }) } });
  await (await sdk.createAction({ id: 'near::sign_in', input: { target: { blockchain: 'near', network: 'testnet' } } })).execute('v1_ext');
  let manifest = { network: 'testnet', owner: 'owner.testnet', mandate: 'mandate.testnet', kind, gas: '30000000000000' };
  let call = { network: 'testnet', signerId: manifest.owner, receiverId: manifest.mandate, methodName: kind, args: {}, gas: manifest.gas, deposit: '0' };
  if (kind === 'create') {
    const { createHash } = await import('node:crypto');
    manifest = { ...manifest, factory: 'factory.testnet', job_label: 'job-1', agent: 'agent.testnet', allowlist: ['vendor.testnet'], cap: '1000000000000000000000000', operating_float: '5000000000000000000000000', deadline_ns: '1800000000000000000', gas: '250000000000000' };
    manifest.mandate = 'j' + createHash('sha256').update('owner.testnet:job-1').digest('hex').slice(0, 32) + '.factory.testnet';
    call = { ...call, receiverId: manifest.factory, methodName: 'create_job', args: Object.fromEntries(['job_label', 'agent', 'allowlist', 'cap', 'deadline_ns', 'operating_float'].map(k => [k, manifest[k]])), gas: manifest.gas, deposit: '6000000000000000000000000' };
  }
  const wallet = createNativeOwnerWallet({ principal: () => ({ accountId: 'owner.testnet', networkId: 'testnet', sessionId: 'a'.repeat(64), expiresAt: Date.now() + 60000 }), loadMeteor: async () => ({ getAccount: target => sdk.getAccount(target), createAction: async request => {
    assert.equal(request.input.useFunctionCallKey, false);
    const action = await sdk.createAction(request);
    action._promptForExecution = async () => { prompts++; return action.execute('v1_ext'); };
    return action;
  } }) });
  const result = await wallet.approve(manifest, call);
  assert.deepEqual(result, { status: 'submitted', transactionHash: '1'.repeat(32) });
  assert.equal(prompts, 1); assert.equal(blocks, 1); assert.equal(messages.filter(m => m.actionType === 'sign').length, 1);
  assert.deepEqual({ keys, popups, forbidden }, { keys: 0, popups: 0, forbidden: 0 });
});
