import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Sandbox, GenesisAccount } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions } from 'near-api-js';

const ONE = 10n ** 24n;
const CAP = 10n * ONE;
const GAS = 100_000_000_000_000n;
const wasmUrl = new URL('../target/mandate-wasm/u01_mandate_proof.wasm', import.meta.url);
const fc = (method, args = {}, deposit = 0n) => actions.functionCall(method, args, GAS, deposit);
const succeeded = r => r.status && typeof r.status === 'object' && 'SuccessValue' in r.status;
const decoded = r => JSON.parse(Buffer.from(r.status.SuccessValue, 'base64').toString('utf8'));
function failure(r, pattern) {
  assert.ok(r.status && 'Failure' in r.status, JSON.stringify(r.status));
  assert.match(JSON.stringify(r.status.Failure), pattern);
}
function accounting(s, spent, refunded, reserved, free) {
  assert.deepEqual([s.spent, s.refunded, s.reserved, s.free],
    [spent, refunded, reserved, free].map(String));
  assert.equal(BigInt(s.cap), spent + refunded + reserved + free);
}
function evidence(t, label, values) {
  t.diagnostic(`${label} ${JSON.stringify(values, (_, value) =>
    typeof value === 'bigint' ? String(value) : value)}`);
}
async function start(t) {
  assert.equal(process.versions.node, '26.13.0');
  const sandbox = await Sandbox.start({ version: '2.14.0' });
  try {
    assert.equal(new URL(sandbox.rpcUrl).hostname, '127.0.0.1');
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const genesis = GenesisAccount.createDefault();
    const root = new Account(genesis.accountId, provider, genesis.privateKey);
    const send = async (who, receiverId, list) => {
      const result = await who.signAndSendTransaction({
        receiverId, actions: list, waitUntil: 'FINAL', throwOnFailure: false,
      });
      evidence(t, 'transaction', result); // local synthetic chain receipts; never private keys
      return result;
    };
    async function role(name, near) {
      const key = KeyPair.fromRandom('ed25519');
      const accountId = `${name}.${root.accountId}`;
      const r = await send(root, accountId, [actions.createAccount(), actions.transfer(near * ONE),
        actions.addFullAccessKey(key.getPublicKey())]);
      assert.ok(succeeded(r), JSON.stringify(r.status));
      return new Account(accountId, provider, key.toString());
    }
    const owner = await role('owner', 200n);
    const agent = await role('agent', 100n);
    const vendor = await role('vendor', 10n);
    const outsider = await role('outsider', 100n);
    const missing = `missing.${root.accountId}`;
    const balance = async accountId => (await provider.viewAccount({ accountId })).amount;
    const now = async () => BigInt((await provider.viewBlock({ finality: 'final' })).header.timestamp_nanosec);
    const wasm = await readFile(wasmUrl);
    async function deploy(name, seconds = 3600n) {
      const key = KeyPair.fromRandom('ed25519');
      const accountId = `${name}.${owner.accountId}`;
      const deadline = (await now()) + seconds * 1_000_000_000n;
      const args = { owner: owner.accountId, agent: agent.accountId,
        allowlist: [vendor.accountId, missing], cap: String(CAP), deadline_ns: String(deadline) };
      const r = await send(owner, accountId, [actions.createAccount(), actions.transfer(5n * ONE),
        actions.addFullAccessKey(key.getPublicKey()), actions.deployContract(wasm), fc('new', args, CAP)]);
      assert.ok(succeeded(r), JSON.stringify(r.status));
      const account = new Account(accountId, provider, key.toString()); // privileged fault-injection key only
      const call = (who, method, args = {}, deposit = 0n) => send(who, accountId, [fc(method, args, deposit)]);
      const status = () => provider.callFunction({ contractId: accountId, method: 'get_status', args: {},
        blockQuery: { finality: 'final' } });
      const pay = (key, amount, recipient = vendor.accountId, who = agent, deposit = 0n) =>
        call(who, 'pay', { order_id: key, recipient, amount: String(amount) }, deposit);
      accounting(await status(), 0n, 0n, 0n, CAP);
      return { accountId, account, call, status, pay, deadline, args };
    }
    return { sandbox, provider, root, owner, agent, vendor, outsider, missing,
      balance, now, send, deploy };
  } catch (error) { await sandbox.tearDown(); throw error; }
}

