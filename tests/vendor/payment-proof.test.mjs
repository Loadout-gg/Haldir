import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Sandbox, GenesisAccount } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, actions, baseEncode } from 'near-api-js';
import { verifyPaymentProof } from '../../src/vendor/payment-proof.mjs';

// No external RPC or binary download: only installed Sandbox and loopback fetch.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  assert.equal(url.hostname, '127.0.0.1', `external fetch forbidden: ${url.origin}`);
  assert.equal(url.protocol, 'http:', 'only local Sandbox HTTP is allowed');
  return originalFetch(input, options);
};
after(() => { globalThis.fetch = originalFetch; });
test('test transport fence rejects external RPC without dispatching it', () => {
  assert.throws(() => fetch('https://forbidden.invalid/rpc'), /external fetch forbidden/);
});
const ONE = 10n ** 24n;
const GAS = 100_000_000_000_000n;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const fc = (name, args, deposit = 0n) => actions.functionCall(name, args, GAS, deposit);

function syntheticPayment() {
  const hash = n => baseEncode(new Uint8Array(32).fill(n));
  const quote = { networkId: 'testnet', mandateId: 'job.testnet', vendorId: 'vendor.testnet',
    amountAtomic: '3000000000000000000000000', orderId: 'quote-1' };
  const args = { order_id: quote.orderId, recipient: quote.vendorId, amount: quote.amountAtomic };
  const pay = { FunctionCall: { method_name: 'pay', args: encode(args), deposit: '0', gas: Number(GAS) } };
  const signer = 'agent.testnet', publicKey = `ed25519:${hash(8)}`;
  const outcome = (n, executor, children, status = { SuccessValue: '' }) => ({ id: hash(n), block_hash: hash(9),
    outcome: { executor_id: executor, receipt_ids: children.map(hash), status, logs: [], gas_burnt: 0, tokens_burnt: '0' }, proof: [] });
  const receipt = (n, predecessor, receiver, list, input = [], output = []) => ({ receipt_id: hash(n),
    predecessor_id: predecessor, receiver_id: receiver, receipt: { Action: { actions: list,
      signer_id: signer, signer_public_key: publicKey, gas_price: '1000000000',
      input_data_ids: input, output_data_receivers: output } } });
  const finalTransaction = { final_execution_status: 'FINAL', status: { SuccessValue: encode(true) },
    transaction: { hash: hash(1), signer_id: signer, public_key: publicKey, receiver_id: quote.mandateId, actions: [pay] },
    transaction_outcome: outcome(1, signer, [2], { SuccessReceiptId: hash(2) }),
    receipts_outcome: [outcome(2, quote.mandateId, [3, 4], { SuccessReceiptId: hash(4) }),
      outcome(3, quote.vendorId, []), outcome(4, quote.mandateId, [], { SuccessValue: encode(true) })] };
  const receipts = [receipt(2, signer, quote.mandateId, [pay]),
    receipt(3, quote.mandateId, quote.vendorId, [{ Transfer: { deposit: quote.amountAtomic } }], [],
      [{ data_id: hash(5), receiver_id: quote.mandateId }]),
    receipt(4, quote.mandateId, quote.mandateId, [{ FunctionCall: { method_name: 'on_payment',
      args: encode({ order_id: quote.orderId }), deposit: '0', gas: 20_000_000_000_000 } }], [hash(5)])];
  return { quote, evidence: { networkId: quote.networkId, finalTransaction, receipts } };
}

function expectedProof(quote, evidence) {
  const transfer = evidence.receipts.find(r => r.predecessor_id === quote.mandateId && r.receiver_id === quote.vendorId);
  return { proofId: JSON.stringify(['near-native-transfer-v1', quote.networkId, transfer.receipt_id]),
    networkId: quote.networkId, transactionHash: evidence.finalTransaction.transaction.hash,
    payReceiptId: evidence.finalTransaction.transaction_outcome.outcome.receipt_ids[0],
    transferReceiptId: transfer.receipt_id, mandateId: quote.mandateId, vendorId: quote.vendorId,
    amountAtomic: quote.amountAtomic, orderId: quote.orderId };
}

