import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as client from './client.mjs';

import { actions, encodeSignedDelegate, KeyPair, KeyPairSigner } from 'near-api-js';

async function signingFixture() {
  const boot = fixture();
  const pair = KeyPair.fromRandom('ed25519');
  boot.expectedOwner.public_key = boot.generated.signer.public_key = pair.getPublicKey().toString();
  const delegate = { ...client.toDelegateAction(boot.generated), senderId: 'synthetic.near', publicKey: pair.getPublicKey(), nonce: 1n, maxBlockHeight: 42n };
  return { boot, output: { signedDelegatesWithHashes: [await new KeyPairSigner(pair).signDelegateAction(delegate)] } };
}

test('explicit connect is account-only and signing posts exact signed_data to local signature route', async () => {
  assert.equal(typeof client.createController, 'function', 'signing controller is implemented');
  const { boot, output } = await signingFixture();
  const requests = [], posts = [];
  const wallet = { async createAction(request) {
    requests.push(request);
    return { async promptForExecution() { return request.id === 'near::sign_in' ? account : output; } };
  } };
  const controller = client.createController(boot, { wallet: async () => wallet, clock: () => now, fetcher: async (...args) => { posts.push(args); return { ok: true }; } });
  assert.equal(requests.length, 0);
  assert.equal(await controller.sign(), false);
  assert.equal(await controller.connect(), true);
  assert.deepEqual(requests[0], { id: 'near::sign_in', input: { target: { blockchain: 'near', network: 'mainnet' } } });
  assert.equal(posts.length, 0);
  assert.equal(await controller.sign(), true);
  assert.equal(requests[1].id, 'near::sign_delegate_actions');
  assert.deepEqual(requests[1].input.target, account.identifier);
  assert.deepEqual(requests[1].input.delegateActions, [client.toDelegateAction(boot.generated)]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], '/api/signature');
  const options = posts[0][1];
  assert.equal(options.method, 'POST');
  assert.deepEqual(options.headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken });
  assert.deepEqual(JSON.parse(options.body), { signed_data: client.signedData(boot, output) });
  assert.equal(controller.snapshot().notice, 'Signature saved locally. Submission not enabled.');
  assert.equal(await controller.sign(), false);
  assert.equal(posts.length, 1);
});

test('expired and mismatched owners never create a delegate signing request', async () => {
  assert.equal(typeof client.createController, 'function', 'signing controller is implemented');
  for (const expired of [true, false]) {
    const boot = fixture();
    const requests = [];
    const wallet = { async createAction(request) { requests.push(request); return { async promptForExecution() { return { identifier: { ...account.identifier, accountId: expired ? 'synthetic.near' : 'other.near' } }; } }; } };
    const controller = client.createController(boot, { wallet: async () => wallet, clock: () => expired ? now + 60000 : now, fetcher: () => { assert.fail('no save expected'); } });
    await controller.connect();
    assert.equal(await controller.sign(), false);
    assert.equal(requests.length, 1);
    assert.match(controller.snapshot().block, expired ? /expired/i : /connect/i);
  }
});

test('expiry during wallet approval prevents save; cancellation and errors never expose raw details', async () => {
  assert.equal(typeof client.createController, 'function', 'signing controller is implemented');
  const { boot, output } = await signingFixture();
  let time = now;
  const wallet = { async createAction(request) { return { async promptForExecution() {
    if (request.id === 'near::sign_in') return account;
    time += 60000;
    return output;
  } }; } };
  const controller = client.createController(boot, { wallet: async () => wallet, clock: () => time, fetcher: () => { assert.fail('no save after expiry'); } });
  await controller.connect();
  assert.equal(await controller.sign(), false);
  assert.match(controller.snapshot().notice, /expired/i);
  for (const error of [new Error('User rejected secret-value'), new Error('provider failure secret-value')]) {
    const failed = client.createController(boot, { wallet: async () => { throw error; }, clock: () => now });
    assert.equal(await failed.connect(), false);
    assert.doesNotMatch(failed.snapshot().notice, /secret-value|stack/);
    assert.equal(failed.snapshot().busy, false);
  }
});

