import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { actions } from 'near-api-js';
import { prepareCreateJob, validateCreateJobRequest } from './request.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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


// All account IDs and quantities here are synthetic, never approved deployment defaults.
const fixture = (owner = 'owner.testnet') => {
  const factory = 'factory.testnet', job_label = 'j1';
  return { network: 'testnet', owner, factory, job_label,
    mandate: 'j' + createHash('sha256').update(`${owner}:${job_label}`).digest('hex').slice(0, 32) + '.' + factory,
    agent: 'a.provisioner.testnet', allowlist: ['vendor.testnet'],
    cap: '10000000000000000000000001', operating_float: '5000000000000000000000001',
    deadline_ns: '1800000000000000001', create_gas: '200000000000000' };
};

test('factory request preserves named and implicit owners, exact factory ABI and integer funding', () => {
  for (const owner of ['owner.testnet', 'a'.repeat(64)]) {
    const m = fixture(owner), r = prepareCreateJob(m);
    assert.equal(r.id, 'near::sign_transactions');
    assert.deepEqual(r.input.target, { blockchain: 'near', network: 'testnet', accountId: owner });
    assert.equal(r.input.useFunctionCallKey, false);
    assert.equal(r.input.transactions.length, 1);
    const tx = r.input.transactions[0];
    assert.equal(tx.receiverId, m.factory);
    assert.equal(tx.actions.length, 1);
    const a = tx.actions[0].functionCall;
    assert.equal(a.methodName, 'create_job');
    assert.equal(a.gas, 200000000000000n);
    assert.equal(a.deposit, 15000000000000000000000002n);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(a.args)), {
      job_label: m.job_label, agent: m.agent, allowlist: m.allowlist,
      cap: m.cap, deadline_ns: m.deadline_ns, operating_float: m.operating_float,
    });
    assert.ok(m.mandate.length <= 64);
  }
});

const bindingCases = [
  ['mainnet', { network: 'mainnet' }], ['missing network', { network: undefined }],
  ['mainnet owner', { owner: 'derekblueeyes.near' }], ['uppercase implicit owner', { owner: 'A'.repeat(64) }],
  ['short implicit owner', { owner: 'a'.repeat(63) }], ['missing owner', { owner: undefined }],
  ['bad owner separator', { owner: 'a..b.testnet' }], ['wrong mandate', { mandate: 'other.testnet' }],
  ['mainnet factory', { factory: 'factory.near' }], ['overlong factory', { factory: 'f'.repeat(23) + '.testnet' }],
  ['invalid factory', { factory: '-factory.testnet' }], ['missing agent', { agent: undefined }],
  ['owner agent collision', { agent: 'owner.testnet' }], ['agent mandate collision', m => ({ agent: m.mandate })],
  ['empty job label', { job_label: '' }], ['dotted job label', { job_label: 'bad.id' }],
  ['uppercase job label', { job_label: 'JOB' }], ['overlong job label', { job_label: 'j'.repeat(33) }],
  ['non-string job label', { job_label: 1 }], ['empty allowlist', { allowlist: [] }],
  ['non-array allowlist', { allowlist: 'vendor.testnet' }],
  ['duplicate recipient', { allowlist: ['vendor.testnet', 'vendor.testnet'] }],
  ['five recipients', { allowlist: ['a.testnet', 'b.testnet', 'c.testnet', 'd.testnet', 'e.testnet'] }],
  ['owner recipient', { allowlist: ['owner.testnet'] }],
  ['agent recipient', { allowlist: ['a.provisioner.testnet'] }],
  ['mandate recipient', m => ({ allowlist: [m.mandate] })],
  ['malformed recipient', { allowlist: ['bad..testnet'] }],
  ['sparse recipient array', { allowlist: new Array(1) }],
  ['owner trailing newline', { owner: 'owner.testnet\n' }],
  ['job trailing newline', { job_label: 'j1\n' }],
];
for (const [name, delta] of bindingCases) test(`rejects invalid approved binding: ${name}`, () => {
  const m = fixture();
  assert.throws(() => prepareCreateJob({ ...m, ...(typeof delta === 'function' ? delta(m) : delta) }));
});