test('returns a stable network/receipt identity for an exact native payment without mutating input', () => {
  const { quote, evidence } = syntheticPayment();
  const before = structuredClone({ quote, evidence });
  assert.deepEqual(verifyPaymentProof(quote, evidence), expectedProof(quote, evidence));
  assert.deepEqual(verifyPaymentProof(quote, evidence), expectedProof(quote, evidence));
  assert.deepEqual({ quote, evidence }, before);
});

function rejectsChange(name, mutate, code) {
  test(name, () => {
    const fixture = syntheticPayment();
    mutate(fixture);
    assert.throws(() => verifyPaymentProof(fixture.quote, fixture.evidence), error => error.code === code);
  });
}

for (const [field, value] of [['networkId', 'mainnet'], ['mandateId', 'other.testnet'],
  ['vendorId', 'other.testnet'], ['amountAtomic', '1'], ['orderId', 'other-order']]) {
  rejectsChange(`rejects approved ${field} mismatch`, f => { f.quote[field] = value; },
    field === 'networkId' ? 'NETWORK_MISMATCH' : 'PAY_CALL_MISMATCH');
}
for (const value of ['0', '-1', '01', '1.0', '1e24', 3e24, String(2n ** 128n)]) {
  rejectsChange(`rejects noncanonical or out-of-u128 quote amount ${value}`, f => { f.quote.amountAtomic = value; }, 'INVALID_QUOTE');
}
for (const [field, value] of [['orderId', 'bad/order'], ['orderId', 'x'.repeat(65)],
  ['mandateId', 'BAD.testnet'], ['vendorId', 'vendor.testnet '], ['networkId', '']]) {
  rejectsChange(`rejects invalid quote ${field} ${value}`, f => { f.quote[field] = value; }, 'INVALID_QUOTE');
}
for (const [name, mutate] of [
  ['non-final outcome', t => { t.final_execution_status = 'EXECUTED'; }],
  ['top-level failure', t => { t.status = { Failure: {} }; }],
]) rejectsChange(`rejects ${name}`, f => mutate(f.evidence.finalTransaction), 'NOT_FINAL');
for (const [name, mutate] of [
  ['wrong receiver', t => { t.transaction.receiver_id = 'other.testnet'; }],
  ['wrong method', t => { t.transaction.actions[0].FunctionCall.method_name = 'withdraw'; }],
  ['multiple actions', t => { t.transaction.actions.push({ Transfer: { deposit: '1' } }); }],
  ['attached deposit', t => { t.transaction.actions[0].FunctionCall.deposit = '1'; }],
  ['malformed base64', t => { t.transaction.actions[0].FunctionCall.args = 'ey...=='; }],
  ['numeric ABI amount', t => { t.transaction.actions[0].FunctionCall.args = encode({ order_id: 'quote-1', recipient: 'vendor.testnet', amount: 3e24 }); }],
  ['extra ABI field', t => { t.transaction.actions[0].FunctionCall.args = encode({ order_id: 'quote-1', recipient: 'vendor.testnet', amount: '3000000000000000000000000', extra: true }); }],
]) rejectsChange(`rejects pay ${name}`, f => mutate(f.evidence.finalTransaction), 'PAY_CALL_MISMATCH');