test('uncertain local save does not falsely report nothing saved or permit repeat signing', async () => {
  const { boot, output } = await signingFixture();
  let posts = 0;
  const wallet = { async createAction(request) { return { async promptForExecution() { return request.id === 'near::sign_in' ? account : output; } }; } };
  const controller = client.createController(boot, { wallet: async () => wallet, clock: () => now, fetcher: async () => { posts++; throw new Error('synthetic network failure'); } });
  await controller.connect();
  assert.equal(await controller.sign(), false);
  assert.match(controller.snapshot().notice, /unconfirmed/i);
  assert.match(controller.snapshot().block, /unconfirmed/i);
  assert.doesNotMatch(controller.snapshot().notice, /nothing was saved/i);
  assert.equal(await controller.sign(), false);
  assert.equal(posts, 1);
});

test('in-memory SDK storage does not persist across adapter instances', async () => {
  assert.equal(typeof client.memoryStorage, 'function', 'in-memory adapter is implemented');
  const store = client.memoryStorage();
  await store.setItem('fixture', 'synthetic');
  assert.equal(await store.getItem('fixture'), 'synthetic');
  assert.equal(await client.memoryStorage().getItem('fixture'), null);
  assert.deepEqual(await store.getKeys('fix'), ['fixture']);
  await store.removeItem('fixture');
  assert.equal(await store.getItem('fixture'), null);
});

// Adapter/source characterization, not a real browser or wallet journey.
test('UI adapter renders expired record and exact storage amount without opening Meteor', async () => {
  const boot = fixture();
  boot.generated.expires_at = '2000-01-01T00:00:00Z';
  boot.canSign = false;
  boot.generated.correlation_id = '<img src=x onerror=alert(1)>';
  const elements = new Map();
  class Element {
    textContent = ''; children = []; attributes = {}; dataset = {}; hidden = false;
    set innerHTML(_) { assert.fail('upstream data must not use HTML'); }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener() {}
  }
  let teardown;
  const doc = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement() { return new Element(); }, addEventListener() {},
    defaultView: { addEventListener(event, callback) { if (event === 'pagehide') teardown = callback; } },
  };
  let reads = 0;
  try {
    const controller = await client.mountOwnerUi(doc, { origin: 'http://127.0.0.1:4173', fetcher: async (path, options) => {
      reads++;
      assert.equal(path, '/api/intent'); assert.equal(options.method, 'GET');
      return { ok: true, json: async () => boot };
    } });
    assert.ok(controller);
    assert.equal(reads, 1);
    assert.equal(elements.get('sign').disabled, true);
    assert.match(elements.get('intent-state').textContent, /expired/i);
    assert.equal(elements.get('deposit-total').textContent, '12630000000000000000000');
    assert.equal(elements.get('intent-id').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(elements.get('call-rows').children.length, 2);
    assert.equal(elements.get('review').hidden, false);
  } finally { teardown?.(); }
});

test('HTML and module source keep local qualification boundaries explicit', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('./client.mjs', import.meta.url), 'utf8');
  assert.match(html, /src="\/client\.js"/);
  assert.match(html, /Do not connect a real wallet/);
  assert.match(html, /NEAR mainnet/);
  assert.doesNotMatch(source, /innerHTML|localStorage|console\.|near::sign_transactions|addFunctionCallKey|\/submit|generate-intent/);
  assert.match(source, /mobileBridge: \{ enabled: false \}/);
});

const now = Date.parse('2030-01-01T00:00:00Z');
export function fixture() {
  return {
    expectedOwner: { account_id: 'synthetic.near', public_key: 'ed25519:synthetic' },
    csrfToken: 'synthetic-csrf-only', canSign: true,
    generated: {
      type: 'agent_create', status: 'PENDING_SIGNATURE', expires_at: '2030-01-01T00:01:00Z',
      signer: { type: 'near', account_id: 'synthetic.near', public_key: 'ed25519:synthetic' },
      intent: { standard: 'nep366', payload: { receiverId: 'synthetic-contract.near', actions: [
        { type: 'FunctionCall', params: { methodName: 'store_wallet_policy', args: { fixture: 'synthetic only' }, gas: '50000000000000', deposit: '12630000000000000000000' } },
        { type: 'FunctionCall', params: { methodName: 'freeze_wallet', args: {}, gas: '50000000000000', deposit: '0' } },
      ] } },
      preview: { policy: { frozen: true, assets: [], actions: [], destinations: { mode: 'only', list: [] }, budget: { daily_usd: '0', weekly_usd: '0', monthly_usd: '0' } } },
    },
  };
}
const account = { identifier: { blockchain: 'near', network: 'mainnet', accountId: 'synthetic.near' } };

