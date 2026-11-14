import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createServer, request as httpRequest } from 'node:http';
import { KeyPair, KeyPairSigner, SignedTransaction, baseEncode } from 'near-api-js';
import { createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { createNearAiModel } from '../../deployment/haldir-public/near-ai-model.mjs';
import { createNearAiTransport } from '../../deployment/haldir-public/near-ai-transport.mjs';
import { verifiedCompletion } from '../../deployment/haldir-public/near-ai-worker.mjs';
import { createTrustedAgentSignerProvider } from '../../deployment/haldir-public/agent-signer.mjs';
import { approvedInput, approvedSources } from '../../src/shared/job-contract.mjs';
import { NEAR_AI_RELEASE, NEAR_AI_MODEL, NEAR_AI_ENDPOINT } from '../../deployment/haldir-public/near-ai-policy.mjs';
import { syntheticPayment } from '../../src/vendor/fixture.mjs';
import { serializeMessageNep413 } from '@meteorwallet/sdk';
import * as ordersModule from '../../src/server/orders.mjs';
import { createWalletSessions } from '../../src/server/wallet-session.mjs';
import { openFirestoreRepository } from '../../deployment/haldir-preview/firestore-repository.mjs';
const require = createRequire(new URL('../../deployment/haldir-preview/package.json', import.meta.url));
const { Firestore } = require('@google-cloud/firestore');
const origin = 'https://haldir.example';
const time = Date.parse('2026-11-13T10:00:00Z');
const hash = baseEncode(new Uint8Array(32).fill(7));
const agentKey = KeyPair.fromRandom('ed25519');
function manifest(ownerId = 'alice.testnet', suffix = '') {
  const mandateId = `mandate${suffix}.testnet`;
  return { manifestId: `approved${suffix}`, ownerId,
    approved: { job: { networkId: 'testnet', mandateId, purpose: 'Review fictional supplier', output: 'Evidence report',
      budgetAtomic: '30', vendorIds: ['vendor.testnet'], expiresAt: '2026-11-13T18:00:00Z' },
    quote: { networkId: 'testnet', mandateId, vendorId: 'vendor.testnet', amountAtomic: '8', orderId: 'quote-1', content: 'Fictional sample' } },
    binding: { networkId: 'testnet', ownerId, signerId: 'agent.testnet', mandateId,
      publicKey: agentKey.getPublicKey().toString(), maxAllowanceAtomic: '1000', codeHash: hash },
    rpcUrl: 'https://offline-native.invalid', allowedRpcUrls: ['https://offline-native.invalid'],
    chainEvidence: { networkId: 'testnet', finality: 'final', blockHash: hash, blockHeight: 123, observedAt: time } };
}
// The actual hosted repository + SDK transaction/serialization port executes.
// Closed protobuf storage boundary only: NOT an emulator or hosted database.
function firestore(t, shared = { records: new Map(), version: 0 }) {
  const stamp = { seconds: '1', nanos: 0 }, transactions = new Map();
  let serial = 0, conflicts = 0;
  t.mock.method(Firestore.prototype, 'initializeIfNeeded', async function () {});
  t.mock.method(Firestore.prototype, 'requestStream', async function (method, bidi, request) {
    assert.equal(method, 'batchGetDocuments'); assert.equal(bidi, false);
    let transaction = request.transaction;
    if (request.newTransaction) { transaction = Buffer.from(String(++serial)); transactions.set(transaction.toString(), { records: new Map(shared.records), version: shared.version }); }
    const records = transaction ? transactions.get(Buffer.from(transaction).toString()).records : shared.records;
    return Readable.from(request.documents.map(name => ({ ...(records.has(name) ? { found: records.get(name) } : { missing: name }), readTime: stamp, ...(transaction ? { transaction } : {}) })), { objectMode: true });
  });
  t.mock.method(Firestore.prototype, 'request', async function (method, request) {
    assert.ok(['commit', 'rollback'].includes(method));
    if (method === 'rollback') { transactions.delete(Buffer.from(request.transaction).toString()); return {}; }
    await shared.onCommit?.(request);
    const snapshot = request.transaction && transactions.get(Buffer.from(request.transaction).toString());
    if (snapshot && snapshot.version !== shared.version) { conflicts++; throw Object.assign(new Error('synthetic conflict'), { code: 10 }); }
    const next = new Map(shared.records);
    for (const w of request.writes) {
      assert.ok(w.update && !w.delete && !w.transform);
      if (w.currentDocument?.exists === false && next.has(w.update.name)) throw Object.assign(new Error('exists'), { code: 6 });
      next.set(w.update.name, { ...structuredClone(w.update), createTime: stamp, updateTime: stamp });
    }
    shared.records = next; if (request.writes.length) shared.version++;
    if (request.transaction) transactions.delete(Buffer.from(request.transaction).toString());
    return { commitTime: stamp, writeResults: request.writes.map(() => ({ updateTime: stamp })) };
  });
  const repos = [];
  const open = () => { const r = openFirestoreRepository({ projectId: 'loadout-haldir-demo', databaseId: 'haldir', namespace: 'haldirPreviewTestnetV1', timeoutMs: 1000 }); repos.push(r); return r; };
  t.after(async () => { for (const r of repos) await r.close(); });
  return { open, shared, conflicts: () => conflicts };
}
function publicOrders(repository, getManifest = async () => manifest()) {
  assert.equal(typeof ordersModule.createPublicOrders, 'function', 'public admission exists independently of localTestOnly');
  return ordersModule.createPublicOrders({ repository, now: () => time, trustedManifestProvider: getManifest });
}
test('public admission reuses actual Firestore repository port; concurrent replay and reopen keep one immutable job', async t => {
  const wire = firestore(t), first = publicOrders(wire.open()), second = publicOrders(wire.open());
  const input = { ownerId: 'alice.testnet', admissionKey: 'one', approvalId: 'approved' };
  const [a, b] = await Promise.all([first.createJob(input), second.createJob(input)]);
  assert.equal(a.jobId, b.jobId);
  assert.equal(a.qualification, 'PUBLIC_TESTNET_FICTIONAL_VENDOR');
  assert.deepEqual(a.publicManifest, manifest());
  const reopened = publicOrders(wire.open());
  assert.deepEqual(await reopened.getJob({ ownerId: input.ownerId, jobId: a.jobId }), a);
  assert.equal((await reopened.getOrder({ ownerId: input.ownerId, jobId: a.jobId })).quote.amountAtomic, '8');
  await assert.rejects(reopened.getJob({ ownerId: 'bob.testnet', jobId: a.jobId }), { code: 'NOT_FOUND' });
  const records = [...wire.shared.records.values()].map(x => JSON.parse(x.fields.json.stringValue));
  assert.equal(records.filter(x => x.jobId === a.jobId && x.scope).length, 1);
});

for (const [label, mutate] of [
  ['wrong owner', m => { m.ownerId = 'bob.testnet'; }],
  ['wrong binding owner', m => { m.binding.ownerId = 'bob.testnet'; }],
  ['wrong binding mandate', m => { m.binding.mandateId = 'other.testnet'; }],
  ['mainnet', m => { m.approved.job.networkId = 'mainnet'; }],
  ['unverified chain', m => { m.chainEvidence.networkId = 'test-chain-local'; }],
  ['not final', m => { m.chainEvidence.finality = 'optimistic'; }],
  ['stale', m => { m.chainEvidence.observedAt = time - 30001; }],
  ['future', m => { m.chainEvidence.observedAt = time + 1; }],
  ['bad key', m => { m.binding.publicKey = 'not-a-key'; }],
  ['bad hash', m => { m.binding.codeHash = 'not-a-hash'; }],
  ['unlimited allowance', m => { m.binding.maxAllowanceAtomic = null; }],
  ['loopback', m => { m.rpcUrl = 'http://127.0.0.1:1234'; m.allowedRpcUrls = [m.rpcUrl]; }],
  ['extra local switch', m => { m.localTestOnly = true; }],
  ['numeric amount', m => { m.approved.quote.amountAtomic = 8; }],
]) test(`public admission refuses ${label} before durable writes`, async t => {
  const wire = firestore(t), value = manifest(); mutate(value);
  await assert.rejects(publicOrders(wire.open(), async () => value).createJob({ ownerId: 'alice.testnet', admissionKey: 'bad', approvalId: 'approved' }));
  assert.equal(wire.shared.records.size, 0);
});
test('public admission accepts exact immutable creation with explicit factory-ready evidence; replay may qualify deployed child without rewriting snapshot', async t => {
  const wire = firestore(t), m = manifest();
  m.creation = { factory: 'factory.testnet', job_label: 'approved', operating_float: '2000000000000000000000000',
    create_gas: '300000000000000', factoryCodeHash: hash };
  const child = 'j' + createHash('sha256').update(`${m.ownerId}:${m.creation.job_label}`).digest('hex').slice(0, 32) + '.' + m.creation.factory;
  m.binding.mandateId = m.approved.job.mandateId = m.approved.quote.mandateId = child;
  m.chainEvidence.deployment = 'FACTORY_READY';
  const orders = publicOrders(wire.open(), async () => structuredClone(m));
  const input = { ownerId: m.ownerId, admissionKey: 'creation', approvalId: m.manifestId };
  const first = await orders.createJob(input);
  assert.deepEqual(first.publicManifest, m);
  m.chainEvidence.deployment = 'MANDATE_READY'; m.chainEvidence.blockHeight++;
  assert.deepEqual(await orders.createJob(input), first);
  assert.equal((await orders.getJob({ ownerId: m.ownerId, jobId: first.jobId })).publicManifest.chainEvidence.deployment, 'FACTORY_READY');
  m.creation.operating_float = '3000000000000000000000000';
  await assert.rejects(orders.createJob(input), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('public replay permits refreshed chain evidence but not changed immutable binding; public API has no local stop', async t => {
  const wire = firestore(t), m = manifest(), orders = publicOrders(wire.open(), async () => structuredClone(m));
  const input = { ownerId: 'alice.testnet', admissionKey: 'same', approvalId: 'approved' };
  const first = await orders.createJob(input);
  m.chainEvidence.blockHeight++; m.chainEvidence.observedAt--;
  assert.deepEqual(await orders.createJob(input), first);
  m.binding.codeHash = baseEncode(new Uint8Array(32).fill(8));
  await assert.rejects(orders.createJob(input), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(orders.stopLocalJob, undefined);
});

const publicModule = await import('../../src/server/public-journey.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
function call(base, path, body = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, base), { method: options.method ?? 'POST',
      headers: { host: 'haldir.example', origin, 'x-haldir-csrf': '1', 'content-type': 'application/json', ...options.headers } }, res => {
      const chunks = []; res.on('data', x => chunks.push(x));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, body: JSON.parse(text), text }); });
      res.on('error', reject);
    });
    req.on('error', reject); req.end(options.method === 'GET' ? undefined : options.raw ?? JSON.stringify(body));
  });
}
function modelRuntimeFixture(propose, overrides = {}) {
  const configuration = { protocol: 'chat-completions', endpoint: 'https://offline-model.invalid/v1/chat/completions', model: 'synthetic-model-v1', apiKey: 'SYNTHETIC_NOT_A_REAL_CREDENTIAL' };
  const authorization = { authorizationId: 'synthetic-grant', endpoint: configuration.endpoint, model: configuration.model,
    credentialSource: 'application-runtime', billingApproved: true, dataApproved: true, expiresAt: '2026-11-14T10:00:00Z',
    maxCalls: 2, maxPromptBytes: 65536, maxCompletionTokens: 256, maxTotalTokens: 200000, timeoutMs: 5000,
    inputRateMicrosPerMillion: '1', outputRateMicrosPerMillion: '1', maxCostMicros: '1000', ...overrides };
  return { configuration, authorization, transport: async (endpoint, init) => {
    assert.equal(endpoint, configuration.endpoint);
    const request = JSON.parse(init.body), input = JSON.parse(request.messages[1].content);
    const output = await propose({ ...input, signal: init.signal });
    return Response.json({ model: configuration.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  } };
}
async function httpFixture(t, patch = {}) {
  assert.equal(typeof publicModule.createPublicJourney, 'function', 'public authenticated composition exists');
  const wire = firestore(t), repository = wire.open(), keys = new Map(), calls = { manifests: 0, models: 0, signers: 0 };
  let clock = time;
  const trustedAccessKeyReader = async ({ accountId, publicKey }) => {
    if (keys.get(accountId)?.getPublicKey().toString() !== publicKey) return null;
    return { networkId: 'testnet', accountId, publicKey, permission: 'FullAccess', finality: 'final', blockHeight: 123, blockHash: hash, observedAt: clock };
  };
  const config = { repository, approvedOrigin: origin, approvedRecipient: 'haldir.example', trustedAccessKeyReader, now: () => clock,
    capabilities: { financialActions: true, publicTestnet: true, qualifiedModel: true, qualifiedSigning: true },
    trustedManifestProvider: async ({ ownerId }) => { calls.manifests++; return manifest(ownerId, ownerId === 'bob.testnet' ? 'bob' : ''); },
    trustedSignerProvider: async () => { calls.signers++; throw new Error('not needed in admission slice'); },
    model: { propose: async () => { calls.models++; throw new Error('not needed in admission slice'); } }, ...patch };
  if (!Object.hasOwn(patch, 'modelRuntime')) config.modelRuntime = modelRuntimeFixture(input => config.model.propose(input));
  const sessions = createWalletSessions(config);
  const login = async (accountId = 'alice.testnet') => {
    const pair = KeyPair.fromRandom('ed25519'); keys.set(accountId, pair);
    const c = await sessions.issueChallenge({ accountId, origin, networkId: 'testnet' });
    const signed = pair.sign(serializeMessageNep413({ ...c.payload, nonce: Buffer.from(c.payload.nonce, 'base64') }));
    const result = await sessions.verifyChallenge({ accountId, origin, networkId: 'testnet', challengeId: c.challengeId,
      publicKey: pair.getPublicKey().toString(), signature: Buffer.from(signed.signature).toString('base64') });
    return `__Host-haldir_session=${result.token}`;
  };
  const app = publicModule.createPublicJourney(config), server = createServer(app.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    assert.equal(server.listening, false); assert.equal(server.address(), null);
  });
  const base = `http://127.0.0.1:${server.address().port}`, alice = await login(), bob = await login('bob.testnet');
  const request = (path, body, options = {}) => call(base, path, body, { ...options, headers: { cookie: alice, ...options.headers } });
  return { ...wire, repository, config, app, calls, alice, bob, sessions, keys, base, request, login, setClock: v => { clock = v; } };
}
test('public HTTP authenticates real session service, creates and reads immutable job with no model or signer', async t => {
  const h = await httpFixture(t);
  const response = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  assert.equal(response.status, 201, response.text);
  assert.equal(response.body.job.ownerId, 'alice.testnet');
  assert.equal(response.body.job.state, 'ACTIVE');
  assert.equal(response.body.job.qualification, 'PUBLIC_TESTNET_FICTIONAL_VENDOR');
  assert.equal(response.body.order.quote.amountAtomic, '8');
  assert.equal(response.body.job.publicManifest, undefined);
  assert.equal(response.body.run, null);
  assert.equal(response.body.payment.status, 'NOT_STARTED');
  assert.deepEqual(response.body.economics, { schemaVersion: 'haldir.mandate-economics.v1', state: 'unavailable',
    networkId: 'testnet', ownerId: 'alice.testnet', mandateId: 'mandate.testnet',
    source: { rpcUrl: manifest().rpcUrl, method: 'get_status', finality: 'final' }, observation: null, amounts: null, reason: 'NOT_CONFIGURED' });
  const path = `/api/public/jobs/${response.body.job.jobId}`;
  assert.deepEqual((await h.request(path, {}, { method: 'GET' })).body, response.body);
  assert.equal((await h.request(path, {}, { method: 'GET', headers: { cookie: h.bob } })).status, 404);
  assert.equal((await h.request(`${path}/run`, {}, { headers: { cookie: h.bob } })).status, 404);
  assert.deepEqual(h.calls, { manifests: 1, models: 0, signers: 0 });
});
test('public HTTP rejects browser authority, duplicate keys and wrong origin before provider effects', async t => {
  const h = await httpFixture(t);
  for (const headers of [{ origin: 'https://evil.example' }, { host: 'evil.example' }, { 'x-haldir-csrf': '0' }, { 'sec-fetch-site': 'cross-site' }])
    assert.equal((await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' }, { headers })).status, 403);
  for (const body of [{ ownerId: 'bob.testnet', approvalId: 'approved', admissionKey: 'one' }, { approved: manifest().approved, approvalId: 'approved', admissionKey: 'one' }, { approvalId: 'approved', admissionKey: 'one', localTestOnly: true }])
    assert.equal((await h.request('/api/public/jobs', body)).status, 400);
  assert.equal((await h.request('/api/public/jobs', {}, { raw: '{"approvalId":"approved","admissionKey":"one","approvalId":"approved"}' })).status, 400);
  assert.equal((await h.request('/api/public/jobs?x=1', {})).status, 404);
  assert.equal((await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' }, { headers: { cookie: '' } })).status, 401);
  assert.deepEqual(h.calls, { manifests: 0, models: 0, signers: 0 });
});
// Closed native SDK transport fixture, not chain evidence or a production adapter.
function nativeWire(t, { loseSend = true, two = false } = {}) {
  const requests = [], counts = { signs: 0, sends: 0 }, m = manifest();
  if (two) {const q=m.approved.quote,second={...q,vendorId:'second.testnet',orderId:'quote-2',content:'Second fictional sample',amountAtomic:'9'};m.approved={schemaVersion:'haldir.approved.two-source.v1',job:{...m.approved.job,vendorIds:[q.vendorId,second.vendorId]},sources:[{sourceId:'company-records',quote:q},{sourceId:'background-research',quote:second}]};}
  const evidenceByHash=new Map();
  let evidence, stopped = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), m.rpcUrl, 'no external transport/fallthrough');
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    const r = JSON.parse(options.body); requests.push(r);
    let result;
    if (r.method === 'status') result = { chain_id: 'testnet', sync_info: { syncing: false } };
    else if (r.method === 'query' && r.params.request_type === 'view_access_key_list') result = {
      keys: r.params.account_id === m.binding.signerId ? [{ public_key: m.binding.publicKey,
        access_key: { nonce: 1, permission: { FunctionCall: { receiver_id: m.binding.mandateId, method_names: ['pay'], allowance: '900' } } } }] : [], block_hash: hash, block_height: 123 };
    else if (r.method === 'query' && r.params.request_type === 'view_account') result = { code_hash: m.binding.codeHash };
    else if (r.method === 'query' && r.params.request_type === 'call_function') result = {
      result: [...Buffer.from(JSON.stringify({ owner: m.ownerId, agent: m.binding.signerId, cap: '30', allowlist: m.approved.job.vendorIds,
        deadline_ns: String(BigInt(Date.parse(m.approved.job.expiresAt)) * 1000000n), stopped, expired: false, free: '30', in_flight: null, orders: [] }))] };
    else if (r.method === 'block') result = { header: { hash, timestamp_nanosec: String(BigInt(time) * 1000000n) } };
    else if (r.method === 'send_tx') {
      counts.sends++;
      const signed = SignedTransaction.decode(Buffer.from(r.params.signed_tx_base64, 'base64'));
      assert.equal(signed.transaction.receiverId, m.binding.mandateId);
      const args=JSON.parse(Buffer.from(signed.transaction.actions[0].functionCall.args).toString());
      const quote=two?m.approved.sources.find(s=>s.quote.orderId===args.order_id).quote:m.approved.quote;
      evidence = syntheticPayment(quote,args.order_id==='quote-2'?31:1).evidence;
      const txHash = baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
      evidence.finalTransaction.transaction.hash = txHash; evidence.finalTransaction.transaction_outcome.id = txHash;
      evidenceByHash.set(txHash,evidence);
      if (loseSend) throw new Error('accepted but response lost');
      result = evidence.finalTransaction;
    } else if (r.method === 'EXPERIMENTAL_tx_status') { assert.ok(evidence); result = evidenceByHash.get(r.params.tx_hash).finalTransaction; }
    else if (r.method === 'EXPERIMENTAL_receipt') result = [...evidenceByHash.values()].flatMap(e=>e.receipts).find(row => row.receipt_id === r.params.receipt_id);
    else assert.fail(`unexpected native request ${JSON.stringify(r)}`);
    return Response.json({ jsonrpc: '2.0', id: r.id, result });
  });
  const signer = new KeyPairSigner(agentKey);
  return { requests, counts, ...(two?{trustedManifestProvider:async()=>structuredClone(m)}:{}), stop: () => { stopped = true; },
    trustedSignerProvider: async ({ ownerId, manifest: pinned, signal }) => {
      assert.equal(ownerId, m.ownerId); assert.deepEqual(pinned, m); assert.ok(signal instanceof AbortSignal);
      return { getPublicKey: () => signer.getPublicKey(), signTransaction: tx => { counts.signs++; return signer.signTransaction(tx); } };
    }, model: { propose: async input => {
      assert.ok(input.signal instanceof AbortSignal);
      if(two) return input.phase==='plan'?{tool:'requestquotes',arguments:{quoteIds:input.approvedSources.map(s=>s.quoteId)}}:{findings:input.evidence.map(a=>({artifactId:a.artifactId,excerpt:a.content.slice(0,100)})),interpretations:[{kind:'COMPARE_SOURCE_CONSISTENCY',findingIndexes:[0,1]}]};
      return input.phase === 'plan' ? { tool: 'requestquote', arguments: input.approvedQuote } :
        { findings: [{ artifactId: input.evidence[0].artifactId, excerpt: 'Northwind is a fictional supplier sample' }] };
    } } };
}
test('public run awaits native executor, verifies receipts and resumes same durable order after lost response', async t => {
  const wire = nativeWire(t), h = await httpFixture(t, wire);
  const admitted = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const path = `/api/public/jobs/${admitted.body.job.jobId}`;
  const run = await h.request(`${path}/run`);
  assert.equal(run.status, 200, run.text);
  assert.equal(run.body.order.lifecycle, 'DELIVERED');
  assert.equal(run.body.run.stage, 'COMPLETE');
  assert.equal(run.body.run.report.supplierVerified, false);
  assert.equal(run.body.payment.transactionHash, run.body.order.proof.transactionHash);
  const restarted = publicModule.createPublicJourney(h.config), server = createServer(restarted.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const resumed = await call(`http://127.0.0.1:${server.address().port}`, `${path}/resume`, {}, { headers: { cookie: h.alice } });
  assert.equal(resumed.status, 200, resumed.text); assert.deepEqual(resumed.body, run.body);
  assert.deepEqual(wire.counts, { signs: 1, sends: 1 });
  const records = [...h.shared.records.values()].map(row => JSON.parse(row.fields.json.stringValue));
  for (const field of ['signedTransaction', 'tokenHash', 'publicKey']) assert.equal(run.text.includes(`\"${field}\"`), false);
  assert.equal(records.filter(row => row.proof?.proofId && row.artifact).length, 1);
  assert.equal((await h.request(path, {}, { method: 'GET' })).body.order.proof.proofId, run.body.order.proof.proofId);
});

test('TS1 read reprojects partial fallback after same-delivery recovery without invoking report inference',async t=>{
 const wire=nativeWire(t,{two:true}),h=await httpFixture(t,wire),a=await h.request('/api/public/jobs',{approvalId:'approved',admissionKey:'two'}),jobId=a.body.job.jobId,path=`/api/public/jobs/${jobId}`,quoteId=a.body.job.sourceRefs[0].quoteId;
 let held=true;h.shared.onCommit=async request=>{const rows=request.writes.map(w=>JSON.parse(w.update.fields.json.stringValue));if(held&&rows.some(r=>r.quoteId===quoteId&&r.artifactId&&r.artifact))throw new Error('synthetic delivery write unavailable');};
 const partial=await h.request(`${path}/run`);assert.equal(partial.status,200,partial.text);assert.equal(partial.body.run.report.facts.length,1);
 held=false;const orders=publicOrders(h.repository,wire.trustedManifestProvider);await orders.retrieveDelivery({ownerId:'alice.testnet',jobId,quoteId});
 const read=await h.request(path);assert.equal(read.status,200,read.text);assert.equal(read.body.run.report.facts.length,2);assert.deepEqual(read.body.run.report.missing,['MODEL_REPORT_PENDING']);assert.deepEqual(read.body.run.report.nextCheck,{code:'REVIEW_REPORT_AVAILABILITY',sourceId:null});assert.deepEqual(wire.counts,{signs:2,sends:2});
});

for(const field of ['provenance','interpretation','approvedSources'])test(`TS1 public cached ${field} corruption cannot become trusted report output`,async t=>{
 const wire=nativeWire(t,{two:true}),h=await httpFixture(t,wire),a=await h.request('/api/public/jobs',{approvalId:'approved',admissionKey:'two'}),jobId=a.body.job.jobId,path=`/api/public/jobs/${jobId}`;
 assert.equal((await h.request(`${path}/run`)).body.run.stage,'COMPLETE');
 await h.repository.runTransaction(async tx=>{const run=await tx.get('agentRuns',jobId);if(field==='provenance')run.report.facts[1].vendorId='evil.testnet';if(field==='interpretation')run.report.interpretations=[{kind:'SUPPLIER_SAFE',findingIndexes:[0,1]}];if(field==='approvedSources')run.approvedSources[1].quote.amountAtomic='10';tx.set('agentRuns',jobId,run);});
 assert.equal((await h.request(path)).status,409);assert.deepEqual(wire.counts,{signs:2,sends:2});
});

test('TS1 public read refuses corrupted delivered evidence rather than replaying a cached complete report',async t=>{
 const wire=nativeWire(t,{two:true}),h=await httpFixture(t,wire),a=await h.request('/api/public/jobs',{approvalId:'approved',admissionKey:'two'}),jobId=a.body.job.jobId,path=`/api/public/jobs/${jobId}`;
 assert.equal((await h.request(`${path}/run`)).body.run.stage,'COMPLETE');const quoteId=a.body.job.sourceRefs[1].quoteId;
 await h.repository.runTransaction(async tx=>{const o=await tx.get('orders',quoteId),d=await tx.get('deliveries',quoteId);o.artifact.content='Forged supplier assurance';d.artifact=o.artifact;tx.set('orders',quoteId,o);tx.set('deliveries',quoteId,d);});
 const response=await h.request(path);assert.equal(response.status,409,response.text);assert.deepEqual(wire.counts,{signs:2,sends:2});
});

test('TS1 second signed-journal commit crossing global deadline cannot broadcast after abort',async t=>{
 const wire=nativeWire(t,{two:true}),entered=deferred(),aborted=deferred(),release=deferred();let signedCommits=0;
 const signerProvider=wire.trustedSignerProvider;
 const h=await httpFixture(t,{...wire,maxRunMs:500,trustedSignerProvider:async input=>{input.signal.addEventListener('abort',()=>aborted.resolve(),{once:true});return signerProvider(input);}});
 h.shared.onCommit=async request=>{const rows=request.writes.map(w=>JSON.parse(w.update.fields.json.stringValue));if(rows.some(r=>r.phase==='BROADCAST_INTENT')&&++signedCommits===2){entered.resolve();await release.promise;}};
 const a=await h.request('/api/public/jobs',{approvalId:'approved',admissionKey:'two'}),path=`/api/public/jobs/${a.body.job.jobId}`;
 const result=h.request(`${path}/run`);await entered.promise;await aborted.promise;release.resolve();
 const response=await result;assert.equal(response.status,503,response.text);assert.deepEqual(wire.counts,{signs:2,sends:1});
 const view=await h.request(path);assert.equal(view.body.orders[1].payment.status,'SUBMITTED');assert.equal(view.body.orders[1].order.proof,null);
});

test('TS1 whole-job deadline drains pending plan and run guard prevents overlapping second-source execution',async t=>{
 const wire=nativeWire(t,{two:true}),entered=deferred(),aborted=deferred(),release=deferred();let settled=false,modelCalls=0;
 const h=await httpFixture(t,{...wire,maxRunMs:150,model:{propose:async input=>{modelCalls++;entered.resolve();input.signal.addEventListener('abort',()=>aborted.resolve(),{once:true});await release.promise;return wire.model.propose(input);}}});
 const a=await h.request('/api/public/jobs',{approvalId:'approved',admissionKey:'two'}),path=`/api/public/jobs/${a.body.job.jobId}`;
 const first=h.request(`${path}/run`).then(x=>{settled=true;return x;});await entered.promise;
 assert.equal((await h.request(`${path}/resume`)).status,409);await aborted.promise;assert.equal(settled,false);release.resolve();
 const result=await first;assert.equal(result.status,503,result.text);assert.equal(result.body.error,'EXECUTION_DEADLINE');assert.deepEqual(wire.counts,{signs:0,sends:0});assert.equal(modelCalls,1);
 const view=await h.request(path);assert.equal(view.body.orders.length,2);assert.ok(view.body.orders.every(m=>m.payment.status==='NOT_STARTED'));
 await h.request(`${path}/resume`);assert.equal(modelCalls,1);assert.deepEqual(wire.counts,{signs:0,sends:0});
});

test('TS1 real HTTP, Firestore SDK and native SDK transport complete two same-job proofs/deliveries and replay without effects',async t=>{
  const wire=nativeWire(t,{two:true}),h=await httpFixture(t,wire);
  const a=await h.request('/api/public/jobs',{approvalId:'approved',admissionKey:'two'});assert.equal(a.status,201,a.text);
  const path=`/api/public/jobs/${a.body.job.jobId}`,result=await h.request(`${path}/run`);
  assert.equal(result.status,200,result.text);assert.equal(result.body.run.stage,'COMPLETE');assert.equal(result.body.orders.length,2);
  const [first,second]=result.body.orders;assert.equal(first.order.lifecycle,'DELIVERED');assert.equal(second.order.lifecycle,'DELIVERED');assert.notEqual(first.order.proof.proofId,second.order.proof.proofId);assert.notEqual(first.payment.transactionHash,second.payment.transactionHash);
  assert.equal(result.body.run.report.facts.length,2);assert.equal(result.body.run.report.supplierVerified,false);assert.deepEqual(wire.counts,{signs:2,sends:2});
  assert.deepEqual((await h.request(`${path}/resume`)).body,result.body);assert.deepEqual(wire.counts,{signs:2,sends:2});
  const records=[...h.shared.records.values()].map(r=>JSON.parse(r.fields.json.stringValue));assert.equal(records.filter(r=>r.phase==='BROADCAST_INTENT').length,2);assert.equal(records.filter(r=>r.artifactId&&r.artifact).length,2);assert.equal(records.filter(r=>r.proof&&r.quoteId&&!r.orderId).length,2);
});

for(const kind of ['legacy','two','missing','wrong-owner','invalid-second'])test(`TS1 approval preview ${kind} is strict and cannot invoke signer/model/admission`,async t=>{
 const m=manifest();if(kind==='two'||kind==='invalid-second'){const q=m.approved.quote,second={...q,vendorId:'second.testnet',orderId:'quote-2',content:'Second fictional sample'};m.approved={schemaVersion:'haldir.approved.two-source.v1',job:{...m.approved.job,vendorIds:[q.vendorId,second.vendorId]},sources:[{sourceId:'company-records',quote:q},{sourceId:'background-research',quote:second}]};if(kind==='invalid-second')second.amountAtomic='0';}
 if(kind==='wrong-owner')m.ownerId='foreign.testnet';
 const h=await httpFixture(t,{capabilities:{},trustedManifestProvider:async()=>kind==='missing'?null:structuredClone(m)});
 const result=await h.request('/api/public/approvals/read',{approvalId:'approved'});
 const okay=kind==='legacy'||kind==='two';assert.equal(result.status,okay?200:503,result.text);
 if(okay)assert.deepEqual(Object.keys(result.body).sort(),['contractVersion','approvalId','manifestId','ownerId','approved','ownerCreationRequired'].sort());else assert.equal(result.body.error,'MANIFEST_UNAVAILABLE');
 assert.equal(h.calls.models,0);assert.equal(h.calls.signers,0);
 assert.equal((await h.request('/api/public/approvals/read',{approvalId:'approved',ownerId:'alice.testnet'})).status,400);
 assert.equal((await h.request('/api/public/approvals/read',{approvalId:'approved'},{headers:{origin:'https://evil.invalid'}})).status,403);
 const rows=[...h.shared.records.values()].map(r=>JSON.parse(r.fields.json.stringValue));assert.equal(rows.filter(r=>r.scope||r.operationId||r.approvedJobInput||r.quote).length,0);
});
test('TS1 approval preview uses the same durable admission rate bucket and never falls through after its bound',async t=>{
 const h=await httpFixture(t,{capabilities:{}});for(let i=0;i<10;i++)assert.equal((await h.request('/api/public/approvals/read',{approvalId:'approved'})).status,200);
 assert.equal((await h.request('/api/public/approvals/read',{approvalId:'approved'})).status,429);assert.equal(h.calls.manifests,10);
});

test('TS1 source alias changing during pure owner prepare cannot issue a wallet request',async t=>{
 const m=manifest(),q=m.approved.quote,second={...q,vendorId:'second.testnet',orderId:'quote-2',content:'Second fictional sample'};
 m.approved={schemaVersion:'haldir.approved.two-source.v1',job:{...m.approved.job,vendorIds:[q.vendorId,second.vendorId]},sources:[{sourceId:'company-records',quote:q},{sourceId:'background-research',quote:second}]};
 let h;h=await httpFixture(t,{trustedManifestProvider:async()=>structuredClone(m),ownerOperations:{prepare:async({job})=>{
   await h.repository.runTransaction(async tx=>{const latest=await tx.get('jobs',job.jobId);latest.quoteId=latest.sourceRefs[1].quoteId;tx.set('jobs',job.jobId,latest);});return {network:'testnet'};
 },reconcile:async()=>null}});
 const a=await h.request('/api/public/jobs',{approvalId:'approved',admissionKey:'two'}),jobId=a.body.job.jobId;
 const response=await h.request(`/api/public/jobs/${jobId}/owner/prepare`,{action:'stop'});assert.equal(response.status,409,response.text);
 const key=createHash('sha256').update(JSON.stringify(['haldir-owner-v1',jobId,'stop'])).digest('hex'),op=await h.repository.runTransaction(tx=>tx.get('ownerOperations',key));assert.equal(op.request,null);assert.equal(op.status,'PREPARING');
});

test('TS1 owner recovery rejects mutated primary alias before reserving or invoking preparation',async t=>{
 const m=manifest(),q=m.approved.quote,second={...q,vendorId:'second.testnet',orderId:'quote-2',content:'Second fictional sample'};
 m.approved={schemaVersion:'haldir.approved.two-source.v1',job:{...m.approved.job,vendorIds:[q.vendorId,second.vendorId]},sources:[{sourceId:'company-records',quote:q},{sourceId:'background-research',quote:second}]};
 let preparations=0;const h=await httpFixture(t,{trustedManifestProvider:async()=>structuredClone(m),ownerOperations:{prepare:async()=>{preparations++;return {network:'testnet'};},reconcile:async()=>null}});
 const a=await h.request('/api/public/jobs',{approvalId:'approved',admissionKey:'two'}),jobId=a.body.job.jobId;
 await h.repository.runTransaction(async tx=>{const job=await tx.get('jobs',jobId);job.quoteId=job.sourceRefs[1].quoteId;tx.set('jobs',jobId,job);});
 const response=await h.request(`/api/public/jobs/${jobId}/owner/prepare`,{action:'stop'});
 assert.equal(response.status,409,response.text);assert.equal(preparations,0);
 const operationId=createHash('sha256').update(JSON.stringify(['haldir-owner-v1',jobId,'stop'])).digest('hex');assert.equal(await h.repository.runTransaction(tx=>tx.get('ownerOperations',operationId)),null);
});

test('TS1 authenticated preview is read-only without financial readiness and admission/read expose explicit v2 ordered sources',async t=>{
  const m=manifest(), q=m.approved.quote, second={...q,vendorId:'second.testnet',orderId:'quote-2',content:'Second fictional sample',amountAtomic:'9'};
  m.approved={schemaVersion:'haldir.approved.two-source.v1',job:{...m.approved.job,vendorIds:[q.vendorId,second.vendorId]},sources:[{sourceId:'company-records',quote:q},{sourceId:'background-research',quote:second}]};
  const h=await httpFixture(t,{capabilities:{},trustedManifestProvider:async()=>structuredClone(m)});
  const preview=await h.request('/api/public/approvals/read',{approvalId:'approved'});
  assert.equal(preview.status,200,preview.text);assert.equal(preview.body.contractVersion,'haldir.public.v2');assert.deepEqual(preview.body.approved,m.approved);
  assert.equal(preview.body.ownerCreationRequired,false);
  const rows=[...h.shared.records.values()].map(r=>JSON.parse(r.fields.json.stringValue));
  assert.equal(rows.filter(r=>r.scope||r.quote||r.operationId||r.approved).length,0);
  assert.equal((await h.request('/api/public/config')).body.supportedJobSchemas[0],'haldir.job.two-source.v1');
  const server=createServer(publicModule.createPublicJourney({...h.config,capabilities:{financialActions:true,publicTestnet:true,qualifiedModel:true,qualifiedSigning:true}}).handle);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const admitted=await call(`http://127.0.0.1:${server.address().port}`,'/api/public/jobs',{approvalId:'approved',admissionKey:'two'},{headers:{cookie:h.alice}});
  assert.equal(admitted.status,201,admitted.text);assert.equal(admitted.body.contractVersion,'haldir.public.v2');
  assert.equal(admitted.body.orders.length,2);assert.deepEqual(admitted.body.order,admitted.body.orders[0].order);assert.deepEqual(admitted.body.payment,admitted.body.orders[0].payment);
  assert.equal(admitted.body.job.sourceRefs.length,2);
  const view=await h.request(`/api/public/jobs/${admitted.body.job.jobId}`);assert.deepEqual(view.body,admitted.body);
});

function economicObservation(m = manifest()) {
  return { schemaVersion: 'haldir.mandate-economics.v1', state: 'known', networkId: 'testnet', ownerId: m.ownerId, mandateId: m.binding.mandateId,
    source: { rpcUrl: m.rpcUrl, method: 'get_status', finality: 'final' },
    observation: { blockHash: hash, blockHeight: 124, blockTimestampNs: String(BigInt(time) * 1000000n), observedAt: time },
    amounts: { capAtomic: '30', spentAtomic: '8', reservedAtomic: '4', availableAtomic: '15', refundedAtomic: '3' }, reason: null };
}
for (const [kind, mutate] of [
  ['owner', e => { e.ownerId = 'bob.testnet'; }], ['mandate', e => { e.mandateId = 'foreign.testnet'; }],
  ['network', e => { e.networkId = 'mainnet'; }], ['RPC origin', e => { e.source.rpcUrl = 'https://foreign.invalid'; }],
  ['sum', e => { e.amounts.availableAtomic = '16'; }], ['cap', e => { e.amounts.capAtomic = '31'; e.amounts.availableAtomic = '16'; }],
  ['numeric', e => { e.amounts.spentAtomic = 8; }], ['noncanonical', e => { e.amounts.spentAtomic = '08'; }],
  ['overflow', e => { e.amounts.reservedAtomic = String(2n ** 128n); }], ['foreign extra', e => { e.refundAuthorized = true; }],
  ['observation missing', e => { e.observation = null; }], ['hash', e => { e.observation.blockHash = 'not-a-hash'; }],
  ['zero block height', e => { e.observation.blockHeight = 0; }],
  ['future', e => { e.observation.blockTimestampNs = String(BigInt(time + 1) * 1000000n); }],
  ['false freshness', e => { e.observation.blockTimestampNs = String(BigInt(time - 30001) * 1000000n); }],
  ['false reason', e => { e.reason = 'OPERATION_UNCERTAIN'; }],
]) test(`economics HTTP rejects injected reader ${kind} without retaining any amounts`, async t => {
  const value = economicObservation(); mutate(value);
  const h = await httpFixture(t, { trustedMandateStatusReader: async () => value });
  const a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'economic' });
  assert.equal(a.status, 201, a.text);
  assert.deepEqual(a.body.economics, { ...economicObservation(), state: 'unavailable', observation: null, amounts: null, reason: 'BINDING_MISMATCH' });
  assert.equal(a.body.payment.status, 'NOT_STARTED'); assert.deepEqual(h.calls, { manifests: 1, models: 0, signers: 0 });
});
for (const kind of ['missing', 'throwing', 'unavailable', 'not-deployed']) test(`economics HTTP ${kind} reader is unavailable, never zero or job failure`, async t => {
  const patch = kind === 'missing' ? {} : { trustedMandateStatusReader: async () => {
    if (kind === 'throwing') throw new Error('secret provider detail');
    return { ...economicObservation(), state: 'unavailable', observation: null, amounts: null, reason: kind === 'not-deployed' ? 'NOT_DEPLOYED' : 'RPC_UNAVAILABLE' };
  } };
  const h = await httpFixture(t, patch), a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'economic' });
  assert.equal(a.status, 201, a.text);
  assert.deepEqual(a.body.economics, { ...economicObservation(), state: 'unavailable', observation: null, amounts: null, reason: kind === 'missing' ? 'NOT_CONFIGURED' : kind === 'not-deployed' ? 'NOT_DEPLOYED' : 'RPC_UNAVAILABLE' });
});
for (const observed of [true, false]) test(`economics HTTP withdrawal UNKNOWN overlays uncertainty with observation=${observed} and no durable writes`, async t => {
  const provider = ownerPort(), reconcile = provider.port.reconcile;
  provider.port.reconcile = async input => ({ ...await reconcile(input), status: 'UNKNOWN' });
  const h = await httpFixture(t, { ownerOperations: provider.port,
    ...(observed ? { trustedMandateStatusReader: async () => economicObservation() } : {}) });
  const a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'economic' }), path = `/api/public/jobs/${a.body.job.jobId}`;
  const prepared = await h.request(`${path}/owner/prepare`, { action: 'withdraw' });
  const input = { operationId: prepared.body.operation.operationId, transactionHash: hash, signerId: 'alice.testnet' };
  assert.equal((await h.request(`${path}/owner/receipt`, input)).body.operation.status, 'UNKNOWN');
  const before = structuredClone([...h.shared.records]), view = await h.request(path);
  assert.equal(view.status, 200, view.text);
  assert.deepEqual(view.body.economics, { ...economicObservation(), state: 'uncertain', reason: 'OPERATION_UNCERTAIN',
    ...(!observed ? { observation: null, amounts: null } : {}) });
  assert.equal(view.body.ownerOperations[0].receipt, null); assert.equal(view.body.ownerOperations[0].transactionHash, hash);
  assert.deepEqual([...h.shared.records], before); assert.equal(view.body.job.state, 'ACTIVE');
});
test('economics HTTP native unresolved effect is uncertain, while completed paid proofs are known', async t => {
  const wire = nativeWire(t, { two: true }), h = await httpFixture(t, { ...wire, trustedMandateStatusReader: async () => economicObservation() });
  const a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'economic' }), path = `/api/public/jobs/${a.body.job.jobId}`;
  assert.equal((await h.request(`${path}/run`)).body.economics.state, 'known');
  await h.repository.runTransaction(async tx => {
    const quoteId = a.body.job.sourceRefs[1].quoteId, order = await tx.get('orders', quoteId);
    const run = await tx.get('agentRuns', a.body.job.jobId);
    tx.set('orders', quoteId, { ...order, proof: null, artifact: null });
    tx.set('agentRuns', a.body.job.jobId, { ...run, report: null });
  });
  const before = structuredClone([...h.shared.records]), view = await h.request(path);
  assert.equal(view.status, 200, view.text); assert.equal(view.body.economics.state, 'uncertain'); assert.equal(view.body.economics.reason, 'OPERATION_UNCERTAIN');
  assert.deepEqual(view.body.economics.amounts, economicObservation().amounts); assert.deepEqual([...h.shared.records], before); assert.deepEqual(wire.counts, { signs: 2, sends: 2 });
});
for (const outcome of ['success', 'failure']) test(`bounded HTTP ${outcome} closes the original shared signal and retained signer capability`, async t => {
  const wire = nativeWire(t, { two: true }), m = await wire.trustedManifestProvider();
  let provider, retained, signal, candidate, resolutions = 0;
  const modelSignals = [], liveAtSign = [];
  const h = await httpFixture(t, { ...wire, maxRunMs: 20000,
    trustedSignerProvider: async input => {
      signal = input.signal; retained = await provider(input);
      if (outcome === 'failure') throw new Error('original signer provider failure');
      return { getPublicKey: () => retained.getPublicKey(), signTransaction: tx => {
        candidate = tx; liveAtSign.push(!signal.aborted); wire.counts.signs++; return retained.signTransaction(tx);
      } };
    }, model: { propose: async input => {
      modelSignals.push(input.signal); assert.equal(input.signal.aborted, false);
      return wire.model.propose(input);
    } } });
  const admitted = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'lifetime' });
  provider = createTrustedAgentSignerProvider({ catalog: [{ ownerId: m.ownerId, jobId: admitted.body.job.jobId, manifest: m, keyVersion: 'ephemeral-http-lifetime' }],
    timeoutMs: 20000, resolveKeyMaterial: async () => { resolutions++; return agentKey.toString(); } });
  const result = await h.request(`/api/public/jobs/${admitted.body.job.jobId}/run`);
  assert.equal(result.status, outcome === 'success' ? 200 : 503, result.text);
  if (outcome === 'failure') assert.equal(result.body.error, 'PROVIDER_UNAVAILABLE', 'cleanup must preserve original failure');
  assert.equal(signal.aborted, true, 'completed scope must close before HTTP settles, not at its later deadline');
  assert.equal(modelSignals.length, outcome === 'success' ? 2 : 0);
  assert.ok(modelSignals.every(s => s === signal), 'both phases use the original run signal');
  assert.equal(resolutions, 1); assert.deepEqual(liveAtSign, outcome === 'success' ? [true, true] : []);
  await assert.rejects(retained.getPublicKey(), /SIGNER_UNAVAILABLE/);
  if (candidate) await assert.rejects(retained.signTransaction(candidate), /SIGNER_UNAVAILABLE/);
  assert.deepEqual(wire.counts, outcome === 'success' ? { signs: 2, sends: 2 } : { signs: 0, sends: 0 });
});

