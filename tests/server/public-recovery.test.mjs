import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { KeyPair, baseEncode } from 'near-api-js';
import { serializeMessageNep413 } from '@meteorwallet/sdk';
import { openLocalRepository, createPublicOrders } from '../../src/server/orders.mjs';
import { createWalletSessions } from '../../src/server/wallet-session.mjs';
import { createPublicJourney } from '../../src/server/public-journey.mjs';

// Closed loopback qualification, with genuine session signatures but synthetic
// ownership/chain observations. Not hosted persistence or public wallet proof.
const origin = 'https://recovery.example';
const clock = Date.parse('2026-11-13T10:00:00Z');
const hash = baseEncode(new Uint8Array(32).fill(8));
async function fixture(t) {
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => repository.close());
  const pair = KeyPair.fromRandom('ed25519');
  const binding = { networkId: 'testnet', ownerId: 'alice.testnet', signerId: 'agent.testnet', mandateId: 'mandate.testnet',
    publicKey: pair.getPublicKey().toString(), maxAllowanceAtomic: '1000', codeHash: hash };
  const manifest = { manifestId: 'approved', ownerId: binding.ownerId,
    approved: { job: { networkId: 'testnet', mandateId: binding.mandateId, purpose: 'Fictional supplier', output: 'Report',
      budgetAtomic: '30', vendorIds: ['vendor.testnet'], expiresAt: '2026-11-13T18:00:00Z' },
      quote: { networkId: 'testnet', mandateId: binding.mandateId, vendorId: 'vendor.testnet', amountAtomic: '8', orderId: 'one', content: 'Fictional sample' } },
    binding, rpcUrl: 'https://no-network.invalid', allowedRpcUrls: ['https://no-network.invalid'],
    chainEvidence: { networkId: 'testnet', finality: 'final', blockHash: hash, blockHeight: 123, observedAt: clock } };
  const trustedAccessKeyReader = async ({ accountId, publicKey }) => ({ networkId: 'testnet', accountId, publicKey,
    permission: 'FullAccess', finality: 'final', blockHeight: 123, blockHash: hash, observedAt: clock });
  const config = { repository, approvedOrigin: origin, approvedRecipient: 'recovery.example', trustedAccessKeyReader, now: () => clock };
  const sessions = createWalletSessions(config);
  async function login(accountId) {
    const challenge = await sessions.issueChallenge({ accountId, origin, networkId: 'testnet' });
    const signed = pair.sign(serializeMessageNep413({ ...challenge.payload, nonce: Buffer.from(challenge.payload.nonce, 'base64') }));
    const result = await sessions.verifyChallenge({ accountId, origin, networkId: 'testnet', challengeId: challenge.challengeId,
      publicKey: pair.getPublicKey().toString(), signature: Buffer.from(signed.signature).toString('base64') });
    return `__Host-haldir_session=${result.token}`;
  }
  const cookie = await login('alice.testnet'), foreignCookie = await login('bob.testnet');
  const orders = createPublicOrders({ repository, now: () => clock, trustedManifestProvider: async () => manifest });
  const job = await orders.createJob({ ownerId: 'alice.testnet', approvalId: 'approved', admissionKey: 'one' });
  const effects = { prepare: 0, reconcile: 0, model: 0, signer: 0, manifest: 0 };
  const ownerOperations = {
    prepare: async ({ action, ownerId }) => { effects.prepare++; return { network: 'testnet', signerId: ownerId,
      receiverId: binding.mandateId, methodName: action, args: {}, gas: '100000000000000', deposit: '0' }; },
    reconcile: async input => { effects.reconcile++; return { networkId: 'testnet', ownerId: input.ownerId,
      mandateId: binding.mandateId, action: input.action, transactionHash: input.transactionHash,
      signerId: input.signerId, finality: 'final', status: 'CONFIRMED', receiptId: hash,
      ...(input.action === 'withdraw' ? { amountAtomic: '22' } : {}) }; },
  };
  let app = createPublicJourney({ ...config, capabilities: { publicTestnet: true }, ownerOperations });
  const server = createServer((req, res) => app.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = (path, body = {}, options = {}) => new Promise((resolve, reject) => {
    const headers = { host: 'recovery.example', origin, 'x-haldir-csrf': '1', 'content-type': 'application/json', cookie, ...options.headers };
    for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path,
      method: options.method ?? 'POST', headers }, res => {
      const chunks = []; res.on('data', part => chunks.push(part));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject); req.end(options.method === 'GET' ? undefined : JSON.stringify(body));
  });
  return { send, effects, repository, manifest, foreignCookie, job, path: `/api/public/jobs/${job.jobId}`,
    enable() { app = createPublicJourney({ ...config, ownerOperations,
      capabilities: { publicTestnet: true, financialActions: true, qualifiedModel: true, qualifiedSigning: true },
      trustedManifestProvider: async () => { effects.manifest++; return manifest; },
      model: { propose: async () => { effects.model++; throw new Error('No real model'); } },
      trustedSignerProvider: async () => { effects.signer++; throw new Error('No real signer'); } }); },
    disableOwner() { app = createPublicJourney({ ...config, capabilities: { publicTestnet: true } }); },
    disableNetwork() { app = createPublicJourney({ ...config, ownerOperations }); },
  };
}