test('signing gate fails closed at expiry, wrong network, wrong account, or server block', () => {
  assert.equal(typeof client.signingBlock, 'function', 'signing gate is implemented');
  const boot = fixture();
  assert.equal(client.signingBlock(boot, account, now), null);
  assert.match(client.signingBlock(boot, account, now + 60000), /expired/i);
  assert.match(client.signingBlock(boot, { identifier: { ...account.identifier, network: 'testnet' } }, now), /mainnet/i);
  assert.match(client.signingBlock(boot, { identifier: { ...account.identifier, accountId: 'other.near' } }, now), /owner/i);
  assert.match(client.signingBlock({ ...boot, canSign: false }, account, now), /server/i);
  assert.match(client.signingBlock(boot, null, now), /connect/i);
});

test('qualification adapter preserves function call args and exact storage deposit, rejecting unsafe records', () => {
  assert.equal(typeof client.prepareBootstrap, 'function', 'qualification adapter is implemented');
  const source = fixture();
  const before = structuredClone(source);
  const boot = client.prepareBootstrap(source);
  const delegate = client.toDelegateAction(boot.generated);
  assert.deepEqual(source, before);
  assert.equal(Object.isFrozen(boot.generated.intent.payload.actions[0].params.args), true);
  assert.equal(delegate.receiverId, source.generated.intent.payload.receiverId);
  assert.equal(delegate.actions[0].functionCall.deposit, 12630000000000000000000n);
  assert.equal(delegate.actions[0].functionCall.gas, 50000000000000n);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(delegate.actions[0].functionCall.args)), { fixture: 'synthetic only' });
  for (const mutate of [
    b => { b.generated.preview.policy.frozen = false; },
    b => { b.generated.preview.policy.budget.daily_usd = '1'; },
    b => { b.generated.preview.policy.destinations.list = ['other.near']; },
    b => { b.generated.signer.public_key = 'ed25519:other'; },
    b => { b.generated.intent.payload.actions[0].type = 'Transfer'; },
    b => { b.generated.intent.payload.actions[0].params.deposit = 12630000000000000000000; },
  ]) {
    const bad = fixture(); mutate(bad);
    assert.throws(() => client.prepareBootstrap(bad), /qualification/i);
  }
});

test('Meteor response object encodes one SignedDelegate to Borsh base64 and rejects changed content', async () => {
  assert.equal(typeof client.signedData, 'function', 'Meteor response adapter is implemented');
  const boot = fixture();
  const pair = KeyPair.fromRandom('ed25519'); // Synthetic in-memory fixture; no real wallet or RPC.
  boot.expectedOwner.public_key = boot.generated.signer.public_key = pair.getPublicKey().toString();
  const native = client.toDelegateAction(boot.generated);
  const delegate = { ...native, senderId: 'synthetic.near', publicKey: pair.getPublicKey(), nonce: 9007199254740993n, maxBlockHeight: 42n };
  const result = await new KeyPairSigner(pair).signDelegateAction(delegate);
  const output = { signedDelegatesWithHashes: [result] };
  assert.deepEqual(client.signedData(boot, output), {
    ...boot.generated.intent, signed_delegate: Buffer.from(encodeSignedDelegate(result.signedDelegate)).toString('base64'),
  });
  assert.throws(() => client.signedData(boot, [result.signedDelegate]), /response/i);
  assert.throws(() => client.signedData(boot, { signedDelegatesWithHashes: [result, result] }), /response/i);
  for (const delta of [
    { receiverId: 'changed.near' }, { senderId: 'changed.near' },
    { publicKey: KeyPair.fromRandom('ed25519').getPublicKey() },
    { actions: [actions.functionCall('changed', {}, 1n, 0n)] },
  ]) {
    assert.throws(() => client.signedData(boot, { signedDelegatesWithHashes: [{
      ...result, signedDelegate: { ...result.signedDelegate, delegateAction: { ...delegate, ...delta } },
    }] }), /match/i);
  }
});
