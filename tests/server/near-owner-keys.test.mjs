import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import { createNearOwnerKeyReader } from '../../src/server/near-owner-keys.mjs';

globalThis.fetch = () => { throw new Error('owner-key qualification forbids external fetch'); };
const rpcUrl = 'https://rpc.testnet.near.org';
const blockHash = '11111111111111111111111111111111';
const observedAt = 1_799_999_999_000;
const publicKey = KeyPair.fromRandom('ed25519').getPublicKey().toString();
const subject = { networkId: 'testnet', accountId: 'alice.testnet', publicKey };
function fixture(handler, options = {}) {
  const requests = [];
  const transport = async (url, init) => {
    assert.equal(url, rpcUrl, 'transport cannot fall through to an external endpoint');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const request = JSON.parse(init.body);
    requests.push(request);
    const result = handler ? await handler(request, init, requests) : undefined;
    if (result instanceof Response) return result;
    return Response.json({ jsonrpc: '2.0', id: request.id, result: result === undefined ?
      request.method === 'status' ? { chain_id: 'testnet', sync_info: { syncing: false } } :
        { permission: 'FullAccess', nonce: 1, block_height: 123, block_hash: blockHash } : result });
  };
  return { requests, read: createNearOwnerKeyReader({ rpcUrl, transport, now: () => observedAt, ...options }) };
}

test('installed SDK status and FINAL access-key query produce the exact wallet-session evidence port', async () => {
  const f = fixture();
  assert.deepEqual(await f.read(subject), { ...subject, permission: 'FullAccess', finality: 'final',
    blockHeight: 123, blockHash, observedAt });
  assert.deepEqual(f.requests.map(r => [r.method, r.params]), [
    ['status', []], ['query', { finality: 'final', request_type: 'view_access_key',
      account_id: subject.accountId, public_key: publicKey }],
  ]);
  await f.read({ ...subject, accountId: 'named.near' });
  assert.equal(f.requests.length, 4, 'each read checks actual chain_id; account suffix is not chain evidence');
});

const rejectsCode = (p, code) => assert.rejects(p, e => e.code === code && e.message === code);
for (const chain_id of ['mainnet', 'test-chain-sandbox', undefined]) test(`refuses actual chain_id ${chain_id} before querying membership`, async () => {
  const f = fixture(r => r.method === 'status' ? { chain_id, sync_info: { syncing: false } } : undefined);
  await rejectsCode(f.read(subject), 'OWNER_KEY_UNAVAILABLE');
  assert.equal(f.requests.length, 1);
});
test('rejects syncing, non-FullAccess, malformed block evidence and missing keys with redacted errors', async () => {
  for (const result of [
    { permission: { FunctionCall: { receiver_id: 'x.testnet', method_names: ['login'] } } },
    { permission: null }, { block_height: 0 }, { block_height: 1.5 },
    { block_hash: '1'.repeat(33) }, { block_hash: '' },
  ]) {
    const f = fixture(r => r.method === 'query' ? { permission: 'FullAccess', nonce: 1,
      block_height: 123, block_hash: blockHash, ...result } : undefined);
    await rejectsCode(f.read(subject), 'OWNER_KEY_UNAVAILABLE');
  }
  const syncing = fixture(r => r.method === 'status' ? { chain_id: 'testnet', sync_info: { syncing: true } } : undefined);
  await rejectsCode(syncing.read(subject), 'OWNER_KEY_UNAVAILABLE');
  assert.equal(syncing.requests.length, 1);
  for (const make of [
    r => Response.json({ jsonrpc: '2.0', id: r.id, error: { message: 'PRIVATE_SENTINEL', data: { name: 'UNKNOWN_ACCESS_KEY' } } }),
    () => Response.json({ jsonrpc: '2.0', id: 'wrong', result: {} }),
    r => Response.json({ jsonrpc: '2.0', id: r.id, result: {} }, { status: 503 }),
    () => { throw new Error('PRIVATE_SENTINEL'); },
    () => new Response('x'.repeat(65_537)),
  ]) await rejectsCode(fixture(make).read(subject), 'OWNER_KEY_UNAVAILABLE');
});
test('configuration and exact subject validation fail before any transport or normalization', async () => {
  for (const rpcUrl of ['http://rpc.testnet.near.org', 'https://rpc.testnet.near.org.evil.test',
    'https://rpc.mainnet.near.org', 'https://user:pass@rpc.testnet.near.org',
    'https://rpc.testnet.near.org?key=secret', 'https://rpc.testnet.near.org#x',
    'https://rpc.testnet.near.org/', 'https://RPC.testnet.near.org']) {
    assert.throws(() => createNearOwnerKeyReader({ rpcUrl }), e => e.code === 'OWNER_KEY_CONFIG_INVALID');
  }
  for (const timeoutMs of [0, 60_001, 1.5]) assert.throws(() => createNearOwnerKeyReader({ rpcUrl, timeoutMs }), e => e.code === 'OWNER_KEY_CONFIG_INVALID');
  const f = fixture();
  for (const change of [{ networkId: 'mainnet' }, { accountId: 'a..testnet' },
    { publicKey: 'ed25519:' + '1'.repeat(33) }, { ownerKeys: [publicKey] }, { origin: 'https://evil.test' }]) {
    await rejectsCode(f.read({ ...subject, ...change }), 'OWNER_KEY_SUBJECT_INVALID');
  }
  assert.equal(f.requests.length, 0);
});
test('one total deadline includes status, access-key response/body and ignores late transport completion', async () => {
  for (const stage of ['status', 'query', 'body']) {
    let release, signal;
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture(async (r, init) => {
      signal = init.signal;
      if (r.method === stage) await gate;
      if (stage === 'body' && r.method === 'query') return new Response(new ReadableStream({ start(controller) {
        gate.then(() => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); });
      } }));
    }, { timeoutMs: 20 });
    const start = performance.now();
    await rejectsCode(f.read(subject), 'OWNER_KEY_UNAVAILABLE');
    assert.ok(performance.now() - start < 500);
    assert.equal(signal.aborted, true);
    const count = f.requests.length;
    release(); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.requests.length, count, 'no query may begin after a timed-out status');
  }
});

test('a single monotonic budget includes both RPC stages and the final evidence clock fence', async t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const combined = fixture(r => { elapsed += r.method === 'status' ? 70 : 31; }, { timeoutMs: 100 });
  await rejectsCode(combined.read(subject), 'OWNER_KEY_UNAVAILABLE');
  assert.equal(combined.requests.length, 2);
  elapsed = 0;
  const finalFence = fixture(undefined, { timeoutMs: 100, now: () => { elapsed = 100; return observedAt; } });
  await rejectsCode(finalFence.read(subject), 'OWNER_KEY_UNAVAILABLE');
});

test('subject is snapshotted before asynchronous status and there is no cache or write RPC surface', async () => {
  const input = { ...subject };
  const f = fixture(r => { if (r.method === 'status') { input.accountId = 'attacker.testnet'; input.publicKey = 'bad'; } });
  const evidence = await f.read(input);
  assert.equal(evidence.accountId, subject.accountId);
  assert.equal(f.requests[1].params.account_id, subject.accountId);
  assert.equal(f.requests[1].params.public_key, subject.publicKey);
  assert.deepEqual(Object.keys(f.read), []);
});