test('browser-safe POST read retains session/Origin/CSRF/ownership guards when new spending is closed', async t => {
  const h = await fixture(t);
  const read = await h.send(h.path);
  assert.equal(read.status, 200);
  assert.equal(read.body.job.jobId, h.job.jobId);
  assert.equal(read.body.job.ownerId, 'alice.testnet');
  assert.equal(read.body.job.ownerCreationRequired, false, 'legacy admitted child is already deployed');
  assert.deepEqual(read.body.ownerApproval, {
    manifestId: 'approved', jobId: h.job.jobId, ownerId: 'alice.testnet', mandateId: 'mandate.testnet',
    actions: {
      create: null,
      stop: { network: 'testnet', owner: 'alice.testnet', mandate: 'mandate.testnet', kind: 'stop', gas: '100000000000000' },
      withdraw: { network: 'testnet', owner: 'alice.testnet', mandate: 'mandate.testnet', kind: 'withdraw', gas: '100000000000000' },
    },
  });
  assert.deepEqual((await h.send(h.path, {}, { method: 'GET' })).body, read.body);
  assert.equal((await h.send(h.path, {}, { method: 'GET', headers: { origin: undefined } })).status, 403);
  assert.equal((await h.send(h.path, {}, { headers: { origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await h.send(h.path, {}, { headers: { 'x-haldir-csrf': '0' } })).status, 403);
  assert.equal((await h.send(h.path, {}, { headers: { cookie: h.foreignCookie } })).status, 404);
  assert.equal((await h.send(h.path, {}, { headers: { cookie: '' } })).status, 401);
  assert.equal((await h.send(h.path, { ownerId: 'alice.testnet' })).status, 400);
  assert.deepEqual(h.effects, { prepare: 0, reconcile: 0, model: 0, signer: 0, manifest: 0 });
});

test('existing owner stop/refund and receipt recovery do not depend on model or agent-signer readiness', async t => {
  const h = await fixture(t);
  assert.equal((await h.send('/api/public/config')).body.financialActions, false);
  const stop = await h.send(`${h.path}/owner/prepare`, { action: 'stop' });
  assert.equal(stop.status, 200);
  assert.equal(stop.body.operation.status, 'AWAITING_WALLET');
  assert.equal(stop.body.walletEligible, true);
  assert.equal(stop.body.operation.preparation.state, 'ISSUED');
  const retry = { action: 'stop', operationId: stop.body.operation.operationId, attemptId: stop.body.operation.preparation.attemptId };
  const lookup = await h.send(`${h.path}/owner/retry-prepare`, retry);
  assert.equal(lookup.status, 200); assert.equal(lookup.body.walletEligible, false);
  assert.deepEqual(lookup.body.operation, stop.body.operation);
  const receipt = await h.send(`${h.path}/owner/receipt`, { operationId: stop.body.operation.operationId,
    signerId: 'alice.testnet', transactionHash: hash });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.operation.status, 'CONFIRMED');
  const withdraw = await h.send(`${h.path}/owner/prepare`, { action: 'withdraw' });
  assert.equal(withdraw.status, 200);
  const refundHash = baseEncode(new Uint8Array(32).fill(9));
  const refund = await h.send(`${h.path}/owner/receipt`, { operationId: withdraw.body.operation.operationId,
    signerId: 'alice.testnet', transactionHash: refundHash });
  assert.equal(refund.status, 200);
  assert.equal(refund.body.operation.receipt.amountAtomic, '22');
  for (const route of ['run', 'resume']) assert.equal((await h.send(`${h.path}/${route}`)).status, 503);
  assert.equal((await h.send(`${h.path}/owner/prepare`, { action: 'create' })).status, 503);
  assert.equal((await h.send('/api/public/jobs', { approvalId: 'approved', admissionKey: 'two' })).status, 503);
  assert.equal(h.effects.signer, 0); assert.equal(h.effects.model, 0); assert.equal(h.effects.manifest, 0);
  const before = { ...h.effects };
  assert.equal((await h.send(`${h.path}/owner/prepare`, { action: 'stop' }, { headers: { cookie: h.foreignCookie } })).status, 404);
  assert.deepEqual(h.effects, before);
  h.disableOwner();
  assert.equal((await h.send(`${h.path}/owner/prepare`, { action: 'stop' })).status, 503);
  assert.equal((await h.send(`${h.path}/owner/retry-prepare`, retry)).status, 503);
  h.disableNetwork();
  assert.equal((await h.send(`${h.path}/owner/prepare`, { action: 'stop' })).status, 503);
  assert.equal((await h.send(`${h.path}/owner/retry-prepare`, retry)).status, 503);
});

test('factory-ready admission cannot reserve payment or invoke a model before owner creation is observed', async t => {
  const h = await fixture(t);
  // Isolated state-fence fixture, NOT a complete admission/chain qualification.
  await h.repository.runTransaction(async tx => {
    const job = await tx.get('jobs', h.job.jobId);
    job.publicManifest.chainEvidence.deployment = 'FACTORY_READY';
    tx.set('jobs', job.jobId, job);
  });
  assert.equal((await h.send(h.path)).body.job.ownerCreationRequired, true);
  h.enable();
  for (const route of ['run', 'resume']) {
    const response = await h.send(`${h.path}/${route}`);
    assert.equal(response.status, 409);
    assert.equal(response.body.error, 'OWNER_CREATION_REQUIRED');
  }
  assert.equal(h.effects.signer, 0); assert.equal(h.effects.model, 0);
  await h.repository.runTransaction(async tx => {
    assert.equal(await tx.get('nativeOperations', h.job.quoteId), null);
    assert.equal(await tx.get('publicRunGuards', h.job.jobId), null);
  });
  const operationId = createHash('sha256').update(JSON.stringify(['haldir-owner-v1', h.job.jobId, 'create'])).digest('hex');
  await h.repository.runTransaction(async tx => tx.create('ownerOperations', operationId,
    { operationId, jobId: h.job.jobId, ownerId: 'alice.testnet', action: 'create', status: 'CONFIRMED',
      transactionHash: hash, receipt: { status: 'CONFIRMED', finality: 'final', networkId: 'testnet',
        ownerId: 'alice.testnet', mandateId: h.manifest.binding.mandateId, action: 'create', transactionHash: hash, signerId: 'alice.testnet' } }));
  // The creation fence now permits the configured signer boundary, which is
  // deliberately unavailable. No claim that this synthetic receipt is live.
  const after = await h.send(`${h.path}/run`);
  assert.equal(after.status, 503);
  assert.equal(after.body.error, 'PROVIDER_UNAVAILABLE');
  assert.equal(h.effects.signer, 1); assert.equal(h.effects.model, 0);
});