for (const field of ['cap', 'operating_float', 'deadline_ns', 'create_gas']) {
  for (const [name, value] of [
    ['number', 1], ['unsafe number', Number.MAX_SAFE_INTEGER + 1], ['bigint', 1n],
    ['null', null], ['undefined', undefined], ['empty', ''], ['zero', '0'],
    ['leading zero', '01'], ['negative', '-1'], ['plus', '+1'], ['fraction', '1.0'],
    ['exponent', '1e3'], ['hex', '0x10'], ['space', ' 1'], ['newline', '1\n'],
    ['overflow', field === 'deadline_ns' || field === 'create_gas'
      ? '18446744073709551616' : '340282366920938463463374607431768211456'],
    ['huge input', '1'.repeat(10000)],
  ]) test(`rejects invalid integer ${field}: ${name}`, () => {
    assert.throws(() => prepareCreateJob({ ...fixture(), [field]: value }));
  });
}
for (const [name, delta] of [
  ['cap above 100 NEAR', { cap: '100000000000000000000000001' }],
  ['gas below 200 Tgas', { create_gas: '199999999999999' }],
  ['gas above 300 Tgas', { create_gas: '300000000000001' }],
  ['sum over u128', { operating_float: '340282366920938463463374607431768211455' }],
]) test(`rejects funding limit: ${name}`, () => assert.throws(() => prepareCreateJob({ ...fixture(), ...delta })));

test('accepts integer boundary budgets without rounding', () => {
  const r = prepareCreateJob({ ...fixture(), cap: '100000000000000000000000000',
    operating_float: '1', create_gas: '300000000000000', deadline_ns: '18446744073709551615' });
  assert.equal(r.input.transactions[0].actions[0].functionCall.deposit, 100000000000000000000000001n);
});

test('validates against separately supplied approval without mutating the approved manifest', () => {
  const approved = fixture(); Object.freeze(approved.allowlist); Object.freeze(approved);
  const before = structuredClone(approved), r = prepareCreateJob(approved);
  assert.equal(validateCreateJobRequest(r, approved), true);
  assert.deepEqual(approved, before);
  assert.throws(() => JSON.stringify(r), /BigInt/); // Deliberately not a JSON transport.
});
const requestMutations = [
  ['wrong action ID', r => r.id = 'near::sign_delegate_actions'],
  ['mainnet', r => r.input.target.network = 'mainnet'],
  ['wrong blockchain', r => r.input.target.blockchain = 'ethereum'],
  ['wrong owner', r => r.input.target.accountId = 'other.testnet'],
  ['automatic function-call key', r => r.input.useFunctionCallKey = true],
  ['missing key mode', r => delete r.input.useFunctionCallKey],
  ['wrong factory receiver', r => r.input.transactions[0].receiverId = 'other.testnet'],
  ['extra transaction', r => r.input.transactions.push(r.input.transactions[0])],
  ['extra transfer', r => r.input.transactions[0].actions.push(actions.transfer(1n))],
  ['AddKey', r => r.input.transactions[0].actions = [actions.addFullAccessKey('ed25519:11111111111111111111111111111111')]],
  ['wrong method', r => r.input.transactions[0].actions[0].functionCall.methodName = 'claim_creation_refund'],
  ['wrong deposit', r => r.input.transactions[0].actions[0].functionCall.deposit += 1n],
  ['numeric gas', r => r.input.transactions[0].actions[0].functionCall.gas = 200000000000000],
  ['unknown field', r => r.input.transactions[0].evil = true],
  ['malformed JSON', r => r.input.transactions[0].actions[0].functionCall.args = new TextEncoder().encode('{')],
];
for (const field of ['job_label', 'agent', 'allowlist', 'cap', 'deadline_ns', 'operating_float', 'owner'])
  requestMutations.push([`tampered ABI ${field}`, r => {
    const a = r.input.transactions[0].actions[0].functionCall;
    const args = JSON.parse(new TextDecoder().decode(a.args));
    args[field] = field === 'allowlist' ? ['other.testnet'] : 'other';
    a.args = new TextEncoder().encode(JSON.stringify(args));
  }]);