for (const [name, mutate, code] of [
  ['missing full receipts despite paid state', f => { delete f.evidence.receipts; f.evidence.state = { paid: true }; }, 'MISSING_ACTION_EVIDENCE'],
  ['missing one full receipt', f => { f.evidence.receipts.pop(); }, 'MISSING_ACTION_EVIDENCE'],
  ['failed descendant behind top-level success', f => { f.evidence.finalTransaction.receipts_outcome[1].outcome.status = { Failure: { ActionError: {} } }; }, 'GRAPH_INVALID'],
  ['failed callback after a successful transfer', f => { f.evidence.finalTransaction.receipts_outcome[2].outcome.status = { Failure: {} }; }, 'GRAPH_INVALID'],
  ['unknown receipt status', f => { f.evidence.finalTransaction.receipts_outcome[1].outcome.status = 'Unknown'; }, 'GRAPH_INVALID'],
  ['missing descendant outcome', f => { f.evidence.finalTransaction.receipts_outcome.pop(); }, 'GRAPH_INVALID'],
  ['duplicate outcome ID', f => { f.evidence.finalTransaction.receipts_outcome.push(structuredClone(f.evidence.finalTransaction.receipts_outcome[1])); }, 'GRAPH_INVALID'],
  ['cycle', f => { f.evidence.finalTransaction.receipts_outcome[1].outcome.receipt_ids.push(f.evidence.finalTransaction.receipts_outcome[0].id); }, 'GRAPH_INVALID'],
  ['unrelated successful outcome', f => { f.evidence.finalTransaction.receipts_outcome[0].outcome.receipt_ids.shift(); }, 'GRAPH_INVALID'],
  ['unlinked success pointer', f => { f.evidence.finalTransaction.receipts_outcome[0].outcome.status.SuccessReceiptId = f.evidence.finalTransaction.transaction.hash; }, 'GRAPH_INVALID'],
  ['transaction identity substitution', f => { f.evidence.finalTransaction.transaction.hash = baseEncode(new Uint8Array(32).fill(10)); }, 'GRAPH_INVALID'],
  ['transaction executor substitution', f => { f.evidence.finalTransaction.transaction_outcome.outcome.executor_id = 'other.testnet'; }, 'GRAPH_INVALID'],
  ['duplicate full receipt ID', f => { f.evidence.receipts.push(structuredClone(f.evidence.receipts[1])); }, 'RECEIPT_MISMATCH'],
  ['full receipt ID substitution', f => { f.evidence.receipts[1].receipt_id = baseEncode(new Uint8Array(32).fill(10)); }, 'RECEIPT_MISMATCH'],
  ['wrong receipt predecessor', f => { f.evidence.receipts[1].predecessor_id = 'other.testnet'; }, 'RECEIPT_MISMATCH'],
  ['wrong receipt receiver', f => { f.evidence.receipts[1].receiver_id = 'other.testnet'; }, 'RECEIPT_MISMATCH'],
  ['wrong outcome executor', f => { f.evidence.finalTransaction.receipts_outcome[1].outcome.executor_id = 'other.testnet'; }, 'RECEIPT_MISMATCH'],
  ['wrong receipt signer', f => { f.evidence.receipts[1].receipt.Action.signer_id = 'other.testnet'; }, 'RECEIPT_MISMATCH'],
  ['root action substitution', f => { f.evidence.receipts[0].receipt.Action.actions = [{ Transfer: { deposit: '1' } }]; }, 'RECEIPT_MISMATCH'],
  ['missing native action', f => { f.evidence.receipts[1].receipt.Action.actions = []; }, 'TRANSFER_MISMATCH'],
  ['wrong native amount', f => { f.evidence.receipts[1].receipt.Action.actions[0].Transfer.deposit = '1'; }, 'TRANSFER_MISMATCH'],
  ['multiple native actions', f => { f.evidence.receipts[1].receipt.Action.actions.push({ Transfer: { deposit: '1' } }); }, 'TRANSFER_MISMATCH'],
  ['function call is not native payment', f => { f.evidence.receipts[1].receipt.Action.actions = [{ FunctionCall: { method_name: 'transfer' } }]; }, 'TRANSFER_MISMATCH'],
  ['nonempty native success value', f => { f.evidence.finalTransaction.receipts_outcome[1].outcome.status.SuccessValue = encode(true); }, 'TRANSFER_MISMATCH'],
  ['payment hidden under callback instead of exact pay', f => {
    const rows = f.evidence.finalTransaction.receipts_outcome;
    rows[0].outcome.receipt_ids = [rows[2].id]; rows[2].outcome.receipt_ids = [rows[1].id];
  }, 'TRANSFER_MISMATCH'],
  ['ambiguous duplicate payment', f => {
    const id = baseEncode(new Uint8Array(32).fill(10));
    const row = structuredClone(f.evidence.finalTransaction.receipts_outcome[1]); row.id = id;
    f.evidence.finalTransaction.receipts_outcome.push(row);
    f.evidence.finalTransaction.receipts_outcome[0].outcome.receipt_ids.push(id);
    const receipt = structuredClone(f.evidence.receipts[1]); receipt.receipt_id = id; f.evidence.receipts.push(receipt);
  }, 'AMBIGUOUS_PAYMENT'],
]) rejectsChange(`rejects ${name}`, mutate, code);