test('economics HTTP deadline drains the reader before returning unavailable', async t => {
  const entered = deferred(), aborted = deferred(), release = deferred(); let finished = false, readerSettled = false;
  const h = await httpFixture(t, { maxRunMs: 100, trustedMandateStatusReader: async ({ signal }) => {
    entered.resolve(); signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    await release.promise; readerSettled = true; return economicObservation();
  } });
  const pending = h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'reader-drain' }).then(r => { finished = true; return r; });
  await entered.promise; await aborted.promise; assert.equal(finished, false, 'read must not abandon the provider');
  release.resolve(); const result = await pending;
  assert.equal(readerSettled, true); assert.equal(result.status, 201, result.text);
  assert.deepEqual(result.body.economics, { ...economicObservation(), state: 'unavailable', observation: null, amounts: null, reason: 'RPC_UNAVAILABLE' });
});
test('bounded HTTP late custody resolution stays quarantined and cannot revive the completed run signal', async t => {
  const wire = nativeWire(t, { two: true }), m = await wire.trustedManifestProvider(), release = deferred(), settled = deferred();
  let provider, original, resolutions = 0;
  const h = await httpFixture(t, { ...wire, maxRunMs: 20000, trustedSignerProvider: input => { original = input; return provider(input); } });
  const a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'late-custody' });
  provider = createTrustedAgentSignerProvider({ catalog: [{ ownerId: m.ownerId, jobId: a.body.job.jobId, manifest: m, keyVersion: 'ephemeral-quarantine' }],
    timeoutMs: 50, resolveKeyMaterial: async () => { resolutions++; try { await release.promise; return agentKey.toString(); } finally { settled.resolve(); } } });
  try {
    const result = await h.request(`/api/public/jobs/${a.body.job.jobId}/run`);
    assert.equal(result.status, 503, result.text); assert.equal(result.body.error, 'PROVIDER_UNAVAILABLE');
    assert.equal(original.signal.aborted, true);
    await assert.rejects(provider(original), /SIGNER_UNAVAILABLE/); assert.equal(resolutions, 1);
  } finally { release.resolve(); await settled.promise; }
  await assert.rejects(provider(original), /SIGNER_UNAVAILABLE/);
  assert.equal(resolutions, 1); assert.deepEqual(wire.counts, { signs: 0, sends: 0 });
});

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test('public durable run guard excludes another host while model is pending and releases after settlement', async t => {
  const wire = nativeWire(t), entered = deferred(), release = deferred(), secondEntered = deferred(); let models = 0;
  const h = await httpFixture(t, { ...wire, model: { propose: async input => {
    models++; if (input.phase === 'plan') { if (models > 1) secondEntered.resolve(); entered.resolve(); await release.promise; }
    return wire.model.propose(input);
  } } });
  const admitted = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const path = `/api/public/jobs/${admitted.body.job.jobId}`;
  const first = h.request(`${path}/run`); await entered.promise;
  const other = publicModule.createPublicJourney(h.config), server = createServer(other.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const secondRequest = call(`http://127.0.0.1:${server.address().port}`, `${path}/resume`, {}, { headers: { cookie: h.alice } });
  try { await Promise.race([secondRequest, secondEntered.promise]); }
  finally { release.resolve(); }
  const second = await secondRequest;
  assert.equal(second.status, 409, second.text); assert.equal(second.body.error, 'RUN_IN_PROGRESS');
  assert.equal((await first).status, 200); assert.equal(models, 2);
  assert.equal((await h.request(`${path}/resume`)).status, 200);
  assert.deepEqual(wire.counts, { signs: 1, sends: 1 });
});

test('public deadline aborts and awaits model settlement before returning, never signs after abort', async t => {
  const wire = nativeWire(t), entered = deferred(), aborted = deferred(), release = deferred(); let settled = false;
  const h = await httpFixture(t, { ...wire, maxRunMs: 75, model: { propose: async ({ signal }) => {
    entered.resolve(); signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    await release.promise; throw new Error('late model rejection');
  } } });
  const a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const path = `/api/public/jobs/${a.body.job.jobId}`;
  const pending = h.request(`${path}/run`).then(value => { settled = true; return value; });
  await entered.promise; await aborted.promise;
  assert.equal(settled, false, 'HTTP must not abandon still-running provider');
  release.resolve(); const result = await pending;
  assert.equal(result.status, 503, result.text); assert.equal(result.body.error, 'EXECUTION_DEADLINE');
  assert.deepEqual(wire.counts, { signs: 0, sends: 0 });
  assert.equal((await h.request(path, {}, { method: 'GET' })).body.order.lifecycle, 'PAYMENT_PENDING');
});

function ownerPort() {
  const calls = { prepare: 0, reconcile: 0 };
  const port = { prepare: async ({ operationId, action, ownerId, job, manifest: pinned, signal }) => {
    calls.prepare++; assert.match(operationId, /^[a-f0-9]{64}$/); assert.equal(job.ownerId, ownerId);
    assert.deepEqual(pinned, manifest(ownerId)); assert.ok(signal instanceof AbortSignal);
    return { network: 'testnet', signerId: ownerId, receiverId: pinned.binding.mandateId,
      methodName: action === 'create' ? 'create_job' : action, args: {}, gas: '100000000000000', deposit: '0' };
  }, reconcile: async ({ operationId, action, ownerId, job, manifest: pinned, transactionHash, signerId, signal }) => {
    calls.reconcile++; assert.match(operationId, /^[a-f0-9]{64}$/); assert.equal(job.ownerId, ownerId);
    assert.deepEqual(pinned, manifest(ownerId)); assert.ok(signal instanceof AbortSignal);
    return { networkId: 'testnet', ownerId, mandateId: pinned.binding.mandateId, action, transactionHash, signerId,
      finality: 'final', status: 'CONFIRMED', receiptId: hash, ...(action === 'withdraw' ? { amountAtomic: '22' } : {}) };
  } };
  return { port, calls };
}
test('public owner prepare/receipt persists identity, verifies bound observations and exposes only confirmed withdrawal', async t => {
  const provider = ownerPort(), h = await httpFixture(t, { ownerOperations: provider.port });
  const admitted = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const path = `/api/public/jobs/${admitted.body.job.jobId}`;
  for (const [i, action] of ['create', 'stop', 'withdraw'].entries()) {
    const prepared = await h.request(`${path}/owner/prepare`, { action });
    assert.equal(prepared.status, 200, prepared.text);
    assert.equal(prepared.body.operation.status, 'AWAITING_WALLET');
    assert.equal(prepared.body.operation.signerId, 'alice.testnet');
    assert.equal(prepared.body.operation.transactionHash, null);
    assert.equal(prepared.body.operation.receipt, null);
    assert.equal(prepared.body.walletEligible, true);
    const replay = await h.request(`${path}/owner/prepare`, { action });
    assert.equal(replay.body.walletEligible, false);
    assert.deepEqual(replay.body.operation, prepared.body.operation);
    const input = { operationId: prepared.body.operation.operationId, transactionHash: baseEncode(new Uint8Array(32).fill(20 + i)), signerId: 'alice.testnet' };
    assert.equal((await h.request(`${path}/owner/receipt`, { ...input, signerId: 'bob.testnet' })).status, 400);
    assert.equal((await h.request(`${path}/owner/receipt`, input, { headers: { cookie: h.bob } })).status, 404);
    const reconciled = await h.request(`${path}/owner/receipt`, input);
    assert.equal(reconciled.status, 200, reconciled.text); assert.equal(reconciled.body.operation.status, 'CONFIRMED');
    assert.deepEqual((await h.request(`${path}/owner/receipt`, input)).body, reconciled.body);
    assert.equal((await h.request(`${path}/owner/receipt`, { ...input, transactionHash: baseEncode(new Uint8Array(32).fill(40 + i)) })).status, 409);
  }
  const view = await h.request(path, {}, { method: 'GET' });
  assert.equal(view.body.job.state, 'STOPPED');
  assert.deepEqual(view.body.ownerOperations.map(op => op.action), ['create', 'stop', 'withdraw']);
  assert.equal(view.body.ownerOperations[2].receipt.amountAtomic, '22');
  assert.match(view.body.disclosures.principalReturn, /Only a confirmed withdraw receipt/);
  assert.deepEqual(provider.calls, { prepare: 3, reconcile: 3 });
  assert.deepEqual(h.calls, { manifests: 1, signers: 0, models: 0 });
});

test('public admission deadline drains manifest and never commits a late approval', async t => {
  const entered = deferred(), aborted = deferred(), release = deferred(); let done = false;
  const h = await httpFixture(t, { maxRunMs: 75, trustedManifestProvider: async ({ signal }) => {
    entered.resolve(signal); signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
    await release.promise; return manifest();
  } });
  const pending = h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' }).then(x => { done = true; return x; });
  const signal = await entered.promise;
  if (signal) await aborted.promise;
  assert.equal(done, false); release.resolve(); const result = await pending;
  assert.ok(signal instanceof AbortSignal, 'manifest provider must receive the bounded request signal');
  assert.equal(result.status, 503, result.text); assert.equal(result.body.error, 'EXECUTION_DEADLINE');
  const rows = [...h.shared.records.values()].map(row => JSON.parse(row.fields.json.stringValue));
  assert.equal(rows.filter(row => row.scope).length, 0);
});

test('public admission limit is durable across host reopen and never calls manifest after the bound', async t => {
  const h = await httpFixture(t), input = { approvalId: 'approved', admissionKey: 'one' };
  for (let i = 0; i < 10; i++) assert.equal((await h.request('/api/public/jobs', input)).status, 201);
  const other = publicModule.createPublicJourney(h.config), server = createServer(other.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const limited = await call(`http://127.0.0.1:${server.address().port}`, '/api/public/jobs', input, { headers: { cookie: h.alice } });
  assert.equal(limited.status, 429, limited.text); assert.equal(limited.body.error, 'RATE_LIMITED');
  assert.equal(h.calls.manifests, 10);
  h.setClock(time + 60000);
  h.config.trustedManifestProvider = async () => ({ ...manifest(), chainEvidence: { ...manifest().chainEvidence, observedAt: time + 60000 } });
  const fresh = publicModule.createPublicJourney(h.config), nextServer = createServer(fresh.handle);
  await new Promise(resolve => nextServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => nextServer.close(resolve)));
  assert.equal((await call(`http://127.0.0.1:${nextServer.address().port}`, '/api/public/jobs', input, { headers: { cookie: h.alice } })).status, 201);
});

test('public deadline drains an internally timed-out signer and keeps reserved payment lookup-only', async t => {
  const wire = nativeWire(t), entered = deferred(), aborted = deferred(), release = deferred(); let done = false;
  const h = await httpFixture(t, { ...wire, maxRunMs: 100, trustedSignerProvider: async input => {
    const signer = await wire.trustedSignerProvider(input);
    input.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    return { ...signer, signTransaction: async tx => { entered.resolve(); await release.promise; return signer.signTransaction(tx); } };
  } });
  const a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const path = `/api/public/jobs/${a.body.job.jobId}`;
  const pending = h.request(`${path}/run`).then(x => { done = true; return x; });
  await entered.promise; await aborted.promise;
  assert.equal(done, false);
  const overlapping = await h.request(`${path}/resume`);
  assert.equal(overlapping.status, 409, overlapping.text);
  release.resolve(); const result = await pending;
  assert.equal(result.status, 503, result.text); assert.equal(result.body.error, 'EXECUTION_DEADLINE');
  assert.equal(wire.counts.sends, 0);
  const before = { ...wire.counts };
  const resumed = await h.request(`${path}/resume`);
  assert.equal(resumed.status, 200, resumed.text); assert.equal(resumed.body.run.stage, 'PAYMENT_UNKNOWN');
  assert.deepEqual(wire.counts, before);
  assert.equal(resumed.body.payment.status, 'ATTENTION_REQUIRED');
});

for (const kind of ['missing signer', 'throwing signer', 'wrong signer key', 'throwing model']) test(`public ${kind} fails closed with no signing/broadcast`, async t => {
  const wire = nativeWire(t);
  const patch = kind === 'missing signer' ? { trustedSignerProvider: async () => null } :
    kind === 'throwing signer' ? { trustedSignerProvider: async () => { throw new Error('secret provider detail'); } } :
    kind === 'wrong signer key' ? { trustedSignerProvider: async () => new KeyPairSigner(KeyPair.fromRandom('ed25519')) } :
    { model: { propose: async () => { throw new Error('secret provider detail'); } } };
  const h = await httpFixture(t, { ...wire, ...patch });
  const a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const result = await h.request(`/api/public/jobs/${a.body.job.jobId}/run`);
  assert.equal(result.status, 503, result.text); assert.equal(result.body.error, 'PROVIDER_UNAVAILABLE');
  assert.equal(result.text.includes('secret provider'), false);
  assert.deepEqual(wire.counts, { signs: 0, sends: 0 });
});

for (const [label, mutate] of [
  ['wrong owner', r => { r.ownerId = 'bob.testnet'; }],
  ['wrong mandate', r => { r.mandateId = 'other.testnet'; }],
  ['wrong action', r => { r.action = 'stop'; }],
  ['wrong chain', r => { r.networkId = 'mainnet'; }],
  ['wrong hash', r => { r.transactionHash = baseEncode(new Uint8Array(32).fill(99)); }],
  ['wrong signer', r => { r.signerId = 'bob.testnet'; }],
  ['optimistic result', r => { r.finality = 'optimistic'; }],
  ['free balance without return receipt', r => { delete r.receiptId; r.free = '22'; }],
  ['numeric amount', r => { r.amountAtomic = 22; }],
  ['noncanonical amount', r => { r.amountAtomic = '022'; }],
]) test(`public owner receipt rejects ${label} without returned-principal or stop claim`, async t => {
  const provider = ownerPort(), reconcile = provider.port.reconcile;
  provider.port.reconcile = async input => { const receipt = await reconcile(input); mutate(receipt); return receipt; };
  const h = await httpFixture(t, { ownerOperations: provider.port });
  const a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const path = `/api/public/jobs/${a.body.job.jobId}`;
  const prepared = await h.request(`${path}/owner/prepare`, { action: 'withdraw' });
  const input = { operationId: prepared.body.operation.operationId, transactionHash: hash, signerId: 'alice.testnet' };
  const rejected = await h.request(`${path}/owner/receipt`, input);
  assert.equal(rejected.status, 503, rejected.text);
  const read = await h.request(path, {}, { method: 'GET' });
  assert.equal(read.body.job.state, 'ACTIVE');
  assert.equal(read.body.ownerOperations[0].transactionHash, hash);
  assert.equal(read.body.ownerOperations[0].receipt, null);
  assert.notEqual(read.body.ownerOperations[0].status, 'CONFIRMED');
});

test('public owner unknown/failed observations retain hash across reopen and never imply a refund', async t => {
  const provider = ownerPort(); let status = 'UNKNOWN';
  const reconcile = provider.port.reconcile;
  provider.port.reconcile = async input => ({ ...await reconcile(input), status });
  const h = await httpFixture(t, { ownerOperations: provider.port });
  const a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const path = `/api/public/jobs/${a.body.job.jobId}`;
  const prepared = await h.request(`${path}/owner/prepare`, { action: 'withdraw' });
  const input = { operationId: prepared.body.operation.operationId, transactionHash: hash, signerId: 'alice.testnet' };
  const unknown = await h.request(`${path}/owner/receipt`, input);
  assert.equal(unknown.status, 200, unknown.text); assert.equal(unknown.body.operation.status, 'UNKNOWN');
  assert.equal(unknown.body.operation.receipt, null);
  for (const attemptId of [unknown.body.operation.preparation.attemptId, 'unreserved']) {
    const lookup = await h.request(`${path}/owner/retry-prepare`, { action: 'withdraw', operationId: input.operationId, attemptId });
    assert.equal(lookup.status, 200, lookup.text); assert.equal(lookup.body.walletEligible, false);
    assert.deepEqual(lookup.body.operation, unknown.body.operation);
  }
  status = 'FAILED'; const failed = await h.request(`${path}/owner/receipt`, input);
  assert.equal(failed.body.operation.status, 'FAILED');
  assert.equal(failed.body.operation.receipt?.amountAtomic, undefined, 'a failed receipt cannot report returned principal');
  status = 'CONFIRMED';
  assert.deepEqual((await h.request(`${path}/owner/receipt`, input)).body, failed.body);
  assert.equal(provider.calls.prepare, 1); assert.equal(provider.calls.reconcile, 2);
});

for (const field of ['privateKey', 'signature', 'signedTransaction', 'localTestOnly', 'testOnlySession']) test(`public owner preparation never publishes ${field}`, async t => {
  const provider = ownerPort(), prepare = provider.port.prepare;
  provider.port.prepare = async input => ({ ...await prepare(input), nested: { [field]: 'FORBIDDEN_VALUE' } });
  const h = await httpFixture(t, { ownerOperations: provider.port });
  const a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const path = `/api/public/jobs/${a.body.job.jobId}`;
  const result = await h.request(`${path}/owner/prepare`, { action: 'stop' });
  assert.equal(result.status, 503, result.text);
  const read = await h.request(path, {}, { method: 'GET' });
  assert.equal(read.text.includes('FORBIDDEN_VALUE'), false); assert.equal(read.body.ownerOperations[0].request, null);
});

test('public owner receipt hash cannot be rebound to another action even by a permissive observation adapter', async t => {
  const provider = ownerPort(), h = await httpFixture(t, { ownerOperations: provider.port });
  const a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const path = `/api/public/jobs/${a.body.job.jobId}`;
  const first = await h.request(`${path}/owner/prepare`, { action: 'stop' });
  const input = { operationId: first.body.operation.operationId, transactionHash: hash, signerId: 'alice.testnet' };
  assert.equal((await h.request(`${path}/owner/receipt`, input)).status, 200);
  const second = await h.request(`${path}/owner/prepare`, { action: 'withdraw' });
  const result = await h.request(`${path}/owner/receipt`, { ...input, operationId: second.body.operation.operationId });
  assert.equal(result.status, 409, result.text); assert.equal(provider.calls.reconcile, 1);
});

test('public missing injected model cannot enable admission or run', async t => {
  const h = await httpFixture(t, { model: undefined });
  const config = await h.request('/api/public/config');
  assert.equal(config.body.financialActions, false);
  assert.ok(config.body.missingConfiguration.includes('model'));
  assert.equal((await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' })).status, 503);
  assert.deepEqual(h.calls, { manifests: 0, models: 0, signers: 0 });
});

test('durable model reservation serializes actual Firestore transactions, rejects phase replay and preserves cumulative ceilings after reopen', async t => {
  const h = await httpFixture(t), a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  assert.equal(a.status, 201, a.text);
  const authorization = { ...h.config.modelRuntime.authorization, maxTotalTokens: 10000, maxCostMicros: '3' };
  const options = { repository: h.repository, ownerId: 'alice.testnet', jobId: a.body.job.jobId,
    configuration: h.config.modelRuntime.configuration, authorization, now: () => time };
  const intent = { authorizationId: authorization.authorizationId, jobId: options.jobId, phase: 'plan',
    endpoint: authorization.endpoint, model: authorization.model, inputTokensUpperBound: 5000,
    maxCompletionTokens: 256, reservedTokens: 5256, reservedCostMicros: '2' };
  const first = publicModule.createPublicModelBudget(options), second = publicModule.createPublicModelBudget({ ...options, repository: h.open() });
  const results = await Promise.all([first.reserve(intent), second.reserve(intent)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(await publicModule.createPublicModelBudget({ ...options, repository: h.open() }).reserve(intent), false);
  assert.equal(await first.reserve({ ...intent, phase: 'report' }), false, 'cumulative token/cost ceiling survives adapter recreation');
  const records = [...h.shared.records.values()].map(row => JSON.parse(row.fields.json.stringValue));
  const grant = records.find(row => row.authorizationId === authorization.authorizationId && row.calls === 1);
  assert.ok(grant); assert.equal(grant.reservedTokens, 5256); assert.equal(grant.reservedCostMicros, '2');
  assert.equal(JSON.stringify(records).includes(h.config.modelRuntime.configuration.apiKey), false);
});

test('durable model reservation validates exact grant/job/route/cost and consumes both phases without refund', async t => {
  const h = await httpFixture(t), admitted = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const options = { repository: h.repository, ownerId: 'alice.testnet', jobId: admitted.body.job.jobId,
    ...h.config.modelRuntime, now: () => time };
  const intent = { authorizationId: options.authorization.authorizationId, jobId: options.jobId, phase: 'plan',
    endpoint: options.authorization.endpoint, model: options.authorization.model, inputTokensUpperBound: 5000,
    maxCompletionTokens: 256, reservedTokens: 5256, reservedCostMicros: '2' };
  const budget = publicModule.createPublicModelBudget(options);
  for (const patch of [{ jobId: 'other' }, { authorizationId: 'wrong' }, { endpoint: 'https://evil.invalid/' },
    { model: 'other' }, { phase: 'other' }, { inputTokensUpperBound: -1 }, { reservedTokens: 1 }, { reservedCostMicros: '0' }, { maxCompletionTokens: 1 }, { extra: true }])
    assert.equal(await budget.reserve({ ...intent, ...patch }), false);
  assert.equal(await publicModule.createPublicModelBudget({ ...options, ownerId: 'bob.testnet' }).reserve(intent), false);
  assert.equal(await budget.reserve(intent), true);
  assert.equal(await publicModule.createPublicModelBudget({ ...options, authorization: { ...options.authorization, maxCostMicros: '999' } }).reserve({ ...intent, phase: 'report' }), false);
  assert.equal(await publicModule.createPublicModelBudget({ ...options, repository: h.open() }).reserve({ ...intent, phase: 'report' }), true);
  assert.equal(await budget.reserve({ ...intent, phase: 'report' }), false);
  const records = [...h.shared.records.values()].map(row => JSON.parse(row.fields.json.stringValue));
  const grant = records.find(row => row.calls === 2 && row.authorizationId === options.authorization.authorizationId);
  assert.equal(grant.reservedTokens, 10512); assert.equal(grant.reservedCostMicros, '4');
});

test('public existing job remains readable after model grant closes, but no new run or admission is released', async t => {
  const h = await httpFixture(t), a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const path = `/api/public/jobs/${a.body.job.jobId}`;
  const app = publicModule.createPublicJourney({ ...h.config, model: undefined });
  const server = createServer(app.handle); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (route, body, options = {}) => call(`http://127.0.0.1:${server.address().port}`, route, body, { ...options, headers: { cookie: h.alice } });
  assert.equal((await request('/api/public/config', {})).body.financialActions, false);
  assert.deepEqual((await request(path, undefined, { method: 'GET' })).body, a.body);
  assert.equal((await request(`${path}/resume`, {})).status, 503);
  assert.equal((await request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'two' })).status, 503);
  assert.deepEqual(h.calls, { manifests: 1, models: 0, signers: 0 });
});

test('public run limit is shared by run/resume and enforced before signer/model access', async t => {
  const h = await httpFixture(t), a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const path = `/api/public/jobs/${a.body.job.jobId}`;
  for (let i = 0; i < 20; i++) assert.equal((await h.request(`${path}/${i % 2 ? 'run' : 'resume'}`)).status, 503);
  const result = await h.request(`${path}/run`);
  assert.equal(result.status, 429, result.text); assert.equal(h.calls.signers, 20); assert.equal(h.calls.models, 0);
});

test('public concurrent owner preparation is one-way and provider failure preserves unresolved identity', async t => {
  const entered = deferred(), release = deferred(); let preparations = 0;
  const port = ownerPort().port;
  port.prepare = async () => { preparations++; entered.resolve(); await release.promise; throw new Error('provider offline'); };
  const h = await httpFixture(t, { ownerOperations: port });
  const a = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' }), path = `/api/public/jobs/${a.body.job.jobId}`;
  const first = h.request(`${path}/owner/prepare`, { action: 'stop' }); await entered.promise;
  const concurrent = await h.request(`${path}/owner/prepare`, { action: 'stop' });
  assert.equal(concurrent.status, 200, concurrent.text); assert.equal(concurrent.body.operation.status, 'PREPARING');
  release.resolve(); assert.equal((await first).status, 503);
  const replay = await h.request(`${path}/owner/prepare`, { action: 'stop' });
  assert.equal(replay.body.operation.operationId, concurrent.body.operation.operationId);
  assert.equal(replay.body.operation.status, 'UNKNOWN'); assert.equal(preparations, 1);
});

test('public financial capability gate is explicit and reports each missing qualification without fallback', async t => {
  const h = await httpFixture(t, { capabilities: {}, trustedSignerProvider: undefined, model: undefined });
  const config = await h.request('/api/public/config');
  assert.equal(config.status, 200, config.text);
  assert.equal(config.body.financialActions, false);
  assert.ok(config.body.missingConfiguration.includes('qualifiedModel'));
  assert.ok(config.body.missingConfiguration.includes('trustedSignerProvider'));
  assert.equal((await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' })).status, 503);
  assert.deepEqual(h.calls, { manifests: 0, models: 0, signers: 0 });
});

test('actual Firestore retried initial claim callback cannot grant eligibility after another host wins unreserved', async t => {
  const provider = ownerPort(), h = await httpFixture(t, { ownerOperations: provider.port });
  const admitted = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const jobId = admitted.body.job.jobId, path = `/api/public/jobs/${jobId}`;
  const operationId = createHash('sha256').update(JSON.stringify(['haldir-owner-v1', jobId, 'stop'])).digest('hex');
  const entered = deferred(), release = deferred(); let held = false;
  h.shared.onCommit = async request => {
    const rows = request.writes.map(w => JSON.parse(w.update.fields.json.stringValue));
    if (!held && rows.some(r => r.operationId === operationId && r.status === 'PREPARING')) {
      held = true; entered.resolve(); await release.promise;
    }
  };
  const initial = h.request(`${path}/owner/prepare`, { action: 'stop' }); await entered.promise;
  const other = publicModule.createPublicJourney({ ...h.config, repository: h.open() }), server = createServer(other.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const winner = await call(`http://127.0.0.1:${server.address().port}`, `${path}/owner/retry-prepare`,
    { action: 'stop', operationId, attemptId: 'unreserved' }, { headers: { cookie: h.alice } });
  release.resolve(); const loser = await initial;
  assert.equal(winner.status, 200, winner.text); assert.equal(winner.body.walletEligible, true);
  assert.equal(loser.status, 200, loser.text); assert.equal(loser.body.walletEligible, false);
  assert.deepEqual(loser.body.operation, winner.body.operation); assert.equal(provider.calls.prepare, 1);
  assert.ok(h.conflicts() > 0, 'actual installed SDK retried a conflicting transaction');
  const attempts = [...h.shared.records.values()].map(r => JSON.parse(r.fields.json.stringValue)).filter(r => r.attemptId && r.previousAttemptId === null);
  assert.equal(attempts.length, 1, 'discarded callback does not leak an attempt audit');
});

test('actual Firestore retried explicit retry callback keeps one successor and predecessor history', async t => {
  const provider = ownerPort(), successfulPrepare = provider.port.prepare;
  provider.port.prepare = async () => { throw new Error('pure preparation failed'); };
  const h = await httpFixture(t, { ownerOperations: provider.port });
  const admitted = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'one' });
  const path = `/api/public/jobs/${admitted.body.job.jobId}`;
  assert.equal((await h.request(`${path}/owner/prepare`, { action: 'stop' })).status, 503);
  const failed = (await h.request(path)).body.ownerOperations[0];
  assert.equal(failed.preparation.state, 'UNISSUED_FAILED');
  provider.port.prepare = successfulPrepare;
  const injected = new Set();
  h.shared.onCommit = async request => {
    const rows = request.writes.map(w => JSON.parse(w.update.fields.json.stringValue));
    for (const phase of ['PREPARING', 'AWAITING_WALLET']) {
      if (!injected.has(phase) && rows.some(r => r.status === phase)) { injected.add(phase); h.shared.version++; }
    }
  };
  const input = { action: 'stop', operationId: failed.operationId, attemptId: failed.preparation.attemptId };
  const responses = await Promise.all([h.request(`${path}/owner/retry-prepare`, input), h.request(`${path}/owner/retry-prepare`, input)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.deepEqual(responses.map(r => r.body.walletEligible).sort(), [false, true]);
  assert.equal(new Set(responses.map(r => r.body.operation.preparation.attemptId)).size, 1);
  assert.deepEqual([...injected].sort(), ['AWAITING_WALLET', 'PREPARING']);
  assert.ok(h.conflicts() >= 2); assert.equal(provider.calls.prepare, 1);
  const records = [...h.shared.records.values()].map(r => JSON.parse(r.fields.json.stringValue));
  const attempts = records.filter(r => Object.hasOwn(r, 'previousAttemptId'));
  assert.equal(attempts.length, 2);
  assert.equal(attempts.find(r => r.attemptId === failed.preparation.attemptId).state, 'UNISSUED_FAILED');
  assert.equal(attempts.find(r => r.previousAttemptId === failed.preparation.attemptId).state, 'ISSUED');
});

// Maintained closed qualification: real HTTP/auth/admission/repository, default
// atomic budget, generic adapter, verification consumer and restricted SDK signer.
// SDK response/verify methods and RPC are synthetic, NOT live provider/chain proof.
for (const outcome of ['complete', 'accepted-inference-response-loss']) test(`TS1 integrated durable AI HTTP ${outcome}`, async t => {
  const wire = nativeWire(t, { two: true, loseSend: true });
  const approved = await wire.trustedManifestProvider(); // Independent trusted fixture, not candidate input.
  const counts = { inference: 0, verification: 0, cacheClears: 0, keyResolutions: 0, forbiddenNetwork: 0 };
  const captured = [], verifiedIds = [], sdkOptions = [];
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url) !== approved.rpcUrl) { counts.forbiddenNetwork++; throw new Error('CLOSED_FIXTURE_NETWORK_DENIED'); }
    return nativeFetch(url, init);
  });
  // Deny actual non-loopback sockets independently of the synthetic fetch seam.
  const socketConnect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (typeof options !== 'object' || !['127.0.0.1', '::1'].includes(options.host)) {
      counts.forbiddenNetwork++; throw new Error('CLOSED_FIXTURE_SOCKET_DENIED');
    }
    return socketConnect.apply(this, args);
  });
  t.mock.method(tls, 'connect', () => { counts.forbiddenNetwork++; throw new Error('CLOSED_FIXTURE_TLS_DENIED'); });
  let model, signerProvider;
  const ownerCounts = { prepare: 0, reconcile: 0 };
  const residualAtomic = outcome === 'complete' ? '13' : '30';
  const h = await httpFixture(t, { ...wire, modelRuntime: null,
    model: { propose: input => model.propose(input) },
    trustedSignerProvider: async input => {
      const signer = await signerProvider(input);
      return { getPublicKey: () => signer.getPublicKey(), signTransaction: tx => { wire.counts.signs++; return signer.signTransaction(tx); } };
    },
    ownerOperations: {
      prepare: async ({ action, ownerId, manifest: pinned }) => {
        ownerCounts.prepare++; assert.deepEqual(pinned, approved); assert.equal(ownerId, approved.ownerId);
        return { network: 'testnet', signerId: ownerId, receiverId: approved.binding.mandateId,
          methodName: action, args: {}, gas: '100000000000000', deposit: '0' };
      },
      reconcile: async ({ action, ownerId, manifest: pinned, transactionHash, signerId }) => {
        ownerCounts.reconcile++; assert.deepEqual(pinned, approved);
        return { networkId: 'testnet', ownerId, mandateId: approved.binding.mandateId, action, transactionHash, signerId,
          finality: 'final', status: 'CONFIRMED', receiptId: hash, ...(action === 'withdraw' ? { amountAtomic: residualAtomic } : {}) };
      },
    },
  });
  const preview = await h.request('/api/public/approvals/read', { approvalId: 'approved' });
  assert.equal(preview.status, 200, preview.text); assert.deepEqual(preview.body.approved, approved.approved);
  assert.equal([...h.shared.records.keys()].some(k => /\/(jobs|admissions|mandates|quotes|orders)\//.test(k)), false,
    'preview/session setup must not seed admission or financial records');
  const admitted = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'integrated-ai' });
  assert.equal(admitted.status, 201, admitted.text);
  const jobId = admitted.body.job.jobId, path = `/api/public/jobs/${jobId}`;
  const job = await h.repository.runTransaction(tx => tx.get('jobs', jobId));
  assert.deepEqual(job.publicManifest, approved);
  const catalog = [{ ownerId: approved.ownerId, jobId: job.jobId, manifest: structuredClone(approved), keyVersion: 'closed-ephemeral-v1' }];
  const transportFactory = ({ apiKey, signal }) => createNearAiTransport({ apiKey, signal,
    run: async input => ({ ok: true, ...await verifiedCompletion(input, async options => {
      sdkOptions.push({ baseUrl: options.baseUrl, e2ee: options.e2ee });
      assert.equal(options.apiKey, 'CLOSED_SYNTHETIC_AI_KEY_ONLY');
      return { sdkVersion: '0.3.0', getSdkError: () => null,
        pause: async () => assert.fail('no verification retry is expected'),
        client: {
          fetch: async (url, init) => {
            if (url !== NEAR_AI_ENDPOINT) { counts.forbiddenNetwork++; throw new Error('CLOSED_SDK_URL_DENIED'); }
            assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
            const body = JSON.parse(init.body), request = JSON.parse(body.messages[1].content);
            assert.equal(body.model, NEAR_AI_MODEL); assert.equal(body.max_completion_tokens, 2048); assert.equal(body.thinking_token_budget, 512);
            assert.equal(Object.hasOwn(body, 'max_tokens'), false);
            counts.inference++; captured.push(request);
            const result = request.phase === 'plan'
              ? { tool: 'requestquotes', arguments: { quoteIds: request.approvedSources.map(s => s.quoteId) } }
              : { findings: request.evidence.map(a => ({ artifactId: a.artifactId, excerpt: a.content.slice(0, 80) })),
                  interpretations: [{ kind: 'COMPARE_SOURCE_CONSISTENCY', findingIndexes: [0, 1] }] };
            if (outcome === 'accepted-inference-response-loss') throw new Error('synthetic accepted inference response lost');
            return Response.json({ id: `closed-completion-${counts.inference}`, model: body.model,
              choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }],
              usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, completion_tokens_details: { reasoning_tokens: 50 } } });
          },
          verifyResponse: async id => { counts.verification++; verifiedIds.push(id); return { id, signatureKind: 'provider_tee' }; },
          clearResponseCache: () => { counts.cacheClears++; },
        } };
    }) }),
  });
  const construct = repository => {
    // Deliberately NO budgetFactory/reservationKey override: shipping defaults.
    model = createNearAiModel({ repository, apiKey: 'CLOSED_SYNTHETIC_AI_KEY_ONLY',
      authorizationExpiresAt: '2026-11-16T23:59:00Z', now: () => time, transportFactory });
    signerProvider = createTrustedAgentSignerProvider({ catalog, resolveKeyMaterial: async ({ keyVersion, signal }) => {
      assert.equal(keyVersion, 'closed-ephemeral-v1'); assert.equal(signal.aborted, false); counts.keyResolutions++;
      return agentKey.toString(); // Ephemeral fixture key never printed/persisted.
    } });
  };
  construct(h.repository);
  const first = await h.request(`${path}/run`);
  assert.equal(first.status, 200, first.text);
  const rows = () => [...h.shared.records].map(([key, r]) => ({ key, value: JSON.parse(r.fields.json.stringValue) }));
  const collection = name => rows().filter(r => r.key.includes(`/namespaces/haldirPreviewTestnetV1/${name}/`)).map(r => r.value);
  const records = rows().map(r => r.value);
  assert.equal(collection('admissions').length, 1); assert.equal(collection('mandates').length, 1);
  assert.equal(collection('jobs').length, 1); assert.equal(collection('quotes').length, 2); assert.equal(collection('orders').length, 2);
  assert.deepEqual(collection('mandates')[0], { networkId: 'testnet', mandateId: approved.binding.mandateId, ownerId: approved.ownerId, jobId });
  assert.equal(records.filter(r => r.scope).length, 1);
  assert.equal(records.filter(r => r.scope).map(r => r.scope.mandateId)[0], approved.binding.mandateId);
  assert.equal(new Set(admitted.body.orders.map(r => r.order.quoteId)).size, 2);
  const reservations = collection('modelReservations');
  assert.equal(collection('modelReleaseSpend').length, 1);
  assert.equal(reservations.length, outcome === 'complete' ? 2 : 1);
  assert.deepEqual(reservations.map(r => r.phase).sort(), outcome === 'complete' ? ['plan', 'report'] : ['plan']);
  assert.equal(new Set(reservations.map(r => r.authorizationId)).size, 1);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  for (const request of captured) {
    const reservation = reservations.find(r => r.phase === request.phase);
    assert.equal(reservation.requestDigest, createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex'));
    assert.equal(request.approvedJobInput.jobId, jobId); assert.deepEqual(request.approvedJobInput, approvedInput(job));
    assert.equal(reservation.jobId, jobId); assert.equal(reservation.ownerId, approved.ownerId);
    assert.equal(reservation.state, outcome === 'complete' ? 'COMPLETED_VERIFIED' : 'RESERVED_NO_AUTOMATIC_REFUND');
  }
  assert.deepEqual(captured[0].approvedSources, approvedSources(approved.approved));
  const grants = collection('modelGrants');
  assert.equal(grants.length, 1); assert.equal(grants[0].calls, reservations.length);
  const total = reservations.reduce((sum, r) => sum + BigInt(r.reservedCostMicros), 0n);
  assert.equal(BigInt(grants[0].reservedCostMicros), total); assert.ok(total <= 50000n);
  const release = await h.repository.runTransaction(tx => tx.get('modelReleaseSpend', NEAR_AI_RELEASE.key));
  assert.deepEqual(release, { maxCostMicros: NEAR_AI_RELEASE.maxCostMicros, reservedCostMicros: String(total) });
  assert.ok(total <= BigInt(NEAR_AI_RELEASE.maxCostMicros));
  assert.equal(grants[0].reservedTokens, reservations.reduce((n, r) => n + r.reservedTokens, 0));
  if (outcome === 'complete') {
    assert.equal(first.body.run.stage, 'COMPLETE'); assert.equal(first.body.orders.length, 2);
    assert.ok(first.body.orders.every(r => r.order.lifecycle === 'DELIVERED'));
    assert.equal(first.body.run.report.supplierVerified, false); assert.equal(first.body.run.report.facts.length, 2);
    assert.deepEqual(first.body.run.report.interpretations, [{ kind: 'COMPARE_SOURCE_CONSISTENCY', findingIndexes: [0, 1] }]);
    for (const field of ['proofId', 'transactionHash']) assert.equal(new Set(first.body.orders.map(r => r.order.proof[field])).size, 2);
    assert.equal(new Set(first.body.orders.map(r => r.order.artifact.artifactId)).size, 2);
    assert.equal(new Set(first.body.orders.map(r => r.order.artifact.contentDigest)).size, 2);
    assert.deepEqual(captured.map(r => r.phase), ['plan', 'report']);
    assert.deepEqual(captured[1].evidence, first.body.orders.map(r => r.order.artifact));
    assert.equal(collection('nativeOperations').length, 2); assert.equal(collection('claims').length, 2); assert.equal(collection('deliveries').length, 2);
    for (const name of ['nativeOperations', 'claims', 'deliveries']) assert.ok(collection(name).every(r => r.jobId === jobId));
    assert.equal(records.filter(r => r.phase === 'BROADCAST_INTENT').length, 2);
    assert.equal(records.filter(r => r.proof && r.quoteId && !r.orderId).length, 2);
    assert.equal(records.filter(r => r.artifactId && r.artifact).length, 2);
    assert.deepEqual(wire.counts, { signs: 2, sends: 2 });
    assert.deepEqual(verifiedIds, ['closed-completion-1', 'closed-completion-2']);
    for (const r of reservations) { assert.equal(r.verification.e2ee, true); assert.equal(r.verification.signatureKind, 'provider_tee'); assert.equal(r.verification.signatureLookups, 1); }
  } else {
    assert.notEqual(first.body.run.stage, 'COMPLETE');
    assert.ok(first.body.orders.every(r => r.payment.status === 'NOT_STARTED' && r.order.proof === null && r.order.artifact === null));
    assert.deepEqual(wire.counts, { signs: 0, sends: 0 });
    for (const name of ['nativeOperations', 'claims', 'deliveries']) assert.equal(collection(name).length, 0);
    assert.equal(counts.verification, 0);
  }
  assert.equal(counts.inference, reservations.length); assert.equal(counts.cacheClears, reservations.length);
  assert.ok(sdkOptions.every(o => o.e2ee && o.baseUrl === 'https://cloud-api.near.ai/v1'));
  const stableFinancial = rows().filter(r => /modelGrants|modelReservations|modelReleaseSpend|native|claims|deliveries/.test(r.key));
  const effects = { inference: counts.inference, verification: counts.verification, ...wire.counts };
  assert.deepEqual((await h.request(`${path}/resume`)).body, first.body);
  const reopened = h.open(); construct(reopened);
  const server = createServer(publicModule.createPublicJourney({ ...h.config, repository: reopened }).handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const request = (route, body = {}) => call(`http://127.0.0.1:${server.address().port}`, route, body, { headers: { cookie: h.alice } });
  assert.deepEqual((await request(`${path}/resume`)).body, first.body);
  assert.deepEqual({ inference: counts.inference, verification: counts.verification, ...wire.counts }, effects);
  assert.deepEqual(rows().filter(r => /modelGrants|modelReservations|modelReleaseSpend|native|claims|deliveries/.test(r.key)), stableFinancial);
  // Exercise facade cache reconstruction itself; runner completion can bypass it.
  const sources = approvedSources(approved.approved), plan = { phase: 'plan', approvedJobInput: approvedInput(job), approvedSources: sources,
    tools: [{ name: 'requestquotes', approvedSources: sources }] };
  if (outcome === 'complete') {
    assert.deepEqual(await model.propose(plan), reservations.find(r => r.phase === 'plan').result);
    assert.deepEqual(await model.propose({ phase: 'report', approvedJobInput: approvedInput(job), evidence: first.body.orders.map(r => r.order.artifact), tools: [] }),
      reservations.find(r => r.phase === 'report').result);
  } else await assert.rejects(model.propose(plan), { code: 'MODEL_OUTCOME_UNKNOWN' });
  assert.deepEqual({ inference: counts.inference, verification: counts.verification, ...wire.counts }, effects);
  // Closing model admission does not close owner read/stop/withdraw recovery.
  const closed = createServer(publicModule.createPublicJourney({ ...h.config, repository: reopened, model: undefined }).handle);
  await new Promise(r => closed.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => closed.close(r)));
  const closedRequest = (route, body = {}) => call(`http://127.0.0.1:${closed.address().port}`, route, body, { headers: { cookie: h.alice } });
  assert.equal((await closedRequest('/api/public/config')).body.financialActions, false);
  assert.equal((await closedRequest('/api/public/jobs', { approvalId: 'approved', admissionKey: 'closed' })).status, 503);
  assert.equal((await closedRequest(`${path}/run`)).status, 503);
  assert.equal((await closedRequest(path)).status, 200);
  for (const [i, action] of ['stop', 'withdraw'].entries()) {
    const prepared = await closedRequest(`${path}/owner/prepare`, { action });
    assert.equal(prepared.status, 200, prepared.text); assert.equal(prepared.body.walletEligible, true);
    const receipt = await closedRequest(`${path}/owner/receipt`, { operationId: prepared.body.operation.operationId,
      transactionHash: baseEncode(new Uint8Array(32).fill(70 + i)), signerId: approved.ownerId });
    assert.equal(receipt.status, 200, receipt.text); assert.equal(receipt.body.operation.status, 'CONFIRMED');
  }
  const finalView = await closedRequest(path); assert.equal(finalView.status, 200, finalView.text);
  assert.equal(finalView.body.job.state, 'STOPPED'); assert.equal(finalView.body.ownerOperations[1].receipt.amountAtomic, residualAtomic);
  assert.deepEqual(ownerCounts, { prepare: 2, reconcile: 2 });
  assert.deepEqual({ inference: counts.inference, verification: counts.verification, ...wire.counts }, effects);
  assert.equal(counts.forbiddenNetwork, 0);
  assert.equal(JSON.stringify(rows()).includes('CLOSED_SYNTHETIC_AI_KEY_ONLY'), false);
  assert.equal(first.text.includes('signedTransaction'), false);
  t.diagnostic(JSON.stringify({ qualification: 'CLOSED_SYNTHETIC_LOCAL_HTTP_ONLY', outcome, ...counts, ...wire.counts,
    reservations: reservations.length, grants: grants.length, reservedCostMicros: String(total), ownerPrepare: ownerCounts.prepare, ownerReconcile: ownerCounts.reconcile }));
});

