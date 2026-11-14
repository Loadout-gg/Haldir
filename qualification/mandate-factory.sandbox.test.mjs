import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Sandbox, GenesisAccount } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions } from 'near-api-js';

// Synthetic local-chain balances only; not approved public budgets.
const ONE = 10n ** 24n, CAP = 10n * ONE, FLOAT = 5n * ONE;
const GAS = 100_000_000_000_000n, CREATE_GAS = 300_000_000_000_000n;
const mandateUrl = new URL('../target/mandate-wasm/u01_mandate_proof.wasm', import.meta.url);
const factoryUrl = new URL('../target/mandate-factory-wasm/u01_mandate_factory.wasm', import.meta.url);
const fc = (name, args = {}, deposit = 0n, gas = GAS) => actions.functionCall(name, args, gas, deposit);
const ok = r => r.status && typeof r.status === 'object' && 'SuccessValue' in r.status;
const value = r => JSON.parse(Buffer.from(r.status.SuccessValue, 'base64').toString());
function failure(r, pattern) {
  assert.ok(r.status && 'Failure' in r.status, JSON.stringify(r.status));
  assert.match(JSON.stringify(r.status.Failure), pattern);
}
function evidence(t, label, v) {
  t.diagnostic(`${label} ${JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x)}`);
}
const childId = (owner, label, factory) => 'j' + createHash('sha256')
  .update(`${owner}:${label}`).digest('hex').slice(0, 32) + '.' + factory;
function ledger(s, spent, refunded) {
  assert.deepEqual([s.cap, s.spent, s.refunded, s.reserved, s.free],
    [CAP, spent, refunded, 0n, CAP - spent - refunded].map(String));
}
async function start(t, capacity = 32) {
  assert.equal(process.versions.node, '26.13.0');
  const sandbox = await Sandbox.start({ version: '2.14.0' });
  try {
    assert.equal(new URL(sandbox.rpcUrl).hostname, '127.0.0.1');
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const genesis = GenesisAccount.createDefault();
    const root = new Account(genesis.accountId, provider, genesis.privateKey);
    const send = async (who, receiverId, list) => {
      const r = await who.signAndSendTransaction({ receiverId, actions: list,
        waitUntil: 'FINAL', throwOnFailure: false });
      evidence(t, 'transaction', r); return r;
    };
    async function role(name, near = 200n) {
      const key = KeyPair.fromRandom('ed25519');
      const accountId = `${name}.${root.accountId}`;
      const r = await send(root, accountId, [actions.createAccount(), actions.transfer(near * ONE),
        actions.addFullAccessKey(key.getPublicKey())]);
      assert.ok(ok(r), JSON.stringify(r.status));
      return { account: new Account(accountId, provider, key.toString()), key };
    }
    const { account: owner } = await role('owner');
    const { account: agent } = await role('agent');
    const { account: vendor } = await role('vendor', 10n);
    const { account: outsider } = await role('outsider');
    const { account: factory, key: factoryKey } = await role('factory', 200n);
    const mandate = await readFile(mandateUrl), wasm = await readFile(factoryUrl);
    // Real bootstrap locking, with complete readback before creation is exposed.
    assert.ok(ok(await send(factory, factory.accountId, [actions.deployContract(wasm),
      fc('new', { max_jobs: capacity }), actions.deleteKey(factoryKey.getPublicKey())])));
    const keys = accountId => provider.query({ request_type: 'view_access_key_list', account_id: accountId, finality: 'final' });
    assert.deepEqual((await keys(factory.accountId)).keys, []);
    const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args,
      blockQuery: { finality: 'final' } });
    const balance = async accountId => (await provider.viewAccount({ accountId })).amount;
    const now = async () => BigInt((await provider.viewBlock({ finality: 'final' })).header.timestamp_nanosec);
    const args = async (job_label, delta = {}) => ({ job_label, agent: agent.accountId,
      allowlist: [vendor.accountId], cap: String(CAP),
      deadline_ns: String((await now()) + 3600n * 1_000_000_000n), operating_float: String(FLOAT), ...delta });
    const create = (who, a, deposit = CAP + FLOAT, gas = CREATE_GAS) =>
      send(who, factory.accountId, [fc('create_job', a, deposit, gas)]);
    const entry = (who, label) => view(factory.accountId, 'get_entry', { owner: who.accountId, job_label: label });
    const call = (who, child, name, a = {}, deposit = 0n) => send(who, child, [fc(name, a, deposit)]);
    return { sandbox, provider, root, owner, agent, vendor, outsider, factory, mandate, wasm,
      send, role, keys, view, balance, now, args, create, entry, call };
  } catch (e) { await sandbox.tearDown(); throw e; }
}