test('S1 real mandate payments, admission, shared-cap race, stop and residual return', async t => {
  const h = await start(t);
  try {
    const m = await h.deploy('job');
    const initial = await m.status();
    assert.equal(initial.owner, h.owner.accountId); assert.equal(initial.agent, h.agent.accountId);
    assert.deepEqual(initial.allowlist, [h.vendor.accountId, h.missing]);
    assert.equal(initial.deadline_ns, String(m.deadline));
    failure(await m.call(h.owner, 'new', m.args, CAP), /already|initialized/i);
    failure(await m.pay('owner-denied', ONE, h.vendor.accountId, h.owner), /AGENT_ONLY/);
    failure(await m.pay('intruder-denied', ONE, h.vendor.accountId, h.outsider), /AGENT_ONLY/);
    failure(await m.pay('excluded', ONE, h.outsider.accountId), /RECIPIENT/);
    failure(await m.pay('too-much', CAP + 1n), /BUDGET/);
    failure(await m.pay('deposit', ONE, h.vendor.accountId, h.agent, ONE), /deposit|payable|NO_DEPOSIT/i);
    failure(await m.pay('x'.repeat(65), ONE), /ORDER_ID/);
    failure(await m.call(h.agent, 'on_payment', { order_id: 'fake' }), /private|CALLBACK_PRIVATE/i);
    failure(await m.call(h.owner, 'on_refund', { nonce: '1' }), /private|CALLBACK_PRIVATE/i);
    failure(await m.call(h.agent, 'stop'), /OWNER_ONLY/);
    failure(await m.call(h.agent, 'withdraw'), /OWNER_ONLY/);
    failure(await m.call(h.owner, 'withdraw'), /NOT_CLOSED/);
    accounting(await m.status(), 0n, 0n, 0n, CAP);

    const before = await h.balance(h.vendor.accountId);
    const paid = await m.pay('supplier', 3n * ONE);
    assert.ok(succeeded(paid)); assert.equal(decoded(paid), true);
    assert.equal(await h.balance(h.vendor.accountId), before + 3n * ONE);
    accounting(await m.status(), 3n * ONE, 0n, 0n, 7n * ONE);
    failure(await m.pay('supplier', 3n * ONE), /DUPLICATE/);
    assert.equal(await h.balance(h.vendor.accountId), before + 3n * ONE);

    const failed = await m.pay('missing', ONE, h.missing);
    assert.ok(succeeded(failed)); assert.equal(decoded(failed), false);
    assert.ok(failed.receipts_outcome.some(r => 'Failure' in r.outcome.status));
    const afterFailure = await m.status();
    evidence(t, 'payment-failure', { tx: failed.transaction.hash,
      receiptFailures: failed.receipts_outcome.filter(r => 'Failure' in r.outcome.status)
        .map(r => ({ id: r.id, status: r.outcome.status })), callback: decoded(failed), state: afterFailure });
    assert.equal(afterFailure.orders.find(o => o.order_id === 'missing').state, 'failed');
    accounting(afterFailure, 3n * ONE, 0n, 0n, 7n * ONE);
    failure(await m.pay('missing', ONE), /DUPLICATE/);

    const topup = await h.send(h.root, m.accountId, [actions.transfer(20n * ONE)]);
    assert.ok(succeeded(topup));
    accounting(await m.status(), 3n * ONE, 0n, 0n, 7n * ONE);
    failure(await m.pay('balance-not-authority', 8n * ONE), /BUDGET/);
    // Actual independent SDK calls; either overlapping IN_FLIGHT or later BUDGET rejection is safe.
    const race = await Promise.all([m.pay('race-a', 6n * ONE), m.pay('race-b', 6n * ONE)]);
    evidence(t, 'shared-cap-race', { outcomes: race.map(r => ({ tx: r.transaction.hash, status: r.status })) });
    assert.equal(race.filter(succeeded).length, 1);
    for (const r of race.filter(r => !succeeded(r))) failure(r, /IN_FLIGHT|BUDGET/);
    assert.equal(await h.balance(h.vendor.accountId), before + 9n * ONE);
    accounting(await m.status(), 9n * ONE, 0n, 0n, ONE);

    // Live scheduling race: do not pretend its order is deterministic.
    const [late, stopped] = await Promise.all([m.pay('last-race', ONE / 2n), m.call(h.owner, 'stop')]);
    assert.ok(succeeded(stopped));
    if (succeeded(late)) assert.equal(decoded(late), true);
    else failure(late, /STOPPED/);
    const s = await m.status(); assert.equal(s.stopped, true);
    const spent = succeeded(late) ? 9n * ONE + ONE / 2n : 9n * ONE;
    accounting(s, spent, 0n, 0n, CAP - spent);
    assert.equal(await h.balance(h.vendor.accountId), before + spent);
    failure(await m.pay('after-stop', 1n), /STOPPED/);
    const ownerBefore = await h.balance(h.owner.accountId);
    const out = await m.call(h.owner, 'withdraw'); assert.ok(succeeded(out)); assert.equal(decoded(out), true);
    const received = (await h.balance(h.owner.accountId)) - ownerBefore;
    evidence(t, 'stop-and-return', { late: late.status, spent, received,
      expectedPrincipal: CAP - spent, settled: await m.status() });
    assert.ok(received > CAP - spent - ONE / 10n && received <= CAP - spent,
      'owner actually receives residual principal, with at most 0.1 local NEAR allowed for transaction fees');
    accounting(await m.status(), spent, CAP - spent, 0n, 0n);
    failure(await m.call(h.owner, 'withdraw'), /EMPTY/);
    assert.ok(await h.balance(m.accountId) > 20n * ONE, 'topup/operating balance is not refunded as principal');
  } finally { await h.sandbox.tearDown(); }
});