for (const [name, mutate] of [
  ['wrong callback order', f => { f.evidence.receipts[2].receipt.Action.actions[0].FunctionCall.args = encode({ order_id: 'another-order' }); }],
  ['unrelated successful callback action', f => { f.evidence.receipts[2].receipt.Action.actions[0].FunctionCall.method_name = 'stop'; }],
  ['false callback result', f => { f.evidence.finalTransaction.receipts_outcome[2].outcome.status.SuccessValue = encode(false); }],
  ['callback without Transfer dependency', f => { f.evidence.receipts[2].receipt.Action.input_data_ids = []; }],
  ['Transfer output points elsewhere', f => { f.evidence.receipts[1].receipt.Action.output_data_receivers[0].receiver_id = 'other.testnet'; }],
  ['Transfer data dependency mismatch', f => { f.evidence.receipts[1].receipt.Action.output_data_receivers[0].data_id = baseEncode(new Uint8Array(32).fill(10)); }],
]) rejectsChange(`rejects ${name}`, mutate, 'CALLBACK_MISMATCH');

for (const [name, mutate, code] of [
  ['absent pay actions', f => { delete f.evidence.finalTransaction.transaction.actions; }, 'PAY_CALL_MISMATCH'],
  ['null pay action payload', f => { f.evidence.finalTransaction.transaction.actions[0].FunctionCall = null; }, 'PAY_CALL_MISMATCH'],
  ['null native action payload', f => { f.evidence.receipts[1].receipt.Action.actions[0].Transfer = null; }, 'TRANSFER_MISMATCH'],
  ['null callback payload', f => { f.evidence.receipts[2].receipt.Action.actions[0].FunctionCall = null; }, 'CALLBACK_MISMATCH'],
  ['null receipt Action envelope', f => { f.evidence.receipts[1].receipt.Action = null; }, 'RECEIPT_MISMATCH'],
  ['null Transfer output receiver', f => { f.evidence.receipts[1].receipt.Action.output_data_receivers = [null]; }, 'CALLBACK_MISMATCH'],
  ['null final success value', f => { f.evidence.finalTransaction.status.SuccessValue = null; }, 'NOT_FINAL'],
  ['contradictory false final value', f => { f.evidence.finalTransaction.status.SuccessValue = encode(false); }, 'NOT_FINAL'],
  ['transaction status without root pointer', f => { f.evidence.finalTransaction.transaction_outcome.outcome.status = { SuccessValue: '' }; }, 'GRAPH_INVALID'],
  ['invalid block hash', f => { f.evidence.finalTransaction.receipts_outcome[1].block_hash = 'not-a-block-hash'; }, 'GRAPH_INVALID'],
  ['missing transaction signer identity', f => {
    delete f.evidence.finalTransaction.transaction.public_key;
    for (const r of f.evidence.receipts) delete r.receipt.Action.signer_public_key;
  }, 'GRAPH_INVALID'],
  ['consistently malformed receipt identity', f => {
    const old = f.evidence.receipts[1].receipt_id, invalid = 'not-a-receipt-id';
    f.evidence.receipts[1].receipt_id = invalid;
    for (const row of [f.evidence.finalTransaction.transaction_outcome, ...f.evidence.finalTransaction.receipts_outcome]) {
      if (row.id === old) row.id = invalid;
      row.outcome.receipt_ids = row.outcome.receipt_ids.map(id => id === old ? invalid : id);
    }
  }, 'GRAPH_INVALID'],
]) rejectsChange(`rejects ${name}`, mutate, code);

test('receipt/outcome ordering does not change the proof identity', () => {
  const { quote, evidence } = syntheticPayment();
  const expected = expectedProof(quote, evidence);
  evidence.receipts.reverse(); evidence.finalTransaction.receipts_outcome.reverse();
  assert.deepEqual(verifyPaymentProof(quote, evidence), expected);
});