test('F1 named and implicit predecessor owners create immutable keyless mandates; agent pay and owner stop/refund', async t => {
  const h = await start(t);
  try {
    const key = KeyPair.fromRandom('ed25519');
    const implicitId = Buffer.from(key.getPublicKey().data).toString('hex');
    assert.match(implicitId, /^[0-9a-f]{64}$/);
    assert.ok(ok(await h.send(h.root, implicitId, [actions.transfer(200n * ONE)])));
    const implicit = new Account(implicitId, h.provider, key.toString());
    const children = [];
    for (const owner of [h.owner, implicit]) {
      const a = await h.args('same-label');
      const child = childId(owner.accountId, a.job_label, h.factory.accountId); children.push(child);
      assert.equal(await h.view(h.factory.accountId, 'job_id', { owner: owner.accountId, job_label: a.job_label }), child);
      const beforeCreate = await h.balance(h.factory.accountId);
      const r = await h.create(owner, a); assert.ok(ok(r)); assert.equal(value(r), true);
      assert.ok(r.receipts_outcome.every(x => !('Failure' in x.outcome.status)));
      const e = await h.entry(owner, a.job_label);
      assert.deepEqual(e, { job: child, owner: owner.accountId, amount: String(CAP + FLOAT), state: 'ready' });
      assert.deepEqual((await h.keys(child)).keys, []);
      const code = await h.provider.query({ request_type: 'view_code', account_id: child, finality: 'final' });
      assert.deepEqual(Buffer.from(code.code_base64, 'base64'), h.mandate);
      const status = () => h.view(child, 'get_status');
      const s = await status();
      assert.equal(s.owner, owner.accountId); assert.equal(s.agent, h.agent.accountId);
      assert.deepEqual(s.allowlist, a.allowlist); assert.equal(s.deadline_ns, a.deadline_ns); ledger(s, 0n, 0n);
      const protocol = await h.provider.sendJsonRpc('EXPERIMENTAL_protocol_config', { finality: 'final' });
      const state = await h.provider.viewAccount({ accountId: child });
      assert.ok(FLOAT > BigInt(state.storage_usage) * BigInt(protocol.runtime_config.storage_amount_per_byte));
      assert.ok(await h.balance(child) >= CAP, 'operating funding preserves principal on this fixture');
      // Factory ends near prefunding, never with the owner's creation principal.
      assert.ok((await h.balance(h.factory.accountId)) - beforeCreate < ONE / 10n);
      failure(await h.call(h.outsider, child, 'new_from_factory', { owner: owner.accountId,
        agent: h.agent.accountId, allowlist: a.allowlist, cap: a.cap, deadline_ns: a.deadline_ns }, CAP), /already|initialized/i);
      failure(await h.create(owner, a), /DUPLICATE_JOB/);
      const payArgs = { order_id: 'purchase', recipient: h.vendor.accountId, amount: String(3n * ONE) };
      failure(await h.call(owner, child, 'pay', payArgs), /AGENT_ONLY/);
      failure(await h.call(h.outsider, child, 'pay', payArgs), /AGENT_ONLY/);
      failure(await h.call(h.agent, child, 'stop'), /OWNER_ONLY/);
      failure(await h.call(h.agent, child, 'withdraw'), /OWNER_ONLY/);
      const vendorBefore = await h.balance(h.vendor.accountId);
      const paid = await h.call(h.agent, child, 'pay', payArgs); assert.ok(ok(paid)); assert.equal(value(paid), true);
      assert.equal(await h.balance(h.vendor.accountId), vendorBefore + 3n * ONE); ledger(await status(), 3n * ONE, 0n);
      assert.ok(ok(await h.call(owner, child, 'stop')));
      failure(await h.call(h.agent, child, 'pay', { ...payArgs, order_id: 'late' }), /STOPPED/);
      const before = await h.balance(owner.accountId);
      const refunded = await h.call(owner, child, 'withdraw'); assert.ok(ok(refunded)); assert.equal(value(refunded), true);
      const received = (await h.balance(owner.accountId)) - before;
      assert.ok(received > 7n * ONE - ONE / 10n && received <= 7n * ONE);
      ledger(await status(), 3n * ONE, 7n * ONE);
      failure(await h.call(owner, child, 'withdraw'), /EMPTY/);
      assert.deepEqual((await h.keys(child)).keys, []);
      evidence(t, 'ready-and-settled', { child, owner: owner.accountId, codeHash: state.code_hash,
        storageUsage: state.storage_usage, received, entry: e, state: await status() });
    }
    assert.notEqual(children[0], children[1]);
  } finally { await h.sandbox.tearDown(); }
});

