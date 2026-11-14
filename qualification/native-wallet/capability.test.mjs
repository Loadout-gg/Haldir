import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRestrictedKeys } from './capability.mjs';
import { JsonRpcProvider } from 'near-api-js';
import { after, mock } from 'node:test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
let networkAttempts = 0;
const deny = () => { networkAttempts++; throw new Error('OFFLINE_NETWORK_DENIED'); };
mock.method(globalThis, 'fetch', deny);
for (const [object, method] of [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
  [net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'], [tls, 'connect']])
  mock.method(object, method, deny);
after(() => { mock.restoreAll(); assert.equal(networkAttempts, 0, 'no external transport attempted'); });


// Public bytes only; no private key or signer exists in these fixtures.
const manifest = () => ({ network: 'testnet', agent: 'a.provisioner.testnet',
  mandate: 'job.factory.testnet', executionPublicKey: 'ed25519:11111111111111111111111111111111',
  bootstrapPublicKey: 'ed25519:4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  allowance: '1000000000000000000001' });
const readback = () => ({ block_hash: '11111111111111111111111111111111', block_height: 123,
  keys: [{ public_key: manifest().executionPublicKey, access_key: { nonce: 0,
    permission: { FunctionCall: { receiver_id: manifest().mandate, method_names: ['pay'],
      allowance: manifest().allowance } } } }] });

test('accepts exactly the expected pay-only key with approved finite initial allowance', () => {
  assert.deepEqual(verifyRestrictedKeys(readback(), manifest()), {
    block_hash: readback().block_hash, block_height: 123,
  });
});

const permissionCases = [
  ['missing key list', r => delete r.keys], ['empty key list', r => r.keys = []],
  ['retained bootstrap', r => r.keys.push({ ...r.keys[0], public_key: manifest().bootstrapPublicKey })],
  ['duplicate expected key', r => r.keys.push(structuredClone(r.keys[0]))],
  ['pagination cursor', r => r.last_key = 'more'],
  ['unexpected key', r => r.keys[0].public_key = manifest().bootstrapPublicKey],
  ['FullAccess', r => r.keys[0].access_key.permission = 'FullAccess'],
  ['GasKeyFullAccess', r => r.keys[0].access_key.permission = { GasKeyFullAccess: {} }],
  ['GasKeyFunctionCall', r => r.keys[0].access_key.permission = { GasKeyFunctionCall: {} }],
  ['mixed permission', r => r.keys[0].access_key.permission.FullAccess = {}],
  ['missing access key', r => delete r.keys[0].access_key],
  ['null FunctionCall', r => r.keys[0].access_key.permission.FunctionCall = null],
  ['wrong receiver', r => r.keys[0].access_key.permission.FunctionCall.receiver_id = 'other.testnet'],
  ['empty methods means all', r => r.keys[0].access_key.permission.FunctionCall.method_names = []],
  ['missing methods', r => delete r.keys[0].access_key.permission.FunctionCall.method_names],
  ['withdraw method', r => r.keys[0].access_key.permission.FunctionCall.method_names = ['pay', 'withdraw']],
  ['stop method', r => r.keys[0].access_key.permission.FunctionCall.method_names = ['stop']],
  ['duplicate pay', r => r.keys[0].access_key.permission.FunctionCall.method_names = ['pay', 'pay']],
  ['null allowance means unlimited', r => r.keys[0].access_key.permission.FunctionCall.allowance = null],
  ['missing allowance means unlimited', r => delete r.keys[0].access_key.permission.FunctionCall.allowance],
  ['zero allowance', r => r.keys[0].access_key.permission.FunctionCall.allowance = '0'],
  ['wrong allowance', r => r.keys[0].access_key.permission.FunctionCall.allowance = '1'],
  ['numeric allowance', r => r.keys[0].access_key.permission.FunctionCall.allowance = 1000],
  ['unknown FunctionCall fields', r => r.keys[0].access_key.permission.FunctionCall.extra = true],
  ['inherited FunctionCall', r => { const f = r.keys[0].access_key.permission.FunctionCall;
    r.keys[0].access_key.permission = Object.assign(Object.create({ FunctionCall: f }), { Unknown: {} }); }],
  ['empty pagination cursor', r => r.last_key = ''],
];
for (const [name, change] of permissionCases) test(`rejects unsafe key readback: ${name}`, () => {
  const r = readback(); change(r);
  assert.throws(() => verifyRestrictedKeys(r, manifest()));
});

for (const [name, delta] of [
  ['mainnet', { network: 'mainnet' }], ['missing network', { network: undefined }],
  ['invalid agent', { agent: 'bad..testnet' }], ['invalid mandate', { mandate: 'bad..testnet' }],
  ['agent mandate collision', { agent: 'job.factory.testnet' }],
  ['malformed execution key', { executionPublicKey: 'ed25519:1' }],
  ['unprefixed key', { executionPublicKey: '11111111111111111111111111111111' }],
  ['malformed bootstrap key', { bootstrapPublicKey: 'ed25519:1' }],
  ['same public keys', { bootstrapPublicKey: manifest().executionPublicKey }],
  ['zero allowance', { allowance: '0' }], ['noncanonical allowance', { allowance: '01' }],
  ['exponent allowance', { allowance: '1e3' }], ['numeric allowance', { allowance: 1000 }],
  ['overflow allowance', { allowance: '340282366920938463463374607431768211456' }],
]) test(`rejects invalid approved capability: ${name}`, () => {
  const m = { ...manifest(), ...delta }, r = readback();
  // Match raw readback too: validation must not rely only on mismatching the expected strings.
  r.keys[0].public_key = m.executionPublicKey;
  r.keys[0].access_key.permission.FunctionCall.receiver_id = m.mandate;
  r.keys[0].access_key.permission.FunctionCall.allowance = m.allowance;
  assert.throws(() => verifyRestrictedKeys(r, m));
});
for (const [name, change] of [
  ['missing hash', r => delete r.block_hash], ['invalid hash', r => r.block_hash = 'not-a-hash'],
  ['missing height', r => delete r.block_height], ['negative height', r => r.block_height = -1],
  ['unsafe height', r => r.block_height = Number.MAX_SAFE_INTEGER + 1],
]) test(`rejects incomplete evidence: ${name}`, () => {
  const r = readback(); change(r); assert.throws(() => verifyRestrictedKeys(r, manifest()));
});

test('installed near-api-js provider final complete-list read feeds the validator offline', async t => {
  const requests = [], m = manifest();
  let response = readback();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), 'https://haldir-offline.invalid/rpc');
    const body = JSON.parse(init.body);
    requests.push(body);
    assert.equal(init.method, 'POST');
    assert.equal(body.method, 'query');
    assert.deepEqual(body.params, { finality: 'final', request_type: 'view_access_key_list', account_id: m.agent });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: structuredClone(response) });
  });
  // Installed SDK counts total attempts, not additional retries: 1 executes exactly once.
  const provider = new JsonRpcProvider({ url: 'https://haldir-offline.invalid/rpc' }, { retries: 1 });
  const read = () => provider.viewAccessKeyList({ accountId: m.agent, finalityQuery: { finality: 'final' } });
  assert.deepEqual(verifyRestrictedKeys(await read(), m), { block_hash: response.block_hash, block_height: 123 });
  response.keys[0].access_key.permission = 'FullAccess';
  assert.throws(() => verifyRestrictedKeys(response, m));
  await assert.rejects(async () => verifyRestrictedKeys(await read(), m), /KEY_PERMISSION/);
  assert.equal(requests.length, 2);
});