test('S2 real refund failure and retry, double withdrawal, and fast-forward expiry', async t => {
  const h = await start(t);
  try {
    const m = await h.deploy('refund');
    assert.ok(succeeded(await m.call(h.owner, 'stop')));
    // Explicitly privileged test fault, not a public mandate method or production security claim.
    const state = await h.provider.viewAccount({ accountId: m.accountId });
    const protocol = await h.provider.sendJsonRpc('EXPERIMENTAL_protocol_config', { finality: 'final' });
    const bytePrice = protocol.runtime_config?.storage_amount_per_byte;
    assert.match(String(bytePrice), /^[1-9][0-9]*$/);
    const storageStake = BigInt(state.storage_usage) * BigInt(bytePrice);
    // Synthetic local fee margin, NOT a provider minimum or an approved real allowance.
    const retained = storageStake + ONE;
    const balance = await h.balance(m.accountId);
    assert.ok(retained < CAP && balance > retained, 'fault fixture must preserve storage but lack principal');
    assert.ok(succeeded(await h.send(m.account, h.root.accountId, [actions.transfer(balance - retained)])));
    const remaining = await h.balance(m.accountId);
    assert.ok(remaining >= storageStake && remaining < CAP);
    evidence(t, 'dynamic-storage-fault', { storageUsage: state.storage_usage, bytePrice,
      storageStake, retained, remaining, balanceBefore: balance });
    const failed = await m.call(h.owner, 'withdraw');
    // nearcore deducts outgoing transfer funds while constructing a promise.
    // Insufficient funds abort THIS receipt; its reservation and nonce roll back. No callback exists.
    evidence(t, 'refund-scheduling-failure', { tx: failed.transaction.hash, status: failed.status,
      stateAfter: await m.status() });
    failure(failed, /balance|Balance|funds|Funds/);
    accounting(await m.status(), 0n, 0n, 0n, CAP);
    assert.equal((await m.status()).refund_nonce, '0');
    const doubleFailure = await Promise.all([m.call(h.owner, 'withdraw'), m.call(h.owner, 'withdraw')]);
    for (const r of doubleFailure) failure(r, /balance|Balance|funds|Funds/);
    accounting(await m.status(), 0n, 0n, 0n, CAP);
    assert.equal((await m.status()).refund_nonce, '0');
    assert.ok(succeeded(await h.send(h.root, m.accountId, [actions.transfer(20n * ONE)])));
    accounting(await m.status(), 0n, 0n, 0n, CAP);
    const before = await h.balance(h.owner.accountId);
    const double = await Promise.all([m.call(h.owner, 'withdraw'), m.call(h.owner, 'withdraw')]);
    assert.equal(double.filter(succeeded).length, 1);
    for (const r of double) {
      if (succeeded(r)) assert.equal(decoded(r), true);
      else failure(r, /IN_FLIGHT|EMPTY/);
    }
    accounting(await m.status(), 0n, CAP, 0n, 0n);
    const received = (await h.balance(h.owner.accountId)) - before;
    evidence(t, 'refund-retry', { outcomes: double.map(r => ({ tx: r.transaction.hash, status: r.status })),
      received, settled: await m.status() });
    assert.ok(received > CAP - ONE / 10n && received <= CAP);
    failure(await m.call(h.owner, 'withdraw'), /EMPTY/);

    const expiring = await h.deploy('expiry', 60n);
    assert.ok(await h.now() < expiring.deadline, 'fixture starts before its immutable deadline');
    // near-sandbox 0.3.5 has no fastForward wrapper; exact generic provider + nearcore 2.14 schema.
    for (let i = 0; i < 5 && await h.now() < expiring.deadline; i++) {
      await h.provider.sendJsonRpc('sandbox_fast_forward', { delta_height: 1000 });
    }
    evidence(t, 'chain-expiry', { actualTimestamp: await h.now(), deadline: expiring.deadline });
    assert.ok(await h.now() >= expiring.deadline, 'actual chain timestamp crosses deadline; no wall-clock sleep oracle');
    assert.equal((await expiring.status()).expired, true);
    failure(await expiring.pay('too-late', ONE), /EXPIRED/);
    accounting(await expiring.status(), 0n, 0n, 0n, CAP);
    const result = await expiring.call(h.owner, 'withdraw');
    assert.ok(succeeded(result)); assert.equal(decoded(result), true);
    accounting(await expiring.status(), 0n, CAP, 0n, 0n);
  } finally { await h.sandbox.tearDown(); }
});