test('F2 atomic failed child initialization returns complete deposit credit once; roles, replay and capacity', async t => {
  const h = await start(t, 6);
  try {
    for (const [label, delta, pattern] of [
      ['expired', { deadline_ns: '1' }, /DEADLINE/],
      ['role', { agent: h.owner.accountId }, /ROLES/],
      ['allowlist', { allowlist: [h.owner.accountId] }, /RECIPIENT_ROLE/],
      ['duplicate', { allowlist: [h.vendor.accountId, h.vendor.accountId] }, /ALLOWLIST_DUPLICATE/],
      ['too-large', { cap: String(101n * ONE) }, /CAP/],
      ['no-storage', { operating_float: '1' }, /STORAGE_FUNDING|balance|storage|Storage|Balance|LackBalance/],
    ]) {
      const a = await h.args(label, delta), deposit = BigInt(a.cap) + BigInt(a.operating_float);
      const child = childId(h.owner.accountId, label, h.factory.accountId);
      const factoryBefore = await h.balance(h.factory.accountId);
      const result = await h.create(h.owner, a, deposit);
      assert.ok(ok(result)); assert.equal(value(result), false);
      const failed = result.receipts_outcome.filter(x => 'Failure' in x.outcome.status);
      assert.ok(failed.length > 0); assert.match(JSON.stringify(failed), pattern);
      await assert.rejects(h.provider.viewAccount({ accountId: child }), /not exist|not found|does not exist|UnknownAccount/i);
      const e = await h.entry(h.owner, label); assert.equal(e.state, 'credit'); assert.equal(e.amount, String(deposit));
      const retained = (await h.balance(h.factory.accountId)) - factoryBefore;
      assert.ok(retained > deposit - ONE / 10n && retained <= deposit + ONE / 10n,
        'failed batch returns both cap and float to factory');
      failure(await h.call(h.outsider, h.factory.accountId, 'claim_creation_refund', { job_label: label }), /JOB/);
      assert.equal((await h.entry(h.owner, label)).state, 'credit');
      const before = await h.balance(h.owner.accountId);
      const claim = await h.call(h.owner, h.factory.accountId, 'claim_creation_refund', { job_label: label });
      assert.ok(ok(claim)); assert.equal(value(claim), true);
      const received = (await h.balance(h.owner.accountId)) - before;
      assert.ok(received > deposit - ONE / 10n && received <= deposit);
      assert.equal((await h.entry(h.owner, label)).state, 'refunded');
      failure(await h.call(h.owner, h.factory.accountId, 'claim_creation_refund', { job_label: label }), /NO_CREDIT/);
      // Lifetime tombstones reject retry even after all funds are returned.
      const replay = await h.create(h.owner, a, deposit); failure(replay, /DUPLICATE_JOB|CAPACITY/);
      evidence(t, 'failed-create-refund', { label, child, failure: failed, retained, received,
        entry: await h.entry(h.owner, label) });
    }
    failure(await h.create(h.owner, await h.args('seventh')), /CAPACITY/);
  } finally { await h.sandbox.tearDown(); }
});