for (const value of ['1', String(2n ** 128n - 1n)]) {
  test(`accepts exact canonical u128 boundary amount ${value}`, () => {
    const { quote, evidence } = syntheticPayment(); quote.amountAtomic = value;
    evidence.finalTransaction.transaction.actions[0].FunctionCall.args = encode({ order_id: quote.orderId, recipient: quote.vendorId, amount: value });
    evidence.receipts[1].receipt.Action.actions[0].Transfer.deposit = value;
    assert.deepEqual(verifyPaymentProof(quote, evidence), expectedProof(quote, evidence));
  });
}

test('historical captured factory pay outcome has no native action evidence and fails closed', async () => {
  const log = await readFile(new URL('../../target/mandate-factory/storage-fix/final-sandbox.log', import.meta.url), 'utf8');
  const transactions = log.split('\n').filter(line => line.includes('transaction '))
    .map(line => JSON.parse(line.split('transaction ')[1]));
  const tx = transactions.find(t => t.transaction.actions.some(a => a.FunctionCall?.method_name === 'pay') &&
    t.status.SuccessValue === encode(true));
  assert.ok(tx);
  assert.equal(Object.hasOwn(tx, 'receipts'), false);
  const args = JSON.parse(Buffer.from(tx.transaction.actions[0].FunctionCall.args, 'base64').toString());
  assert.equal(args.order_id, 'purchase'); assert.equal(args.recipient, 'vendor.sandbox');
  const quote = { networkId: 'historical-sandbox', mandateId: tx.transaction.receiver_id,
    vendorId: 'vendor.sandbox', orderId: 'purchase', amountAtomic: '3000000000000000000000000' };
  assert.throws(() => verifyPaymentProof(quote, { networkId: quote.networkId, finalTransaction: tx }),
    error => error.code === 'MISSING_ACTION_EVIDENCE' && /full RPC receipt records/.test(error.message));
});

async function capturePayment() {
  const binary = fileURLToPath(new URL('../../node_modules/near-sandbox/bin/near-sandbox-2.14.0/near-sandbox', import.meta.url));
  await access(binary); // Fail rather than downloading a missing binary.
  const previousBinary = process.env.NEAR_SANDBOX_BIN_PATH;
  process.env.NEAR_SANDBOX_BIN_PATH = binary;
  let sandbox;
  try {
    sandbox = await Sandbox.start({ version: '2.14.0' });
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
    const networkId = await provider.getNetworkId();
    const genesis = GenesisAccount.createDefault();
    const owner = new Account(genesis.accountId, provider, genesis.privateKey);
    const send = (who, receiverId, list) => who.signAndSendTransaction({ receiverId,
      actions: list, waitUntil: 'FINAL', throwOnFailure: false });
    const agentKey = KeyPair.fromRandom('ed25519');
    const agentId = `proof-agent.${owner.accountId}`;
    const vendorId = `proof-vendor.${owner.accountId}`;
    const missingId = `proof-missing.${owner.accountId}`;
    const mandateId = `proof-job.${owner.accountId}`;
    for (const [id, extra] of [[agentId, [actions.addFullAccessKey(agentKey.getPublicKey())]], [vendorId, []]]) {
      const r = await send(owner, id, [actions.createAccount(), actions.transfer(10n * ONE), ...extra]);
      assert.ok('SuccessValue' in r.status);
    }
    const deadline = BigInt((await provider.viewBlock({ finality: 'final' })).header.timestamp_nanosec) + 3600n * 10n ** 9n;
    const wasm = await readFile(new URL('../../target/mandate-wasm/u01_mandate_proof.wasm', import.meta.url));
    const created = await send(owner, mandateId, [actions.createAccount(), actions.transfer(5n * ONE),
      actions.deployContract(wasm), fc('new', { owner: owner.accountId, agent: agentId,
        allowlist: [vendorId, missingId], cap: String(10n * ONE), deadline_ns: String(deadline) }, 10n * ONE)]);
    assert.ok('SuccessValue' in created.status, JSON.stringify(created.status));
    const quote = { networkId, mandateId, vendorId, amountAtomic: String(3n * ONE), orderId: 'proof-purchase' };
    const agent = new Account(agentId, provider, agentKey.toString());
    const vendorBefore = (await provider.viewAccount({ accountId: vendorId })).amount;
    const finalTransaction = await send(agent, mandateId, [fc('pay', {
      order_id: quote.orderId, recipient: quote.vendorId, amount: quote.amountAtomic,
    })]);
    assert.equal(finalTransaction.final_execution_status, 'FINAL');
    assert.deepEqual(finalTransaction.status, { SuccessValue: encode(true) });
    assert.equal((await provider.viewAccount({ accountId: vendorId })).amount - vendorBefore, 3n * ONE);
    // Each record is the actual EXPERIMENTAL_receipt response, not an outcome
    // augmented with an invented action. Status remains in receipts_outcome.
    const receipts = await Promise.all(finalTransaction.receipts_outcome.map(r => provider.viewTransactionReceipt(r.id)));
    const failedQuote = { ...quote, vendorId: missingId, amountAtomic: String(ONE), orderId: 'proof-failed' };
    const failedTx = await send(agent, mandateId, [fc('pay', {
      order_id: failedQuote.orderId, recipient: missingId, amount: failedQuote.amountAtomic,
    })]);
    assert.equal(failedTx.final_execution_status, 'FINAL');
    assert.deepEqual(failedTx.status, { SuccessValue: encode(false) });
    assert.ok(failedTx.receipts_outcome.some(r => Object.hasOwn(r.outcome.status, 'Failure')));
    const failedReceipts = await Promise.all(failedTx.receipts_outcome.map(r => provider.viewTransactionReceipt(r.id)));
    return { quote, evidence: { networkId, finalTransaction, receipts },
      failedQuote, failedEvidence: { networkId, finalTransaction: failedTx, receipts: failedReceipts } };
  } finally {
    try { if (sandbox) await sandbox.tearDown(); }
    finally {
      if (previousBinary === undefined) delete process.env.NEAR_SANDBOX_BIN_PATH;
      else process.env.NEAR_SANDBOX_BIN_PATH = previousBinary;
    }
  }
}

