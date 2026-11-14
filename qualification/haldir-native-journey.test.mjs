import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Sandbox, GenesisAccount } from 'near-sandbox';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, baseEncode } from 'near-api-js';
import { createNearMandateExecution } from '../src/server/near-mandate.mjs';
import { createNearReceiptCollector } from '../src/server/near-receipts.mjs';
import { createOrders, openLocalRepository } from '../src/server/orders.mjs';
import { createJobRunner } from '../src/agent/run-job.mjs';
import { verifyPaymentProof } from '../src/vendor/payment-proof.mjs';

const ONE = 10n ** 24n, CAP = 10n * ONE, FLOAT = 5n * ONE, PRICE = 3n * ONE;
const GAS = 100_000_000_000_000n;
const fc = (method, args = {}, deposit = 0n, gas = GAS) => actions.functionCall(method, args, gas, deposit);
const ok = r => r?.status && 'SuccessValue' in r.status;
const jsonValue = r => JSON.parse(Buffer.from(r.status.SuccessValue, 'base64'));
const operationId = quoteId => createHash('sha256').update(JSON.stringify(['haldir-agent-payment-v1', quoteId])).digest('hex');

// EXPLICIT TEST-ONLY provider adapter, not the public testnet collector.
// No fabricated receipts, chain relabeling, synthetic payment evidence or fallback.
// Equivalent reads/identity/finality/receipt cap + unchanged causal verifier.
function localReceiptCollector({ rpcUrl, provider, chainId, loadOperation, localTestOnly }) {
  assert.equal(localTestOnly, true); assert.equal(new URL(rpcUrl).hostname, '127.0.0.1');
  assert.notEqual(chainId, 'testnet');
  return async request => {
    const until = performance.now() + 10000;
    const read = async fn => {
      assert.ok(performance.now() < until, 'local receipt collection deadline');
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('local receipt collection timeout')), Math.max(1, until - performance.now())); });
        const value = await Promise.race([Promise.resolve().then(fn), timeout]);
        assert.ok(performance.now() < until, 'local receipt collection deadline'); return value;
      } finally { clearTimeout(timer); }
    };
    const op = await read(() => loadOperation(request));
    if (!op) return null;
    assert.deepEqual(op.quote, request.quote);
    assert.equal(op.ownerId, request.ownerId); assert.equal(op.jobId, request.jobId);
    assert.equal(op.networkId, chainId);
    const node = await read(() => provider.viewNodeStatus());
    assert.equal(node.chain_id, chainId); assert.notEqual(node.sync_info.syncing, true);
    const tx = await read(() => provider.viewTransactionStatusWithReceipts({ txHash: op.transactionHash, accountId: op.signerId, waitUntil: 'FINAL' }));
    assert.equal(tx.transaction.hash, op.transactionHash); assert.equal(tx.transaction.signer_id, op.signerId);
    assert.equal(tx.final_execution_status, 'FINAL'); assert.ok(tx.receipts_outcome.length <= 64);
    const receipts = [];
    for (const r of tx.receipts_outcome) receipts.push(await read(() => provider.viewTransactionReceipt(r.id)));
    const evidence = { networkId: node.chain_id, finalTransaction: tx, receipts };
    verifyPaymentProof(request.quote, evidence);
    return evidence;
  };
}