test('F4 maximum cap is not storage funding: one-yocto float fails atomically and returns complete creation credit', async t => {
  const h = await start(t);
  try {
    const cap = 100n * ONE;
    const a = await h.args('underfunded', { cap: String(cap), operating_float: '1' });
    const child = childId(h.owner.accountId, a.job_label, h.factory.accountId);
    const creation = await h.create(h.owner, a, cap + 1n);
    assert.ok(ok(creation)); assert.equal(value(creation), false);
    assert.match(JSON.stringify(creation.receipts_outcome), /STORAGE_FUNDING/);
    assert.equal((await h.entry(h.owner, a.job_label)).state, 'credit');
    await assert.rejects(h.provider.viewAccount({ accountId: child }), /not exist|not found|does not exist|UnknownAccount/i);
    const before = await h.balance(h.owner.accountId);
    const refund = await h.call(h.owner, h.factory.accountId, 'claim_creation_refund', { job_label: a.job_label });
    assert.ok(ok(refund)); assert.equal(value(refund), true);
    const received = (await h.balance(h.owner.accountId)) - before;
    assert.ok(received > cap + 1n - ONE / 10n && received <= cap + 1n);
    assert.equal((await h.entry(h.owner, a.job_label)).state, 'refunded');
    evidence(t, 'underfunded-fail-closed', { createTx: creation.transaction.hash,
      refundTx: refund.transaction.hash, child, cap, operatingFloat: 1n, received,
      factoryEntry: await h.entry(h.owner, a.job_label) });
  } finally { await h.sandbox.tearDown(); }
});

// Independent Borsh layout oracle; code bytes and protocol record/account overhead
// come from the actual built artifact/runtime, never a financial fixture floor.
function storageBudget(wasm, owner, agent, allowlist, protocol) {
  const sizes = protocol.runtime_config.transaction_costs.storage_usage_config;
  const price = BigInt(protocol.runtime_config.storage_amount_per_byte);
  // SDK 5.30.1 storage_byte_cost is this protocol genesis price (not a host call).
  assert.equal(price, 10n ** 19n);
  const str = s => 4 + Buffer.byteLength(s);
  const initialState = str(owner) + str(agent) + 4 + allowlist.reduce((n, a) => n + str(a), 0)
    + 16 + 8 + 16 + 16 + 1 + 4 + 1 + 8;
  const order = 4 + 64 + 4 + Math.max(...allowlist.map(a => Buffer.byteLength(a))) + 16 + 1;
  const flight = 4 + 64 + 16 + 1;
  const initialBytes = wasm.length + sizes.num_bytes_account + 5 + sizes.num_extra_bytes_record + initialState;
  const maxBytes = initialBytes + 16 * order + flight;
  return { initialState, initialBytes, maxBytes, minimum: BigInt(maxBytes) * price, price };
}