// Recovery successor: ordinary HTTP admission and actual default-budget facade.
// Only provider/RPC responses are synthetic. No seeded job or completed run.
async function recoveryHttpFixture(t, { lostPhase = null } = {}) {
  const { createNearAiRunnerPort } = await import('../../deployment/haldir-public/near-ai-runner-port.mjs');
  const wire = nativeWire(t, { two: true, loseSend: true });
  const approved = await wire.trustedManifestProvider();
  const counts = { inference: 0, propose: 0, recover: 0, injected: 0, forbidden: 0 };
  const phases = [], signals = [];
  const nativeFetch = globalThis.fetch, connect = net.Socket.prototype.connect;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if (String(url) !== approved.rpcUrl) { counts.forbidden++; throw new Error('CLOSED_NETWORK'); }
    return nativeFetch(url, init);
  });
  t.mock.method(net.Socket.prototype, 'connect', function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (typeof options !== 'object' || !['127.0.0.1', '::1'].includes(options.host)) { counts.forbidden++; throw new Error('CLOSED_SOCKET'); }
    return connect.apply(this, args);
  });
  t.mock.method(tls, 'connect', () => { counts.forbidden++; throw new Error('CLOSED_TLS'); });
  let model, signerProvider;
  const forwarding = {
    contractVersion: 'haldir.model.runner-recovery.v1',
    propose: input => { counts.propose++; return model.propose(input); },
    recover: async input => {
      counts.recover++; assert.ok(input.signal instanceof AbortSignal && !input.signal.aborted, 'recovery receives a live shared scope'); signals.push(input.signal);
      const before = financial(), inference = counts.inference;
      try { return await model.recover(input); }
      finally { assert.deepEqual(financial(), before, 'cache recovery writes no budget/payment/delivery'); assert.equal(counts.inference, inference); }
    },
  };
  const h = await httpFixture(t, { ...wire, modelRuntime: null, model: forwarding,
    trustedSignerProvider: async input => {
      const signer = await signerProvider(input);
      return { getPublicKey: () => signer.getPublicKey(), signTransaction: tx => { wire.counts.signs++; return signer.signTransaction(tx); } };
    },
  });
  const rows = () => [...h.shared.records].map(([key, r]) => ({ key, value: JSON.parse(r.fields.json.stringValue) }));
  const collection = name => rows().filter(r => r.key.includes(`/namespaces/haldirPreviewTestnetV1/${name}/`)).map(r => r.value);
  const financial = () => rows().filter(r => /modelGrants|modelReservations|modelReleaseSpend|native|claims|deliveries/.test(r.key));
  assert.equal(collection('jobs').length, 0);
  const admitted = await h.request('/api/public/jobs', { approvalId: 'approved', admissionKey: 'recovery' });
  assert.equal(admitted.status, 201, admitted.text);
  const jobId = admitted.body.job.jobId, path = `/api/public/jobs/${jobId}`;
  const catalog = [{ ownerId: approved.ownerId, jobId, manifest: structuredClone(approved), keyVersion: 'closed-recovery-v1' }];
  signerProvider = createTrustedAgentSignerProvider({ catalog, resolveKeyMaterial: async ({ signal }) => {
    assert.equal(signal.aborted, false); return agentKey.toString();
  } });
  const transportFactory = ({ apiKey, signal }) => createNearAiTransport({ apiKey, signal,
    run: async input => ({ ok: true, ...await verifiedCompletion(input, async () => ({
      sdkVersion: '0.3.0', getSdkError: () => null, pause: async () => assert.fail('no retry'),
      client: {
        fetch: async (url, init) => {
          assert.equal(url, NEAR_AI_ENDPOINT);
          const body = JSON.parse(init.body), request = JSON.parse(body.messages[1].content);
          counts.inference++; phases.push(request.phase);
          const result = request.phase === 'plan'
            ? { tool: 'requestquotes', arguments: { quoteIds: request.approvedSources.map(s => s.quoteId) } }
            : { findings: request.evidence.map(a => ({ artifactId: a.artifactId, excerpt: a.content.slice(0, 80) })), interpretations: [{ kind: 'COMPARE_SOURCE_CONSISTENCY', findingIndexes: [0, 1] }] };
          return Response.json({ id: `recovery-${counts.inference}`, model: body.model,
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result) } }],
            usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } });
        },
        verifyResponse: async id => ({ id, signatureKind: 'provider_tee' }), clearResponseCache: () => {},
      },
    })) }),
  });
  const construct = (repository = h.repository, intercept = false) => {
    const observed = { async runTransaction(cb) {
      let committed = false;
      const result = await repository.runTransaction(tx => cb({ ...tx,
        set(c, k, v) { if (intercept && !counts.injected && c === 'modelReservations' && v.phase === lostPhase && v.state === 'COMPLETED_VERIFIED') committed = true; tx.set(c, k, v); },
      }));
      if (committed) { counts.injected++; throw new Error('VERIFIED_RESULT_COMMITTED_OUTWARD_LOSS'); }
      return result;
    } };
    model = createNearAiRunnerPort({ repository: observed, apiKey: 'CLOSED_RECOVERY_AI_KEY',
      authorizationExpiresAt: '2026-11-16T23:59:00Z', now: () => time, transportFactory });
    return model;
  };
  construct(h.repository, true);
  return { ...h, wire, approved, counts, phases, signals, collection, financial, construct, path, jobId,
    get model() { return model; }, reopen: async (patch = {}) => {
      const repository = h.open(); construct(repository);
      const server = createServer(publicModule.createPublicJourney({ ...h.config, repository, ...patch }).handle);
      await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
      return (route, body = {}) => call(`http://127.0.0.1:${server.address().port}`, route, body, { headers: { cookie: h.alice } });
    } };
}