test('LOCAL SANDBOX: verified loopback createJob admission -> real factory/keyless mandate -> restricted agent -> durable ambiguous-send recovery -> orders claim/delivery/runner -> owner stop/withdraw', { timeout: 120000 }, async t => {
  assert.equal(process.versions.node, '26.13.0');
  const sandbox = await Sandbox.start({ version: '2.14.0' });
  const dir = await mkdtemp(join(process.env.TMPDIR, 'haldir-native-journey-'));
  let repository;
  try {
    assert.equal(new URL(sandbox.rpcUrl).hostname, '127.0.0.1');
    const provider = new JsonRpcProvider({ url: sandbox.rpcUrl }, { retries: 1 });
    const chainId = (await provider.viewNodeStatus()).chain_id;
    assert.notEqual(chainId, 'testnet');
    const genesis = GenesisAccount.createDefault();
    const root = new Account(genesis.accountId, provider, genesis.privateKey);
    const send = (who, receiverId, list) => who.signAndSendTransaction({ receiverId, actions: list, waitUntil: 'FINAL', throwOnFailure: false });
    async function role(name) {
      const bootstrap = KeyPair.fromRandom('ed25519'); // ephemeral Sandbox ONLY
      const accountId = `${name}.${root.accountId}`;
      assert.ok(ok(await send(root, accountId, [actions.createAccount(), actions.transfer(200n * ONE), actions.addFullAccessKey(bootstrap.getPublicKey())])));
      return { account: new Account(accountId, provider, bootstrap.toString()), bootstrap };
    }
    const owner = (await role('owner')).account, vendor = (await role('vendor')).account;
    const agent = await role('agent'), factory = await role('factory');
    const mandateWasm = await readFile(new URL('../target/mandate-wasm/u01_mandate_proof.wasm', import.meta.url));
    const factoryWasm = await readFile(new URL('../target/mandate-factory-wasm/u01_mandate_factory.wasm', import.meta.url));
    assert.ok(ok(await send(factory.account, factory.account.accountId, [actions.deployContract(factoryWasm), fc('new', { max_jobs: 8 }), actions.deleteKey(factory.bootstrap.getPublicKey())])));
    const keys = accountId => provider.query({ request_type: 'view_access_key_list', account_id: accountId, finality: 'final' });
    assert.deepEqual((await keys(factory.account.accountId)).keys, []);
    const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args, blockQuery: { finality: 'final' } });
    const balance = async accountId => (await provider.viewAccount({ accountId, blockQuery: { finality: 'final' } })).amount;
    const block = await provider.viewBlock({ finality: 'final' });
    const expiresAt = new Date(Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n) + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const deadline_ns = String(BigInt(Date.parse(expiresAt)) * 1_000_000n);
    const label = 'native-journey';
    const child = 'j' + createHash('sha256').update(`${owner.accountId}:${label}`).digest('hex').slice(0, 32) + '.' + factory.account.accountId;
    const creation = await send(owner, factory.account.accountId, [fc('create_job', { job_label: label, agent: agent.account.accountId,
      allowlist: [vendor.accountId], cap: String(CAP), deadline_ns, operating_float: String(FLOAT) }, CAP + FLOAT, 300_000_000_000_000n)]);
    assert.ok(ok(creation)); assert.equal(jsonValue(creation), true);
    assert.ok(creation.receipts_outcome.every(r => !('Failure' in r.outcome.status)));
    assert.deepEqual(await view(factory.account.accountId, 'get_entry', { owner: owner.accountId, job_label: label }),
      { job: child, owner: owner.accountId, amount: String(CAP + FLOAT), state: 'ready' });
    assert.deepEqual((await keys(child)).keys, []);
    const code = await provider.query({ request_type: 'view_code', account_id: child, finality: 'final' });
    assert.deepEqual(Buffer.from(code.code_base64, 'base64'), mandateWasm);
    const codeHash = baseEncode(createHash('sha256').update(mandateWasm).digest());
    assert.equal((await provider.query({ request_type: 'view_account', account_id: child, finality: 'final' })).code_hash, codeHash);
    const executionKey = KeyPair.fromRandom('ed25519');
    const allowance = 2n * ONE;
    assert.ok(ok(await send(agent.account, agent.account.accountId, [actions.addFunctionCallAccessKey(executionKey.getPublicKey(), child, ['pay'], allowance), actions.deleteKey(agent.bootstrap.getPublicKey())])));
    const readKeys = await keys(agent.account.accountId);
    assert.deepEqual(readKeys.keys.map(k => ({ public_key: k.public_key, permission: k.access_key.permission })),
      [{ public_key: executionKey.getPublicKey().toString(), permission: { FunctionCall: { receiver_id: child, method_names: ['pay'], allowance: String(allowance) } } }]);

    const filename = join(dir, 'existing-orders.sqlite');
    repository = openLocalRepository({ filename, localTestOnly: true });
    const scope = { networkId: chainId, mandateId: child, purpose: 'Check fictional supplier before signing', output: 'Evidence-linked supplier report',
      budgetAtomic: String(CAP), vendorIds: [vendor.accountId], expiresAt };
    const quote = { networkId: chainId, mandateId: child, vendorId: vendor.accountId, amountAtomic: String(PRICE), orderId: 'registry-1', content: 'Fictional registry sample' };
    const unsupportedAdmission = createOrders({ repository, localTestOnly: true });
    await assert.rejects(unsupportedAdmission.createJob({ ownerId: owner.accountId, admissionKey: 'sandbox-actual-chain', approved: { job: scope, quote } }), { code: 'INVALID_APPROVAL' });
    const trustedLocalChain = { networkId: chainId, rpcUrl: sandbox.rpcUrl };
    const admissionOrders = createOrders({ repository, localTestOnly: true, trustedLocalChain });
    const admissionRequest = { ownerId: owner.accountId, admissionKey: 'sandbox-actual-chain', approved: { job: scope, quote } };
    const job = await admissionOrders.createJob(admissionRequest);
    assert.deepEqual(await admissionOrders.createJob(admissionRequest), job);
    assert.deepEqual(await admissionOrders.getJob({ ownerId: owner.accountId, jobId: job.jobId }), job);
    const tuple = (...values) => Buffer.from(JSON.stringify(['haldir-local-v1', ...values])).toString('base64url');
    const admission = await repository.runTransaction(tx => tx.get('admissions', tuple(owner.accountId, admissionRequest.admissionKey)));
    assert.deepEqual(admission, { ...admissionRequest, jobId: job.jobId });
    assert.equal((await repository.runTransaction(tx => tx.get('mandates', tuple(chainId, child)))).jobId, job.jobId);
    for (const networkId of ['mainnet', 'testnet', 'test-chain-wrong']) {
      await assert.rejects(admissionOrders.createJob({ ...admissionRequest,
        approved: { job: { ...scope, networkId }, quote: { ...quote, networkId } } }), { code: 'INVALID_APPROVAL' });
    }
    const wrongChainAdmission = createOrders({ repository, localTestOnly: true,
      trustedLocalChain: { networkId: 'test-chain-wrong', rpcUrl: sandbox.rpcUrl } });
    await assert.rejects(wrongChainAdmission.createJob({ ...admissionRequest,
      approved: { job: { ...scope, networkId: 'test-chain-wrong' }, quote: { ...quote, networkId: 'test-chain-wrong' } } }),
    { code: 'LOCAL_CHAIN_MISMATCH' });
    const input = { ownerId: owner.accountId, jobId: job.jobId };
    const binding = { networkId: chainId, ownerId: owner.accountId, signerId: agent.account.accountId, mandateId: child,
      publicKey: executionKey.getPublicKey().toString(), maxAllowanceAtomic: String(allowance), codeHash };
    let signs = 0, broadcasts = 0, crashAfterSend = true;
    const keySigner = new KeyPairSigner(executionKey);
    const restrictedSigner = { getPublicKey: () => keySigner.getPublicKey(), signTransaction: tx => { signs++; return keySigner.signTransaction(tx); } };
    const executionProvider = new Proxy(provider, { get(target, property) {
      if (property === 'sendTransactionUntil') return async (signed, finality) => {
        broadcasts++;
        const persisted = await repository.runTransaction(tx => tx.get('nativeOperations', job.quoteId));
        assert.equal(persisted.signedTransaction, Buffer.from(signed.encode()).toString('base64'));
        assert.equal(persisted.phase, 'BROADCAST_INTENT');
        await target.sendTransactionUntil(signed, finality);
        throw new Error('TEST ONLY: real chain accepted; broadcaster response lost');
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const adapter = () => createNearMandateExecution({ repository, binding, signer: restrictedSigner, provider: executionProvider,
      rpcUrl: sandbox.rpcUrl, localTestOnly: true, timeoutMs: 30000 });
    let paymentExecution = adapter();
    const makeOrders = () => createOrders({ repository, localTestOnly: true, trustedLocalChain,
      trustedReceiptCollector: localReceiptCollector({ rpcUrl: sandbox.rpcUrl, provider, chainId, localTestOnly: true,
        loadOperation: request => paymentExecution.loadOperation(request) }) });
    let orders = makeOrders();
    // LABELLED DETERMINISTIC MODEL FIXTURE ONLY; no model provider/credentials.
    const modelPhases = [];
    const model = { async propose(r) {
      modelPhases.push(r.phase);
      return r.phase === 'plan' ? { tool: 'requestquote', arguments: structuredClone(r.approvedQuote) } :
        { findings: r.evidence.map(e => ({ artifactId: e.artifactId, excerpt: e.content })) };
    } };
    const crashingRepository = { runTransaction: callback => repository.runTransaction(tx => callback({ ...tx, set(collection, key, value) {
      if (crashAfterSend && collection === 'agentRuns' && value.stage === 'PAYMENT_RECONCILING') {
        crashAfterSend = false; throw new Error('TEST ONLY: runner process crash after ambiguous send before run acknowledgment');
      }
      tx.set(collection, key, value);
    } })) };
    const vendorBefore = await balance(vendor.accountId);
    await assert.rejects(createJobRunner({ repository: crashingRepository, orders, model, paymentExecution }).runJob(input), /runner process crash/);
    const durableOp = await repository.runTransaction(tx => tx.get('nativeOperations', job.quoteId));
    assert.ok(durableOp.transactionHash); assert.ok(durableOp.signedTransaction);
    assert.equal((await repository.runTransaction(tx => tx.get('agentRuns', job.jobId))).stage, 'PAYMENT_SUBMITTING');
    assert.equal(await balance(vendor.accountId), vendorBefore + PRICE);
    repository.close(); repository = openLocalRepository({ filename, localTestOnly: true });
    paymentExecution = adapter(); orders = makeOrders();
    const result = await createJobRunner({ repository, orders, model, paymentExecution }).runJob(input);
    assert.equal(result.stage, 'COMPLETE'); assert.equal(result.report.supplierVerified, false);
    assert.equal(result.report.fictionalSample, true); assert.equal(result.report.qualification, 'LOCAL_SYNTHETIC_ONLY');
    assert.equal(result.report.purchase.lifecycle, 'DELIVERED'); assert.ok(result.report.purchase.proofId);
    assert.deepEqual(modelPhases, ['plan', 'report']);
    const delivered = await orders.getOrder(input);
    const claim = await repository.runTransaction(tx => tx.get('claims', delivered.proof.proofId));
    assert.equal(claim.jobId, job.jobId); assert.deepEqual(claim.proof, delivered.proof);
    assert.equal(delivered.proof.transactionHash, durableOp.transactionHash);
    assert.equal(result.report.findings[0].proofId, delivered.proof.proofId);
    assert.equal(result.report.findings[0].contentDigest, delivered.artifact.contentDigest);
    await createJobRunner({ repository, orders, model, paymentExecution }).runJob(input);
    const paymentRequest = { operationId: operationId(job.quoteId), approvedJobInput: result.approvedJobInput, quote };
    await paymentExecution.submit(paymentRequest); await paymentExecution.lookup(paymentRequest);
    assert.equal(signs, 1); assert.equal(broadcasts, 1);
    assert.equal(await balance(vendor.accountId), vendorBefore + PRICE);
    // Wrong scope never becomes a second operation.
    await assert.rejects(paymentExecution.submit({ ...paymentRequest, quote: { ...quote, amountAtomic: '1' } }), { code: 'APPROVAL_MISMATCH' });
    const publicCollector = createNearReceiptCollector({ rpcUrl: 'https://rpc.testnet.near.org', allowedRpcUrls: ['https://rpc.testnet.near.org'] });
    let publicRpcAttempts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { publicRpcAttempts++; throw new Error('PUBLIC RPC DENIED in local qualification'); };
    try {
      for (const networkId of [chainId, 'mainnet']) {
        const forbiddenQuote = { ...quote, networkId };
        assert.deepEqual(await publicCollector.collect({ ...input, quote: forbiddenQuote,
          operation: { ...durableOp, networkId, quote: forbiddenQuote } }),
        { status: 'unresolved', code: 'OPERATION_BINDING_INVALID' });
      }
      assert.equal(publicRpcAttempts, 0);
    } finally { globalThis.fetch = originalFetch; }

    // Real owner stop/withdraw are separate owner-signed Sandbox transactions;
    // never injected into runner/model/execution capability and never public keys.
    const ownerStop = await send(owner, child, [fc('stop')]);
    assert.ok(ok(ownerStop));
    assert.equal((await view(child, 'get_status')).stopped, true);
    const restrictedAccount = new Account(agent.account.accountId, provider, executionKey.toString());
    const denied = await send(restrictedAccount, child, [fc('pay', { order_id: 'after-stop', recipient: vendor.accountId, amount: '1' })]);
    assert.match(JSON.stringify(denied.status), /STOPPED/);
    const ownerBefore = await balance(owner.accountId);
    const withdrawal = await send(owner, child, [fc('withdraw')]);
    assert.ok(ok(withdrawal)); assert.equal(jsonValue(withdrawal), true);
    const refundReceived = (await balance(owner.accountId)) - ownerBefore;
    assert.ok(refundReceived > CAP - PRICE - ONE / 10n && refundReceived <= CAP - PRICE);
    const settled = await view(child, 'get_status');
    assert.deepEqual([settled.spent, settled.refunded, settled.reserved, settled.free], [PRICE, CAP - PRICE, 0n, 0n].map(String));
    assert.deepEqual(settled.orders, [{ order_id: quote.orderId, recipient: vendor.accountId, amount: String(PRICE), state: 'paid' }]);
    assert.deepEqual((await keys(child)).keys, []);
    assert.equal(await balance(vendor.accountId), vendorBefore + PRICE);

    // A separate genuine factory-created mandate proves adapter-side stop denial
    // on a fresh valid admitted operation (not merely contract failure afterward).
    const stoppedAgent = await role('stoppedagent');
    const stoppedLabel = 'stopped-journey';
    const stoppedChild = 'j' + createHash('sha256').update(`${owner.accountId}:${stoppedLabel}`).digest('hex').slice(0, 32) + '.' + factory.account.accountId;
    const stoppedCreation = await send(owner, factory.account.accountId, [fc('create_job', { job_label: stoppedLabel,
      agent: stoppedAgent.account.accountId, allowlist: [vendor.accountId], cap: String(CAP), deadline_ns,
      operating_float: String(FLOAT) }, CAP + FLOAT, 300_000_000_000_000n)]);
    assert.ok(ok(stoppedCreation)); assert.equal(jsonValue(stoppedCreation), true);
    const stoppedKey = KeyPair.fromRandom('ed25519');
    assert.ok(ok(await send(stoppedAgent.account, stoppedAgent.account.accountId,
      [actions.addFunctionCallAccessKey(stoppedKey.getPublicKey(), stoppedChild, ['pay'], allowance), actions.deleteKey(stoppedAgent.bootstrap.getPublicKey())])));
    assert.ok(ok(await send(owner, stoppedChild, [fc('stop')])));
    const stoppedScope = { ...scope, mandateId: stoppedChild }, stoppedQuote = { ...quote, mandateId: stoppedChild };
    const stoppedJob = await orders.createJob({ ownerId: owner.accountId, admissionKey: 'stopped-sandbox-chain',
      approved: { job: stoppedScope, quote: stoppedQuote } });
    let stoppedSigns = 0;
    const stoppedSigner = new KeyPairSigner(stoppedKey);
    const stoppedAdapter = createNearMandateExecution({ repository, binding: { ...binding, mandateId: stoppedChild,
      signerId: stoppedAgent.account.accountId, publicKey: stoppedKey.getPublicKey().toString() },
      signer: { getPublicKey: () => stoppedSigner.getPublicKey(), signTransaction: tx => { stoppedSigns++; return stoppedSigner.signTransaction(tx); } },
      provider, rpcUrl: sandbox.rpcUrl, localTestOnly: true });
    await assert.rejects(stoppedAdapter.submit({ operationId: operationId(stoppedJob.quoteId), quote: stoppedQuote,
      approvedJobInput: { jobId: stoppedJob.jobId, ownerId: stoppedJob.ownerId, quoteId: stoppedJob.quoteId,
        qualification: stoppedJob.qualification, ...stoppedScope } }), { code: 'MANDATE_CLOSED' });
    assert.equal(stoppedSigns, 0);
    const stoppedOp = await repository.runTransaction(tx => tx.get('nativeOperations', stoppedJob.quoteId));
    assert.equal(stoppedOp.phase, 'RESERVED'); assert.equal(stoppedOp.transactionHash, undefined);
    assert.equal((await view(stoppedChild, 'get_status')).spent, '0');
    assert.equal(await balance(vendor.accountId), vendorBefore + PRICE);
    assert.ok(ok(await send(owner, stoppedChild, [fc('withdraw')])));

    t.diagnostic(JSON.stringify({ qualification: 'LOCAL_SANDBOX_REAL_CHAIN_ONLY; DETERMINISTIC_MODEL_FIXTURE; FICTIONAL_DELIVERY', chainId,
      admission: { path: 'createOrders.createJob; explicit trustedLocalChain; actual loopback status verified', trustedLocalChain,
        jobId: job.jobId, quoteId: job.quoteId, record: admission, replaySameIdentity: true,
        wrongApprovalChain: 'INVALID_APPROVAL', wrongActualChain: 'LOCAL_CHAIN_MISMATCH' },
      publicGuard: { sandboxAndMainnet: 'OPERATION_BINDING_INVALID', rpcAttempts: publicRpcAttempts }, child, factory: factory.account.accountId,
      creationHash: creation.transaction.hash, paymentHash: durableOp.transactionHash, proof: delivered.proof,
      runnerStage: result.stage, vendorBalanceIncrease: String((await balance(vendor.accountId)) - vendorBefore),
      stopHash: ownerStop.transaction.hash, afterStopPayHash: denied.transaction.hash, afterStopPayStatus: denied.status,
      withdrawalHash: withdrawal.transaction.hash, refundReceived: String(refundReceived), settled, signs, broadcasts,
      stoppedDenial: { child: stoppedChild, signs: stoppedSigns, journalPhase: stoppedOp.phase, spent: '0', code: 'MANDATE_CLOSED' },
      report: result.report, mandateWasmSha256: createHash('sha256').update(mandateWasm).digest('hex'), factoryWasmSha256: createHash('sha256').update(factoryWasm).digest('hex') }));
  } finally {
    repository?.close(); await sandbox.tearDown(); await rm(dir, { recursive: true, force: true });
  }
});