test('real installed Sandbox RPC supplies verifiable native payment and failed-transfer evidence', async t => {
  const { quote, evidence, failedQuote, failedEvidence } = await capturePayment();
  const transfer = evidence.receipts.find(r => r.predecessor_id === quote.mandateId &&
    r.receiver_id === quote.vendorId && r.receipt.Action?.actions.some(a => a.Transfer?.deposit === quote.amountAtomic));
  assert.ok(transfer, 'RPC must supply full native Transfer action evidence');
  assert.ok(evidence.finalTransaction.receipts_outcome.some(r => r.id === transfer.receipt_id && r.outcome.status.SuccessValue === ''));
  assert.deepEqual(JSON.parse(Buffer.from(evidence.finalTransaction.transaction.actions[0].FunctionCall.args, 'base64').toString()), {
    order_id: quote.orderId, recipient: quote.vendorId, amount: quote.amountAtomic,
  });
  assert.deepEqual(verifyPaymentProof(quote, evidence), expectedProof(quote, evidence));
  assert.throws(() => verifyPaymentProof(failedQuote, failedEvidence), error => error.code === 'NOT_FINAL');
  // Even a lying success aggregate cannot hide the actual failed descendant.
  const lyingAggregate = structuredClone(failedEvidence);
  lyingAggregate.finalTransaction.status = { SuccessValue: encode(true) };
  assert.throws(() => verifyPaymentProof(failedQuote, lyingAggregate), error => error.code === 'GRAPH_INVALID');
  // Characterization of runtime refund admission: system transfers are not payments.
  const fakeRefund = structuredClone(evidence);
  fakeRefund.receipts.find(r => r.predecessor_id === 'system').receiver_id = quote.vendorId;
  assert.throws(() => verifyPaymentProof(quote, fakeRefund), error => error.code === 'RECEIPT_MISMATCH');
  t.diagnostic(JSON.stringify({ proof: verifyPaymentProof(quote, evidence), receiptCount: evidence.receipts.length,
    transfer, failedTransactionHash: failedEvidence.finalTransaction.transaction.hash,
    failedReceiptIds: failedEvidence.finalTransaction.receipts_outcome.filter(r => Object.hasOwn(r.outcome.status, 'Failure')).map(r => r.id) }));
});