for (const [name, change] of requestMutations) test(`rejects unapproved request: ${name}`, () => {
  const approved = fixture(), r = prepareCreateJob(approved); change(r);
  assert.throws(() => validateCreateJobRequest(r, approved));
});
test('rejects coherent malicious manifest/request against independent approval', () => {
  const approved = fixture(), malicious = { ...approved, agent: 'other.testnet', cap: '1' };
  assert.throws(() => validateCreateJobRequest(prepareCreateJob(malicious), approved));
});

// Characterization of the actual installed SDK, NOT a wallet prompt, signature or chain receipt.
test('installed Meteor 3.24.1 V1/mobile factory adapters and Borsh preserve named and implicit requests', async () => {
  const require = createRequire(import.meta.url);
  const meteor = await import('@meteorwallet/sdk');
  assert.equal(require('@meteorwallet/sdk/package.json').version, '3.24.1');
  assert.equal(JSON.parse(readFileSync(new URL('../../node_modules/near-api-js/package.json', import.meta.url))).version, '7.4.0');
  const source = readFileSync(new URL('../../node_modules/@meteorwallet/sdk/dist/index.js', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'),
    '1185f9848122da17f69522ebb56683d057e9f217e7c8a3e584941329c5c31780');
  const marker = '//#region src/MeteorConnect/target_clients/v1_client/utils/nearActionToSdkV1Action.ts\n';
  assert.equal(source.split(marker).length, 2);
  // Only fixed, hash-pinned installed package source, never user or remote text.
  const v1 = new Function(source.split(marker)[1].split('//#endregion')[0] + '\nreturn nearActionToSdkV1Action;')();
  const mobileText = source.slice(source.indexOf('function nearActionToConnectorAction(action)'),
    source.indexOf('function normalizeFunctionCallKey(input)'));
  const mobile = new Function('decodeJsonOrBase64', 'base64', mobileText + '\nreturn nearActionToConnectorAction;')(
    bytes => JSON.parse(new TextDecoder().decode(bytes)), { encode: b => Buffer.from(b).toString('base64') });
  const sdkRequire = createRequire(require.resolve('@meteorwallet/sdk'));
  const { deserialize } = sdkRequire('borsh');
  const { SCHEMA } = sdkRequire('@near-js/transactions');
  const { PublicKey } = await import('near-api-js');
  let blockReads = 0;
  const context = { _fakePublicKey: PublicKey.fromString('ed25519:11111111111111111111111111111111'),
    _provider: { viewBlock: async () => { blockReads++; return { header: {
      hash: '11111111111111111111111111111111', height: 123 } }; } } };
  for (const owner of ['owner.testnet', 'a'.repeat(64)]) {
    const m = fixture(owner), r = prepareCreateJob(m), tx = r.input.transactions[0], a = tx.actions[0];
    const selector = v1(a);
    assert.deepEqual(mobile(a), selector);
    assert.deepEqual(selector, { type: 'FunctionCall', params: {
      methodName: 'create_job', args: { job_label: m.job_label, agent: m.agent, allowlist: m.allowlist,
        cap: m.cap, deadline_ns: m.deadline_ns, operating_float: m.operating_float },
      gas: m.create_gas, deposit: '15000000000000000000000002' } });
    const [sdkTx] = await meteor.MeteorWallet.prototype.transformTransactions.call(context, {
      transactions: [{ receiverId: tx.receiverId, actions: [selector] }],
      meteorConnectAccount: { identifier: r.input.target },
    });
    const decoded = deserialize(SCHEMA.Transaction, sdkTx.encode());
    assert.equal(decoded.signerId, owner); assert.equal(decoded.receiverId, m.factory);
    assert.equal(decoded.actions.length, 1);
    assert.equal(decoded.actions[0].functionCall.deposit, a.functionCall.deposit);
    assert.equal(decoded.actions[0].functionCall.gas, a.functionCall.gas);
    assert.equal(decoded.actions[0].functionCall.methodName, 'create_job');
    assert.deepEqual([...decoded.actions[0].functionCall.args], [...a.functionCall.args]);
  }
  assert.equal(blockReads, 2);
});