test('F5 exact storage boundary rejects one yocto short; maximum 16-order growth leaves all principal spendable or refundable', async t => {
  const h = await start(t);
  try {
    const protocol = await h.provider.sendJsonRpc('EXPERIMENTAL_protocol_config', { finality: 'final' });
    const key = KeyPair.fromRandom('ed25519');
    const implicitId = Buffer.from(key.getPublicKey().data).toString('hex');
    assert.ok(ok(await h.send(h.root, implicitId, [actions.transfer(200n * ONE)])));
    const implicit = new Account(implicitId, h.provider, key.toString());
    const suffix = '.' + h.root.accountId;
    const { account: longAgent } = await h.role('a'.repeat(64 - suffix.length));
    const { account: longVendor } = await h.role('v'.repeat(64 - suffix.length));
    const longAllowlist = [longVendor.accountId, ...['w', 'x', 'y'].map(c => c.repeat(64 - suffix.length) + suffix)];
    assert.ok([implicit.accountId, longAgent.accountId, ...longAllowlist].every(a => a.length === 64));
    for (const [shape, owner, agent, allowlist] of [
      ['named', h.owner, h.agent, [h.vendor.accountId, `absent.${h.root.accountId}`]],
      ['maximal', implicit, longAgent, longAllowlist],
    ]) {
      const budget = storageBudget(h.mandate, owner.accountId, agent.accountId, allowlist, protocol);
      // Snapshot-only funding and minimum-1 both have ample raw balance due to cap,
      // but must fail the constructor and return ALL credited funding via factory.
      for (const [kind, float] of [['snapshot', BigInt(budget.initialBytes) * budget.price], ['short', budget.minimum - 1n]]) {
        const label = `${shape}-${kind}`;
        const a = await h.args(label, { agent: agent.accountId, allowlist, operating_float: String(float) });
        const deposit = CAP + float;
        const r = await h.create(owner, a, deposit);
        assert.ok(ok(r)); assert.equal(value(r), false, `${label} must not be ready`);
        assert.match(JSON.stringify(r.receipts_outcome), /STORAGE_FUNDING/);
        assert.equal((await h.entry(owner, label)).state, 'credit');
        const child = childId(owner.accountId, label, h.factory.accountId);
        await assert.rejects(h.provider.viewAccount({ accountId: child }), /not exist|not found|does not exist|UnknownAccount/i);
        const before = await h.balance(owner.accountId);
        const claimed = await h.call(owner, h.factory.accountId, 'claim_creation_refund', { job_label: label });
        assert.ok(ok(claimed)); assert.equal(value(claimed), true);
        const received = (await h.balance(owner.accountId)) - before;
        assert.ok(received > deposit - ONE / 10n && received <= deposit);
        assert.equal((await h.entry(owner, label)).state, 'refunded');
      }
      for (const mode of ['spend', 'refund', 'failed-refund']) {
        const label = `${shape}-${mode}`;
        const a = await h.args(label, { agent: agent.accountId, allowlist, operating_float: String(budget.minimum) });
        const r = await h.create(owner, a, CAP + budget.minimum);
        assert.ok(ok(r)); assert.equal(value(r), true);
        const child = childId(owner.accountId, label, h.factory.accountId);
        assert.equal((await h.entry(owner, label)).state, 'ready');
        assert.deepEqual((await h.keys(child)).keys, []);
        const initial = await h.provider.viewAccount({ accountId: child });
        assert.equal(initial.storage_usage, budget.initialBytes);
        const raw = await h.provider.query({ request_type: 'view_state', account_id: child, prefix_base64: '', finality: 'final' });
        assert.equal(raw.values.length, 1);
        assert.equal(Buffer.from(raw.values[0].key, 'base64').toString(), 'STATE');
        assert.equal(Buffer.from(raw.values[0].value, 'base64').length, budget.initialState);
        const vendorBefore = await h.balance(allowlist[0]);
        const transferSucceeds = mode !== 'failed-refund';
        const recipient = allowlist[transferSucceeds ? 0 : 1];
        if (!transferSucceeds) await assert.rejects(h.provider.viewAccount({ accountId: recipient }), /not exist|not found|does not exist|UnknownAccount/i);
        for (let i = 0; i < 16; i++) {
          const amount = mode === 'spend' && i === 15 ? CAP - 15n : 1n;
          const paid = await h.call(agent, child, 'pay', { order_id: String(i).padStart(64, '0'), recipient, amount: String(amount) });
          assert.ok(ok(paid)); assert.equal(value(paid), transferSucceeds);
          const failures = paid.receipts_outcome.filter(x => 'Failure' in x.outcome.status);
          assert.equal(failures.length, transferSucceeds ? 0 : 1);
          if (!transferSucceeds) assert.match(JSON.stringify(failures), /AccountDoesNotExist|UnknownAccount|does not exist/);
        }
        const spent = mode === 'spend' ? CAP : transferSucceeds ? 16n : 0n;
        assert.equal(await h.balance(allowlist[0]), vendorBefore + spent);
        const s = await h.view(child, 'get_status'); ledger(s, spent, 0n);
        assert.equal(s.orders.length, 16);
        assert.ok(s.orders.every(o => o.order_id.length === 64 && o.state === (transferSucceeds ? 'paid' : 'failed')));
        failure(await h.call(agent, child, 'pay', { order_id: 'seventeenth', recipient: allowlist[0], amount: '1' }), /ORDER_LIMIT/);
        assert.ok(ok(await h.call(owner, child, 'stop')));
        if (mode !== 'spend') {
          const before = await h.balance(owner.accountId);
          const refunded = await h.call(owner, child, 'withdraw');
          assert.ok(ok(refunded)); assert.equal(value(refunded), true);
          assert.ok(refunded.receipts_outcome.every(x => !('Failure' in x.outcome.status)));
          const received = (await h.balance(owner.accountId)) - before;
          assert.ok(received > CAP - spent - ONE / 10n && received <= CAP - spent);
        } else failure(await h.call(owner, child, 'withdraw'), /EMPTY/);
        ledger(await h.view(child, 'get_status'), spent, CAP - spent);
        const final = await h.provider.viewAccount({ accountId: child });
        assert.equal(final.storage_usage, budget.maxBytes - 85);
        assert.ok(final.amount >= BigInt(final.storage_usage) * budget.price);
        assert.deepEqual((await h.keys(child)).keys, []);
        evidence(t, 'exact-boundary-full-growth', { shape, mode, child, budget, final });
      }
    }
  } finally { await h.sandbox.tearDown(); }
});