for (const phase of ['plan', 'report']) test(`TS1 E1 HTTP adopts persisted ${phase} after outward loss without replaying its inference`, async t => {
  const h = await recoveryHttpFixture(t, { lostPhase: phase });
  const first = await h.request(`${h.path}/run`);
  assert.equal(first.status, 200, first.text); assert.equal(h.counts.injected, 1, 'semantic completed-result injection fired');
  assert.notEqual(first.body.run.stage, 'COMPLETE');
  const saved = h.collection('modelReservations').find(r => r.phase === phase);
  assert.equal(saved.state, 'COMPLETED_VERIFIED');
  assert.equal(h.collection('publicRunGuards')[0].status, 'IDLE');
  const before = h.financial(), effects = { ...h.wire.counts, inference: h.counts.inference };
  const request = await h.reopen(), resumed = await request(`${h.path}/resume`);
  assert.equal(resumed.status, 200, resumed.text); assert.equal(resumed.body.run.stage, 'COMPLETE');
  assert.equal(h.counts.recover, 1); assert.ok(h.signals.every(s => s instanceof AbortSignal && s.aborted), 'recovery capability is closed after return');
  assert.deepEqual(h.phases, ['plan', 'report']); assert.equal(h.collection('modelReservations').length, 2);
  assert.equal(h.collection('modelGrants')[0].calls, 2); assert.deepEqual(h.wire.counts, { signs: 2, sends: 2 });
  if (phase === 'report') { assert.deepEqual(h.financial(), before); assert.deepEqual({ ...h.wire.counts, inference: h.counts.inference }, effects); }
  assert.deepEqual((await request(`${h.path}/resume`)).body, resumed.body);
  assert.equal(h.counts.forbidden, 0);
});