test('F3 ABI rejects unauthorized initializer/callbacks, wrong funding and malformed bindings; substitutions cannot select owner or code', async t => {
  const h = await start(t);
  try {
    const { account: raw } = await h.role('uninitialized', 20n);
    assert.ok(ok(await h.send(raw, raw.accountId, [actions.deployContract(h.mandate)])));
    const a = await h.args('auth');
    const init = { owner: h.owner.accountId, agent: h.agent.accountId, allowlist: a.allowlist, cap: a.cap, deadline_ns: a.deadline_ns };
    failure(await h.call(h.owner, raw.accountId, 'new_from_factory', init, CAP), /FACTORY_ONLY/);
    failure(await h.call(h.outsider, raw.accountId, 'new_from_factory', { ...init, owner: h.outsider.accountId }, CAP), /FACTORY_ONLY/);
    failure(await h.call(h.outsider, raw.accountId, 'new', init, CAP), /OWNER_ONLY/);
    failure(await h.create(h.owner, a, CAP + FLOAT - 1n), /DEPOSIT/);
    failure(await h.create(h.owner, a, CAP + FLOAT + 1n), /DEPOSIT/);
    failure(await h.create(h.owner, a, CAP + FLOAT, 199_000_000_000_000n), /GAS/);
    for (const job_label of ['', 'bad.id', 'UPPER', 'x'.repeat(33)]) {
      failure(await h.create(h.owner, { ...a, job_label }), /LABEL/);
    }
    assert.equal(await h.entry(h.owner, 'auth'), null);
    // near-sdk ignores extra JSON fields; prove these cannot override bound inputs.
    const sub = { ...a, owner: h.outsider.accountId, code: 'AGFzbQEAAAA=', job: raw.accountId };
    const r = await h.create(h.owner, sub); assert.ok(ok(r)); assert.equal(value(r), true);
    const child = childId(h.owner.accountId, a.job_label, h.factory.accountId);
    assert.equal((await h.view(child, 'get_status')).owner, h.owner.accountId);
    assert.equal(await h.entry(h.outsider, 'auth'), null);
    const code = await h.provider.query({ request_type: 'view_code', account_id: child, finality: 'final' });
    assert.deepEqual(Buffer.from(code.code_base64, 'base64'), h.mandate);
    for (const [method, args] of [['on_create', { job: child }], ['on_creation_refund', { job: child }]]) {
      failure(await h.call(h.outsider, h.factory.accountId, method, args), /private|PRIVATE/i);
    }
    for (const method of ['deploy', 'upgrade', 'execute', 'set_owner']) {
      failure(await h.call(h.owner, h.factory.accountId, method, {}), /MethodNotFound|method|resolve/i);
    }
    failure(await h.create(h.owner, sub), /DUPLICATE_JOB/);
    assert.deepEqual((await h.keys(child)).keys, []);
  } finally { await h.sandbox.tearDown(); }
});