for (const phase of ['plan', 'report']) test(`TS1 E2 HTTP proven ${phase} cap denial remains explicit-resume-only under unchanged ceiling`, async t => {
  const h = await recoveryHttpFixture(t), propose = h.config.model.propose;
  let denying = false, exhausted = false; const deniedWrites = [];
  h.shared.onCommit = request => {
    if (denying) deniedWrites.push(...request.writes.filter(w => /\/(modelReservations|modelGrants|modelReleaseSpend)\//.test(w.update.name)));
  };
  const exhaust = () => h.repository.runTransaction(tx => tx.set('modelReleaseSpend', NEAR_AI_RELEASE.key,
    { maxCostMicros: NEAR_AI_RELEASE.maxCostMicros, reservedCostMicros: NEAR_AI_RELEASE.maxCostMicros }));
  if (phase === 'plan') { await exhaust(); exhausted = true; }
  h.config.model.propose = async input => {
    if (input.phase === phase && !exhausted) { await exhaust(); exhausted = true; }
    denying = input.phase === phase;
    try { return await propose(input); } finally { denying = false; }
  };
  const first = await h.request(`${h.path}/run`);
  assert.equal(first.status, 200, first.text);
  const denied = await h.repository.runTransaction(tx => tx.get('agentRuns', h.jobId));
  assert.equal(denied.modelNotAdmitted?.[phase], true, 'only normal facade positive denial is resumable');
  assert.equal(h.counts.propose, phase === 'plan' ? 1 : 2, 'no automatic admission loop');
  assert.equal(h.counts.inference, phase === 'plan' ? 0 : 1);
  assert.equal(h.collection('modelReservations').some(r => r.phase === phase), false);
  assert.equal(h.collection('modelGrants').length, phase === 'plan' ? 0 : 1);
  if (phase === 'report') assert.equal(h.collection('modelGrants')[0].calls, 1);
  assert.equal(first.text.includes('modelNotAdmitted'), false); assert.equal(first.text.includes('MODEL_NOT_SENT'), false);
  const stable = h.financial(), effects = { ...h.wire.counts, inference: h.counts.inference }, calls = h.counts.propose;
  const request = await h.reopen(), second = await request(`${h.path}/resume`);
  assert.equal(second.status, 200, second.text);
  assert.equal(h.counts.propose, calls + 1, 'one explicit new admission, unchanged cap still denies');
  assert.deepEqual(h.financial(), stable); assert.deepEqual({ ...h.wire.counts, inference: h.counts.inference }, effects);
  assert.equal(h.collection('agentRuns')[0].modelNotAdmitted[phase], true);
  assert.deepEqual(deniedWrites, [], 'both normal denied admissions make zero phase/grant/release writes');
  assert.equal(h.counts.forbidden, 0);
});

for (const phase of ['plan', 'report']) test(`TS1 E1 HTTP adopts pending ${phase} after runner acceptance persistence loss`, async t => {
  const h = await recoveryHttpFixture(t); let injected = false;
  h.shared.onCommit = async request => {
    const rows = request.writes.map(w => JSON.parse(w.update.fields.json.stringValue));
    if (!injected && rows.some(r => r.schemaVersion === 'haldir.agent-run.two-source.v1' &&
      (phase === 'plan' ? r.planState === 'ACCEPTED' : r.stage === 'COMPLETE'))) {
      injected = true; throw new Error('RUNNER_ACCEPTANCE_NOT_PERSISTED');
    }
  };
  const first = await h.request(`${h.path}/run`); assert.ok(first.status >= 400, first.text); assert.equal(injected, true);
  assert.equal(h.collection('modelReservations').find(r => r.phase === phase).state, 'COMPLETED_VERIFIED');
  const unfinished = h.collection('agentRuns')[0];
  assert.equal(phase === 'plan' ? unfinished.planState : unfinished.stage, phase === 'plan' ? 'PENDING' : 'REPORT_PENDING');
  const before = h.financial();
  const request = await h.reopen(), resumed = await request(`${h.path}/resume`);
  assert.equal(resumed.status, 200, resumed.text); assert.equal(resumed.body.run.stage, 'COMPLETE');
  assert.equal(h.counts.recover, 1); assert.deepEqual(h.phases, ['plan', 'report']);
  if (phase === 'report') assert.deepEqual(h.financial(), before);
  assert.deepEqual(h.wire.counts, { signs: 2, sends: 2 }); assert.equal(h.counts.forbidden, 0);
});

for (const reason of ['stop', 'deadline']) test(`TS1 E1 HTTP ${reason} after cache adoption blocks every new signature`, async t => {
  const h = await recoveryHttpFixture(t, { lostPhase: 'plan' });
  assert.equal((await h.request(`${h.path}/run`)).status, 200); assert.equal(h.counts.injected, 1);
  const recover = h.config.model.recover; let injected = false;
  h.config.model.recover = async input => {
    const result = await recover(input); injected = true;
    if (reason === 'stop') await h.repository.runTransaction(async tx => {
      const job = await tx.get('jobs', h.jobId); tx.set('jobs', h.jobId, { ...job, state: 'LOCAL_STOPPED' });
    });
    else h.setClock(Date.parse(h.approved.approved.job.expiresAt));
    return result;
  };
  const resumed = await h.request(`${h.path}/resume`);
  assert.equal(resumed.status, 200, resumed.text); assert.equal(injected, true);
  assert.equal(resumed.body.run.stage, 'BLOCKED'); assert.equal(h.collection('agentRuns')[0].planState, 'ACCEPTED');
  assert.deepEqual(h.wire.counts, { signs: 0, sends: 0 }); assert.equal(h.counts.inference, 1);
  assert.equal(h.collection('nativeOperations').length, 0); assert.equal(h.collection('modelGrants')[0].calls, 1);
});

for (const state of ['absent', 'consumed']) test(`TS1 E1 HTTP ${state} result never becomes proven not-admitted or fresh inference`, async t => {
  const h = await recoveryHttpFixture(t, { lostPhase: state === 'consumed' ? 'plan' : null });
  if (state === 'absent') h.config.model.propose = async () => { throw new Error('unknown outward pre-adoption failure'); };
  assert.equal((await h.request(`${h.path}/run`)).status, 200);
  if (state === 'consumed') {
    assert.equal(h.counts.injected, 1);
    const row = h.collection('modelReservations')[0];
    await h.repository.runTransaction(async tx => {
      const key = publicModule.publicModelReservationKey(row.authorizationId, h.jobId, 'plan');
      const prior = await tx.get('modelReservations', key);
      tx.set('modelReservations', key, { ...prior, state: 'RESERVED_NO_AUTOMATIC_REFUND' });
    });
  }
  const stable = h.financial(), inference = h.counts.inference, calls = h.counts.propose;
  const request = await h.reopen();
  for (let i = 0; i < 2; i++) {
    const resumed = await request(`${h.path}/resume`); assert.equal(resumed.status, 200, resumed.text);
    assert.notEqual(resumed.body.run.stage, 'COMPLETE');
    assert.notEqual(h.collection('agentRuns')[0].modelNotAdmitted?.plan, true);
  }
  assert.equal(h.counts.propose, calls); assert.equal(h.counts.inference, inference);
  assert.deepEqual(h.financial(), stable); assert.deepEqual(h.wire.counts, { signs: 0, sends: 0 });
});

test('TS1 E1 HTTP ACTIVE guard excludes a simultaneous cache adopter without takeover', async t => {
  const h = await recoveryHttpFixture(t, { lostPhase: 'report' });
  assert.equal((await h.request(`${h.path}/run`)).status, 200); assert.equal(h.counts.injected, 1);
  const entered = deferred(), release = deferred(), recover = h.config.model.recover;
  h.config.model.recover = async input => { entered.resolve(); await release.promise; return recover(input); };
  const first = h.request(`${h.path}/resume`); await entered.promise;
  const active = h.collection('publicRunGuards')[0]; assert.equal(active.status, 'ACTIVE');
  const second = await h.request(`${h.path}/resume`); assert.equal(second.status, 409); assert.equal(second.body.error, 'RUN_IN_PROGRESS');
  assert.deepEqual(h.collection('publicRunGuards')[0], active);
  release.resolve(); const result = await first; assert.equal(result.status, 200, result.text); assert.equal(result.body.run.stage, 'COMPLETE');
  assert.equal(h.counts.recover, 1); assert.equal(h.counts.inference, 2); assert.deepEqual(h.wire.counts, { signs: 2, sends: 2 });
});

test('TS1 E1 HTTP cache recovery shares the bounded abort and cannot release a late saved plan into payment', async t => {
  const h = await recoveryHttpFixture(t, { lostPhase: 'plan' });
  assert.equal((await h.request(`${h.path}/run`)).status, 200); assert.equal(h.counts.injected, 1);
  const recover = h.config.model.recover; let entered = false, aborted = false;
  h.config.model.recover = async input => {
    const result = await recover(input); entered = true;
    await new Promise(resolve => {
      const done = () => { aborted = input.signal.aborted; resolve(); };
      if (input.signal.aborted) done(); else input.signal.addEventListener('abort', done, { once: true });
    });
    return result; // A late trusted result is still fenced by the host scope.
  };
  const stable = h.financial(), request = await h.reopen({ maxRunMs: 200 });
  const result = await request(`${h.path}/resume`);
  assert.equal(entered, true); assert.equal(aborted, true); assert.equal(result.status, 503, result.text);
  assert.equal(result.body.error, 'EXECUTION_DEADLINE');
  assert.deepEqual(h.financial(), stable); assert.deepEqual(h.wire.counts, { signs: 0, sends: 0 });
  assert.equal(h.collection('publicRunGuards')[0].status, 'IDLE'); assert.equal(h.counts.inference, 1);
});
