import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from '../node_modules/vite/dist/node/index.js';
import { chromium } from '../node_modules/@playwright/test/index.mjs';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { KeyPair, KeyPairSigner, SignedTransaction, baseEncode } from 'near-api-js';
import { syntheticPayment } from '../../src/vendor/fixture.mjs';
import { createPublicJourney } from '../../src/server/public-journey.mjs';
import { createWalletAuthHttp } from '../../src/server/wallet-auth-http.mjs';
import { createPublicOrders, openLocalRepository } from '../../src/server/orders.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.HALDIR_EVIDENCE_DIR ? process.env.HALDIR_EVIDENCE_DIR.replace(/\/?$/, '/') : fileURLToPath(new URL(`../../.hermes/reviews/haldir-two-source-ui-evidence/chrome-${Date.now()}/`, import.meta.url));
const origin = 'https://public-ui.invalid'; // intercepted component/client fixture; no live TLS/session proof
const principal = { sessionId: 'a'.repeat(64), accountId: 'owner.testnet', publicKey: 'ed25519:' + '1'.repeat(32), networkId: 'testnet', origin, recipient: 'public-ui.invalid', expiresAt: Date.now() + 900000, authenticationOnly: true };
const config = { contractVersion: 'haldir.public.v1', networkId: 'testnet', financialActions: true, missingConfiguration: [], vendorData: 'FICTIONAL_SAMPLE', maxRunMs: 15000 };
function view(stage) {
  const delivered = stage === 'returned', paid = delivered || stage === 'partial';
  return { contractVersion: 'haldir.public.v1', job: { jobId: 'job-1', ownerId: principal.accountId, state: delivered ? 'STOPPED' : 'ACTIVE', manifestId: 'manifest-1', qualification: 'PUBLIC_TESTNET_FICTIONAL_VENDOR', scope: { purpose: 'Review fictional supplier', output: 'Evidence-linked report', budgetAtomic: '1000000000000000000000000', mandateId: 'mandate.testnet' } },
    order: { jobId: 'job-1', orderId: 'quote-1', quote: { amountAtomic: '123456789012345678901234', vendorId: 'vendor.testnet' }, lifecycle: delivered ? 'DELIVERED' : paid ? 'PAID_NOT_DELIVERED' : 'PAYMENT_PENDING', proof: paid ? { proofId: 'proof-1', transactionHash: '1'.repeat(32) } : null,
      artifact: delivered ? { fictionalSample: true, artifactId: 'artifact-1', contentDigest: 'c'.repeat(64), content: 'FICTIONAL SAMPLE: company records for a fictional supplier.' } : null },
    payment: { status: paid ? 'SUBMITTED' : 'ATTENTION_REQUIRED', transactionHash: paid ? '1'.repeat(32) : null },
    run: paid ? { stage: delivered ? 'COMPLETE' : 'WAITING_DELIVERY', report: { status: delivered ? 'EVIDENCE_REVIEW_REQUIRED' : 'PARTIAL', supplierVerified: false, findings: delivered ? [{ excerpt: 'Fictional records are a sample, not a verified company finding.', artifactId: 'artifact-1', proofId: 'proof-1' }] : [], missing: delivered ? [] : ['Delivery missing'] } } : null,
    ownerOperations: [{ operationId: 'a'.repeat(64), action: 'create', status: 'CONFIRMED', request: null, signerId: principal.accountId, transactionHash: '1'.repeat(32), receipt: null },
      { operationId: 'b'.repeat(64), action: 'withdraw', status: delivered ? 'CONFIRMED' : 'UNKNOWN', request: null, signerId: principal.accountId, transactionHash: delivered ? '1'.repeat(32) : null,
        receipt: delivered ? { finality: 'final', networkId: 'testnet', ownerId: principal.accountId, signerId: principal.accountId, mandateId: 'mandate.testnet', action: 'withdraw', transactionHash: '1'.repeat(32), amountAtomic: '765432109876543210987654', receiptId: 'return-receipt' } : null }],
    disclosures: { vendorData: 'FICTIONAL_SAMPLE', supplierVerified: false, principalReturn: 'Only a confirmed withdraw receipt establishes returned principal; free balance is not a refund' } };
}

test('installed Chrome: real App/auth session client/public controller, no prompts; unknown/partial/report/observed return and narrow shared styles', { timeout: 90000 }, async t => {
  await mkdir(evidence, { recursive: true });
  const output = await build({ root, configFile: root + 'vite.config.ts', logLevel: 'warn', define: { 'import.meta.env.VITE_HALDIR_APPROVED_ORIGIN': JSON.stringify(origin) }, build: { write: false } });
  assert.ok(!Array.isArray(output));
  const assets = new Map(output.output.map(x => ['/' + x.fileName, x.type === 'chunk' ? x.code : x.source]));
  for (const name of ['Manrope[wght].ttf', 'OFL.txt', 'METADATA.pb']) assets.set('/fonts/manrope/' + name, await readFile(root + 'public/fonts/manrope/' + name));
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' }); t.after(() => context.close());
  let stage = 'unknown'; const requests = [], denied = [], errors = [], screenshots = [];
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin && req.method() === 'GET' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: assets.get('/index.html') });
    if (url.origin === origin && req.method() === 'GET' && assets.has(decodeURI(url.pathname))) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.ttf') ? 'font/ttf' : 'image/png', body: assets.get(decodeURI(url.pathname)) });
    if (url.origin === origin && (url.pathname === '/api/wallet-auth/session' || url.pathname.startsWith('/api/public/'))) {
      assert.equal(req.headers()['x-haldir-csrf'], '1'); assert.equal(req.headers().authorization, undefined);
      const path = url.pathname; requests.push({ path, method: req.method(), body: req.postDataJSON(), origin: req.headers().origin ?? null, secFetchSite: req.headers()['sec-fetch-site'] ?? null });
      let data;
      if (path === '/api/wallet-auth/session') { assert.equal(req.method(), 'POST'); data = { principal }; }
      else if (path === '/api/public/config') { assert.equal(req.method(), 'POST'); data = config; }
      else if (path === '/api/public/jobs') { assert.equal(req.method(), 'POST'); assert.deepEqual(req.postDataJSON(), { approvalId: 'approved-1', admissionKey: 'admission-1' }); data = view(stage); }
      else if (path === '/api/public/jobs/job-1') { assert.equal(req.method(), 'POST'); assert.deepEqual(req.postDataJSON(), {}); data = view(stage); }
      else throw new Error('UNEXPECTED_FINANCIAL_ROUTE:' + path);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    }
    denied.push(req.url()); return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', socket => { denied.push(socket.url()); socket.close(); });
  await context.addInitScript(() => { window.__opens = 0; window.open = () => { window.__opens++; throw new Error('WALLET_PROMPT_FORBIDDEN'); }; });
  // This incumbent v1 observation fixture resumes its already-owned job.
  // New admission is exercised through trusted TS1 review in the HTTP lane.
  await context.addInitScript(({origin}) => localStorage.setItem(`haldir-public-job-v1:${origin}:owner.testnet`,'job-1'),{origin});
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/?mode=public-testnet');
  // Wait for the normal auth/session and same-job read effects.
  await page.getByText('ATTENTION_REQUIRED', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('public-returned-amount').textContent(), 'Not observed');
  assert.equal(await page.getByRole('button', { name: 'Approve owner withdrawal in wallet' }).isDisabled(), true);
  for (const state of ['unknown', 'partial', 'returned']) {
    stage = state;
    await page.getByRole('button', { name: 'Check same job and owner receipts' }).click();
    await page.getByRole('button', { name: 'Check same job and owner receipts' }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('button')?.disabled);
    if (state === 'partial') await page.getByText('Payment receipt observed; delivery missing.', { exact: false }).waitFor();
    if (state === 'returned') await page.getByTestId('public-returned-amount').filter({ hasText: '765432109876543210987654' }).waitFor();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByTestId('public-returned-amount').scrollIntoViewIfNeeded();
      await page.evaluate(() => document.fonts.ready);
      try { await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.conversation-content')].every(e => e.scrollWidth <= e.clientWidth), null, { timeout: 3000 }); }
      catch (error) { console.error('overflow-detail', state, width, await page.evaluate(() => [...document.querySelectorAll('.conversation-content, .conversation-content *')].filter(e => e.scrollWidth > e.clientWidth).map(e => ({ tag: e.tagName, cls: e.className, text: e.textContent?.slice(0, 100), client: e.clientWidth, scroll: e.scrollWidth, rect: e.getBoundingClientRect().toJSON() })))); throw error; }
      const overflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth > innerWidth, content: [...document.querySelectorAll('.conversation-content')].some(e => e.scrollWidth > e.clientWidth) }));
      if (overflow.content) { await page.screenshot({ path: evidence + `overflow-${state}-${width}.png` }); console.error(await page.evaluate(() => [...document.querySelectorAll('.conversation-content *')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => ({ tag: e.tagName, className: e.className, text: e.textContent?.slice(0, 80), client: e.clientWidth, scroll: e.scrollWidth })))); }
      assert.deepEqual(overflow, { document: false, content: false }, `${state} ${width} overflow`);
      const name = `chrome-${state}-${width}.png`; await page.screenshot({ path: evidence + name }); screenshots.push(name);
    }
  }
  const beforeReload = requests.filter(x => x.path === '/api/public/jobs').length;
  await page.reload(); await page.getByTestId('public-returned-amount').filter({ hasText: '765432109876543210987654' }).waitFor();
  assert.equal(requests.filter(x => x.path === '/api/public/jobs').length, beforeReload, 'reload reads the same persisted job, not create');
  assert.equal(await page.evaluate(() => window.__opens), 0);
  assert.equal(requests.some(x => /owner|pay|run|resume/.test(x.path) && !x.path.startsWith('/api/wallet-auth/')), false);
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  await writeFile(evidence + 'component-chrome-receipt.json', JSON.stringify({ status: 'PASS_COMPONENT_AND_CLIENT_FIXTURE_ONLY', screenshots, requests, errors, denied, realWalletPrompt: false, actualCookieOrChainAcceptance: false }, null, 2));
});

// Browser-native headers are relayed unchanged (except the explicit virtual
// Host) to an owned loopback HTTP listener. No route.fulfill public/auth data.
// Synthetic session rows/readers/owner observations, NOT login/TLS/chain proof.
for (const scenario of ['normal', 'prepare-loss', 'prepare-provider-unavailable', 'provider-retry', 'stale-contexts', 'precommit-rate-limit', 'deployed-no-creation', 'deployed-with-creation', 'factory-replay', 'two-source']) test(`installed Chrome real HTTP handlers: ${scenario}`, { timeout: 90000 }, async t => {
  const ts1 = scenario === 'two-source';
  const syntheticLogin = generateKeyPairSync('ed25519');
  const loginPublicKey = 'ed25519:' + baseEncode(syntheticLogin.publicKey.export({format:'der',type:'spki'}).subarray(-32));
  const loginPkcs8 = [...syntheticLogin.privateKey.export({format:'der',type:'pkcs8'})];
  const agentKey = KeyPair.fromRandom('ed25519'), signer = new KeyPairSigner(agentKey), chainEvidence = new Map();
  const nativeCalls = {signs:0,sends:0};
  let revealEvidence = !ts1;
  const losePrepare = scenario === 'prepare-loss', runLane = scenario.startsWith('deployed-') || scenario === 'factory-replay';
  const retryLane = scenario === 'provider-retry', staleLane = scenario === 'stale-contexts';
  const providerUnavailable = scenario === 'prepare-provider-unavailable' || retryLane, uncertainPrepare = losePrepare || providerUnavailable;
  let releasePreparation, preparationEntered;
  const heldPreparation = new Promise(resolve => { releasePreparation = resolve; });
  const preparationStarted = new Promise(resolve => { preparationEntered = resolve; });
  const repository = openLocalRepository({ filename: ':memory:', localTestOnly: true });
  t.after(() => repository.close());
  let clock = Date.now();
  const hash = '1'.repeat(32), ownerId = 'owner.testnet', rateLane = scenario === 'precommit-rate-limit';
  const calls = { manifests: 0, prepare: 0, reconcile: 0, prompts: 0, forbiddenFetch: 0, signer: 0, model: 0 };
  let keyPresent = true, prepareResponseLost = false;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => { calls.forbiddenFetch++; throw new Error('RPC_AND_PROVIDER_FETCH_FORBIDDEN'); };
  t.after(() => { globalThis.fetch = savedFetch; });
  const manifest = { manifestId: 'manifest-closed', ownerId,
    approved: { job: { networkId: 'testnet', mandateId: 'mandate.testnet', purpose: 'Fictional existing job', output: 'Evidence report', budgetAtomic: '30', vendorIds: ['vendor.testnet'], expiresAt: new Date(clock + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z') },
      quote: { networkId: 'testnet', mandateId: 'mandate.testnet', vendorId: 'vendor.testnet', amountAtomic: '8', orderId: 'quote-closed', content: 'FICTIONAL SAMPLE' } },
    binding: { networkId: 'testnet', ownerId, signerId: 'agent.testnet', mandateId: 'mandate.testnet', publicKey: 'ed25519:' + hash, maxAllowanceAtomic: '1000', codeHash: hash },
    rpcUrl: 'https://closed-rpc.invalid', allowedRpcUrls: ['https://closed-rpc.invalid'],
    chainEvidence: { networkId: 'testnet', finality: 'final', blockHash: hash, blockHeight: 123, observedAt: clock } };
  if (runLane) manifest.chainEvidence.deployment = scenario === 'factory-replay' ? 'FACTORY_READY' : 'MANDATE_READY';
  if (scenario === 'deployed-with-creation' || scenario === 'factory-replay') {
    manifest.creation = { factory: 'factory.testnet', job_label: 'closed', operating_float: '10', create_gas: '250000000000000', factoryCodeHash: hash };
    const child = 'j' + createHash('sha256').update(`${ownerId}:closed`).digest('hex').slice(0, 32) + '.factory.testnet';
    manifest.binding.mandateId = child; manifest.approved.job.mandateId = child; manifest.approved.quote.mandateId = child;
  }
  if (ts1) {
    const first = manifest.approved.quote;
    manifest.approved = {schemaVersion:'haldir.approved.two-source.v1',job:{...manifest.approved.job,vendorIds:[first.vendorId,'second.testnet']},sources:[{sourceId:'company-records',quote:first},{sourceId:'background-research',quote:{...first,vendorId:'second.testnet',orderId:'second-quote',content:'Second fictional background sample',amountAtomic:'9'}}]};
    const child = 'j' + createHash('sha256').update(`${ownerId}:closed`).digest('hex').slice(0,32) + '.factory.testnet';
    manifest.creation = {factory:'factory.testnet',job_label:'closed',operating_float:'10',create_gas:'250000000000000',factoryCodeHash:hash};
    manifest.binding.publicKey = agentKey.getPublicKey().toString(); manifest.binding.mandateId = child;
    manifest.approved.job.mandateId = child; manifest.approved.sources.forEach(s => {s.quote.mandateId=child});
    manifest.chainEvidence.deployment = 'FACTORY_READY';
  }
  const trustedManifestProvider = async () => { calls.manifests++; return structuredClone(manifest); };
  let existing = ts1 ? null : await createPublicOrders({ repository, trustedManifestProvider, now: () => clock }).createJob({ ownerId, approvalId: 'approved', admissionKey: 'existing' });
  const tokens = { owner: Buffer.alloc(32, 7).toString('base64url'), foreign: Buffer.alloc(32, 8).toString('base64url') };
  for (const [kind, token] of Object.entries(tokens)) {
    const sessionId = createHash('sha256').update(token, 'ascii').digest('hex');
    await repository.runTransaction(tx => tx.create('walletSessions', sessionId, { sessionId, tokenHash: sessionId, accountId: kind === 'owner' ? ownerId : 'foreign.testnet', publicKey: 'ed25519:' + hash,
      origin, recipient: 'public-ui.invalid', networkId: 'testnet', issuedAt: clock, expiresAt: clock + 900000, revokedAt: null }));
  }
  const options = { repository, approvedOrigin: origin, approvedRecipient: 'public-ui.invalid', now: () => clock,
    trustedAccessKeyReader: async tuple => keyPresent ? { ...tuple, permission: 'FullAccess', finality: 'final', blockHeight: 123, blockHash: hash, observedAt: clock } : null,
    capabilities: runLane || rateLane || ts1 ? { publicTestnet: true, financialActions: true, qualifiedModel: true, qualifiedSigning: true } : { publicTestnet: true }, trustedManifestProvider,
    ...(runLane || rateLane ? { trustedSignerProvider: async () => { calls.signer++; throw new Error('SYNTHETIC_SIGNER_BOUNDARY'); }, model: { propose: async () => { calls.model++; throw new Error('MODEL_FORBIDDEN'); } } } : {}),
    ownerOperations: {
      prepare: async ({ action, ownerId, manifest: persisted }) => {
        calls.prepare++;
        if (providerUnavailable && action === 'stop' && (!retryLane || calls.prepare === 1)) throw new Error('SYNTHETIC_PREPARE_PROVIDER_UNAVAILABLE');
        if (staleLane && action === 'stop') { preparationEntered(); await heldPreparation; }
        if (action === 'create') return { network: 'testnet', signerId: ownerId, receiverId: persisted.creation.factory, methodName: 'create_job',
          args: { job_label: persisted.creation.job_label, agent: persisted.binding.signerId, allowlist: persisted.approved.job.vendorIds, cap: persisted.approved.job.budgetAtomic,
            deadline_ns: String(BigInt(Date.parse(persisted.approved.job.expiresAt)) * 1000000n), operating_float: persisted.creation.operating_float }, gas: persisted.creation.create_gas,
          deposit: String(BigInt(persisted.approved.job.budgetAtomic) + BigInt(persisted.creation.operating_float)) };
        return { network: 'testnet', signerId: ownerId, receiverId: persisted.binding.mandateId, methodName: action, args: {}, gas: '100000000000000', deposit: '0' };
      },
      reconcile: async ({ action, transactionHash, ownerId, manifest: persisted }) => { calls.reconcile++; return { networkId: 'testnet', ownerId, signerId: ownerId, mandateId: persisted.binding.mandateId, action, transactionHash, finality: 'final', status: 'CONFIRMED', receiptId: hash, ...(action === 'withdraw' ? { amountAtomic: '8' } : {}) }; },
    } };
  if (ts1) {
    options.trustedSignerProvider = async () => ({getPublicKey:() => signer.getPublicKey(),signTransaction:tx => {nativeCalls.signs++; return signer.signTransaction(tx)}});
    options.model = {propose:async input => {calls.model++; return input.phase==='plan'?{tool:'requestquotes',arguments:{quoteIds:input.approvedSources.map(s=>s.quoteId)}}:{findings:input.evidence.map(a=>({artifactId:a.artifactId,excerpt:a.content.slice(0,100)})),interpretations:[{kind:'COMPARE_SOURCE_CONSISTENCY',findingIndexes:[0,1]}]}}};
    globalThis.fetch = async (url, init) => {
      if (String(url)!==manifest.rpcUrl) {calls.forbiddenFetch++; throw new Error('EXTERNAL_FETCH_FORBIDDEN')}
      const r=JSON.parse(init.body); let result;
      if(r.method==='status') result={chain_id:'testnet',sync_info:{syncing:false}};
      else if(r.method==='query' && r.params.request_type==='view_access_key_list') result={keys:r.params.account_id===manifest.binding.signerId?[{public_key:manifest.binding.publicKey,access_key:{nonce:1,permission:{FunctionCall:{receiver_id:manifest.binding.mandateId,method_names:['pay'],allowance:'900'}}}}]:[],block_hash:hash,block_height:123};
      else if(r.method==='query' && r.params.request_type==='view_account') result={code_hash:hash};
      else if(r.method==='query' && r.params.request_type==='call_function') result={result:[...Buffer.from(JSON.stringify({owner:ownerId,agent:manifest.binding.signerId,cap:'30',allowlist:manifest.approved.job.vendorIds,deadline_ns:String(BigInt(Date.parse(manifest.approved.job.expiresAt))*1000000n),stopped:false,expired:false,free:'30',in_flight:null,orders:[]}))]};
      else if(r.method==='block') result={header:{hash,timestamp_nanosec:String(BigInt(clock)*1000000n)}};
      else if(r.method==='send_tx') {nativeCalls.sends++; const signed=SignedTransaction.decode(Buffer.from(r.params.signed_tx_base64,'base64')); const args=JSON.parse(Buffer.from(signed.transaction.actions[0].functionCall.args).toString()); const quote=manifest.approved.sources.find(s=>s.quote.orderId===args.order_id).quote; const evidence=syntheticPayment(quote,args.order_id==='second-quote'?31:1).evidence; const txHash=baseEncode(createHash('sha256').update(signed.transaction.encode()).digest()); evidence.finalTransaction.transaction.hash=txHash; evidence.finalTransaction.transaction_outcome.id=txHash;chainEvidence.set(txHash,evidence);result=evidence.finalTransaction;}
      else if(r.method==='EXPERIMENTAL_tx_status') {if(!revealEvidence) throw new Error('SYNTHETIC_RECEIPT_NOT_YET_AVAILABLE');result=chainEvidence.get(r.params.tx_hash).finalTransaction;}
      else if(r.method==='EXPERIMENTAL_receipt') result=[...chainEvidence.values()].flatMap(e=>e.receipts).find(row=>row.receipt_id===r.params.receipt_id);
      else assert.fail('Unexpected closed RPC '+r.method);
      return Response.json({jsonrpc:'2.0',id:r.id,result});
    };
  }
  const auth = createWalletAuthHttp(options), app = createPublicJourney(options);
  t.after(() => auth.close());
  const received = [];
  const server = createServer((req, res) => {
    const row = { path: req.url, method: req.method, origin: req.headers.origin ?? null, csrf: req.headers['x-haldir-csrf'] ?? null, secFetchSite: req.headers['sec-fetch-site'] ?? null, cookiePresent: !!req.headers.cookie };
    received.push(row); res.once('finish', () => { row.status = res.statusCode; });
    void (req.url.startsWith('/api/wallet-auth/') ? auth : app).handle(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const output = await build({ root, configFile: root + 'vite.config.ts', logLevel: 'warn', plugins: [{ name: 'closed-public-integration',
    resolveId: id => id === 'virtual:closed-public' ? '\0closed-public' : undefined,
    load: id => id === '\0closed-public' ? `
      import {createWalletAuth} from ${JSON.stringify(root + 'src/integration/wallet-auth.ts')};
      import {createPublicTestnetController} from ${JSON.stringify(root + 'src/integration/testnet.ts')};
      import {resolveOwnerManifest} from ${JSON.stringify(root + 'src/integration/owner-approval.ts')};
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {PublicTestnetWorkspace} from ${JSON.stringify(root + 'src/App.tsx')};
      const origin = location.origin;
      import ${JSON.stringify(root + 'src/index.css')};
      const syntheticLogin = ${JSON.stringify(ts1)} ? {loadMeteor:async () => ({associateTestnet:async () => ({identifier:{blockchain:'near',network:'testnet',accountId:'owner.testnet'}}),getAccount:async () => ({identifier:{blockchain:'near',network:'testnet',accountId:'owner.testnet'}}),createAction:async request => ({promptForExecution:async () => {const key=await crypto.subtle.importKey('pkcs8',new Uint8Array(${JSON.stringify(loginPkcs8)}),{name:'Ed25519'},false,['sign']); const {serializeMessageNep413}=await import('@meteorwallet/sdk'); const bytes=serializeMessageNep413(request.input.messageParams); const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',key,bytes));return {accountId:'owner.testnet',publicKey:{toString:()=>${JSON.stringify(loginPublicKey)}},signature}}})})} : {};
      const auth = createWalletAuth({origin, approvedOrigin: origin, recipient: location.hostname, secureContext: true,...syntheticLogin});
      let prompts = Number(sessionStorage.getItem('synthetic-prompts') || '0');
      // Real required-terms and SDK action-construction path in Chrome. Only
      // the external wallet result remains synthetic; no global Buffer shim.
      const make = () => createPublicTestnetController({origin, approvedOrigin: origin, principal: () => auth.getSnapshot().principal, storage: localStorage,
        requiredOwnerManifest: resolveOwnerManifest,
        wallet: {approve: async manifest => { prompts++; sessionStorage.setItem('synthetic-prompts', String(prompts)); return {status:'submitted', transactionHash: manifest.kind === 'stop' ? '1'.repeat(32) : '1'.repeat(31) + '2'}; }} });
      let client;
      const root = createRoot(document.getElementById('root'));
      const mount = () => root.render(React.createElement(PublicTestnetWorkspace, {auth, controller: client, key: Math.random()}));
      window.integration = {auth, get client(){return client}, get prompts(){return prompts}, async start(){ client = make(); mount(); }};
    ` : undefined }], build: { write: false, rollupOptions: { input: 'virtual:closed-public' } } });
  assert.ok(!Array.isArray(output));
  const assets = new Map(output.output.map(x => ['/' + x.fileName, x.type === 'chunk' ? x.code : x.source]));
  const entry = output.output.find(x => x.type === 'chunk' && x.isEntry);
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' }); t.after(() => context.close());
  if (!ts1) await context.addCookies([{ name: '__Host-haldir_session', value: tokens.owner, url: origin, secure: true, httpOnly: true, sameSite: 'Strict' }]);
  const denied = [], errors = [], wireBodies = [], preparationResponses = [];
  const relay = async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { denied.push(req.url()); return route.abort('blockedbyclient'); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `${output.output.filter(x=>x.fileName.endsWith('.css')).map(x=>`<link rel="stylesheet" href="/${x.fileName}">`).join('')}<div id="root"></div><script type="module" src="/${entry.fileName}"></script>` });
    if (assets.has(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.js') ? 'text/javascript' : 'image/png', body: assets.get(url.pathname) });
    if (url.pathname.startsWith('/fonts/')) return route.fulfill({ contentType: 'font/ttf', body: await readFile(root + 'public' + decodeURI(url.pathname)) });
    assert.ok(url.pathname.startsWith('/api/'));
    const headers = await req.allHeaders();
    wireBodies.push({ path: url.pathname, body: req.postDataJSON() });
    // Do not synthesize Origin, CSRF, Cookie or Sec-Fetch-Site. The bridge is a
    // test-owned virtual-host relay, not a browser TLS/deployment qualification.
    const result = await new Promise((resolve, reject) => {
      const wire = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: url.pathname, method: req.method(), headers: { ...headers, host: url.host } }, res => {
        const chunks = []; res.on('data', x => chunks.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); res.on('error', reject);
      }); wire.on('error', reject); wire.end(req.postDataBuffer());
    });
    if (/owner\/(?:prepare|retry-prepare)$/.test(url.pathname) && result.status === 200) {
      const decoded = JSON.parse(result.body.toString());
      preparationResponses.push({ path: url.pathname, walletEligible: decoded.walletEligible, operationId: decoded.operation.operationId, preparation: decoded.operation.preparation });
    }
    if (losePrepare && !prepareResponseLost && url.pathname.endsWith('/owner/prepare') && req.postDataJSON().action === 'stop') {
      assert.equal(result.status, 200);
      const committed = await repository.runTransaction(tx => tx.get('ownerOperations', createHash('sha256').update(JSON.stringify(['haldir-owner-v1', existing.jobId, 'stop'])).digest('hex')));
      assert.equal(committed.status, 'AWAITING_WALLET');
      prepareResponseLost = true;
      return route.abort('failed'); // HTTP response lost only after real handler commit.
    }
    return route.fulfill(result);
  };
  await context.route('**/*', relay);
  await context.routeWebSocket('**/*', socket => { denied.push(socket.url()); socket.close(); });
  const initBrowser = ({ origin, jobId }) => {
    localStorage.setItem(`haldir-public-job-v1:${origin}:owner.testnet`, jobId);
    window.open = () => { throw new Error('ACTUAL_WALLET_PROMPT_FORBIDDEN'); };
  };
  if (!ts1) await context.addInitScript(initBrowser, { origin, jobId: existing.jobId });
  else await context.addInitScript(() => {window.open = () => {throw new Error('ACTUAL_WALLET_PROMPT_FORBIDDEN')}});
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await page.waitForFunction(() => !!window.integration);
  const visualCaptures = [];
  const capturePublic = async (state, desktopHeight = 1034) => {
    await mkdir(evidence, {recursive:true});
    for (const width of [1520,390,320]) {
      await page.setViewportSize({width,height:width===1520?desktopHeight:1000});
      await page.evaluate(async () => {await document.fonts.ready; document.querySelector('.conversation-stream')?.scrollTo(0,0); window.scrollTo(0,0)});
      const file = `latest-${state}-${width}.png`;
      await page.screenshot({path:evidence+file});
      const geometry = await page.evaluate(() => ({viewport:innerWidth,document:document.documentElement.scrollWidth,composer:document.querySelector('.composer')?.getBoundingClientRect().toJSON(),stop:[...document.querySelectorAll('button')].find(b=>b.textContent==='Approve owner stop in wallet')?.getBoundingClientRect().toJSON()}));
      assert.ok(geometry.document<=width,`${state} ${width} page overflow: ${JSON.stringify(geometry)}`);
      visualCaptures.push({state,width,file,geometry});
      const stream = page.locator('.conversation-stream');
      if(await stream.evaluate(e=>e.scrollHeight>e.clientHeight+4)) {await stream.evaluate(e=>e.scrollTo(0,e.scrollHeight)); const slice=`latest-${state}-${width}-end.png`; await page.screenshot({path:evidence+slice}); visualCaptures.push({state,width,file:slice,scrollSlice:'end'});}
    }
    await page.setViewportSize({width:1440,height:1000});
  };
  assert.equal(await page.evaluate(() => typeof globalThis.Buffer), 'undefined', 'native browser, no Buffer shim');
  await page.evaluate(() => window.integration.start());
  if (ts1) {
    const backendPaths = ['src/server/public-journey.mjs','src/server/orders.mjs','src/shared/job-contract.mjs','src/agent/run-job.mjs','src/agent/model-provider.mjs'];
    await page.getByLabel('Your message',{exact:true}).waitFor();
    await capturePublic('anonymous');
    const sourceHashes = Object.fromEntries(await Promise.all(backendPaths.map(async path => [path,createHash('sha256').update(await readFile(root+'../'+path)).digest('hex')])));
    await page.getByLabel('Your message',{exact:true}).fill('Prepare a fictional supplier review');
    await page.getByRole('button',{name:'Send message',exact:true}).click();
    await capturePublic('draft',1054);
    for (const width of [1520,390,320]) {
      await page.setViewportSize({width,height:width===1520?1134:1000});
      await page.getByRole('button',{name:'Edit draft details',exact:true}).click();
      const editor = width===1520 ? page.getByRole('complementary',{name:'Working bar'}) : page.getByRole('dialog',{name:'Task panel',exact:true});
      await editor.getByRole('heading',{name:'Edit draft details',exact:true}).waitFor();
      await editor.evaluate(async e => {await Promise.all(e.getAnimations({subtree:true}).map(a=>a.finished))});
      if(width!==1520) await page.waitForFunction(()=>{const e=document.querySelector('[role="dialog"]');return e && !e.hasAttribute('data-starting-style') && getComputedStyle(e).opacity==='1'});
      await page.screenshot({path:evidence+`latest-edit-${width}.png`}); visualCaptures.push({state:'edit',width,file:`latest-edit-${width}.png`});
      await editor.getByRole('button',{name:'Cancel',exact:true}).click();
      if(width!==1520) {await page.keyboard.press('Escape'); await page.getByRole('dialog',{name:'Task panel',exact:true}).waitFor({state:'hidden'});}
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('button',{name:'Connect testnet account',exact:true}).click();
    await page.getByText('Connected owner.testnet · testnet. Connection is not login.',{exact:true}).waitFor();
    assert.equal(received.filter(r=>r.path==='/api/public/jobs').length,0);
    await page.getByRole('button',{name:'Log in with connected testnet wallet',exact:true}).click();
    await page.getByLabel('Approved terms ID',{exact:true}).waitFor();
    assert.match(await page.getByRole('log').textContent(),/Prepare a fictional supplier review/);
    await page.getByLabel('Approved terms ID',{exact:true}).fill('approved');
    await page.getByRole('button',{name:'Load operator-approved terms',exact:true}).click();
    await page.getByRole('button',{name:'Use these approved terms in my draft',exact:true}).click();
    await page.getByRole('button',{name:'Review spending limits',exact:true}).click();
    await page.getByRole('heading',{name:'Proposed spending mandate',exact:true}).waitFor();
    assert.equal(await page.getByTestId('two-source-sum').textContent(),'17');
    await capturePublic('review-A03',1314);
    assert.equal(await page.evaluate(()=>window.integration.prompts),0);
    await page.getByRole('button',{name:'Accept reviewed terms and open job',exact:true}).click();
    await page.waitForFunction(()=>!!window.integration.client.getSnapshot().view && !window.integration.client.getSnapshot().busy);
    let snap=await page.evaluate(()=>window.integration.client.getSnapshot());
    assert.equal(snap.error,null,JSON.stringify(snap)); existing=snap.view.job;
    assert.equal(snap.view.contractVersion,'haldir.public.v2'); assert.equal(snap.view.orders.length,2);
    assert.equal(await page.getByRole('button',{name:'Approve owner creation in wallet',exact:true}).isDisabled(),true);
    assert.equal(await page.getByTestId('creation-deposit').textContent(),'40');
    await capturePublic('activation-A04',1094);
    await page.getByRole('button',{name:'I reviewed creation costs',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.integration.prompts),0);
    await page.getByRole('button',{name:'Approve owner creation in wallet',exact:true}).click();
    await page.waitForFunction(()=>!window.integration.client.getSnapshot().busy);
    snap=await page.evaluate(()=>window.integration.client.getSnapshot()); assert.equal(snap.error,null,JSON.stringify(snap));
    assert.equal(snap.view.ownerOperations[0].status,'CONFIRMED');
    await page.getByRole('button',{name:'Run or resume approved job',exact:true}).click();
    await page.waitForFunction(()=>!window.integration.client.getSnapshot().busy);
    snap=await page.evaluate(()=>window.integration.client.getSnapshot()); assert.equal(snap.error,null,JSON.stringify(snap));
    assert.equal(snap.view.orders[0].order.proof,null); assert.equal(snap.view.orders[1].payment.status,'NOT_STARTED');
    assert.deepEqual(nativeCalls,{signs:1,sends:1}); assert.equal(calls.model,1);
    await capturePublic('active-unresolved',1379);
    await page.getByRole('region',{name:'Background research source',exact:true}).getByText('Not started',{exact:true}).waitFor();
    revealEvidence=true; await page.getByRole('button',{name:'Run or resume approved job',exact:true}).click(); await page.waitForFunction(()=>!window.integration.client.getSnapshot().busy);
    snap=await page.evaluate(()=>window.integration.client.getSnapshot()); assert.equal(snap.error,null,JSON.stringify(snap));
    assert.equal(snap.view.run.stage,'COMPLETE'); assert.equal(snap.view.run.report.facts.length,2);
    assert.ok(snap.view.orders.every(m=>m.order.lifecycle==='DELIVERED'));
    assert.notEqual(snap.view.orders[0].order.proof.proofId,snap.view.orders[1].order.proof.proofId);
    assert.equal(calls.model,2); assert.deepEqual(nativeCalls,{signs:2,sends:2});
    await page.getByRole('region',{name:'Background research source',exact:true}).waitFor();
    await capturePublic('active-results-A05',1379);
    await page.getByRole('button',{name:'Hide panel',exact:true}).click();
    await page.getByRole('button',{name:'Show task panel',exact:true}).waitFor();
    await capturePublic('collapsed-05b',1034);
    await page.getByRole('button',{name:'Show task panel',exact:true}).click();
    await writeFile(evidence+'latest-visual-captures.json',JSON.stringify(visualCaptures,null,2));
    await page.getByText('Compare the two sources for consistency; agreement does not verify accuracy.',{exact:true}).waitFor();
    await mkdir(evidence,{recursive:true});
    for (const width of [1440,390,320]) {await page.setViewportSize({width,height:1000}); await page.getByRole('heading',{name:'Results and receipts',exact:true}).scrollIntoViewIfNeeded(); await page.evaluate(()=>document.fonts.ready); await page.screenshot({path:evidence+`two-source-${width}.png`}); const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('.conversation-content *')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>({tag:e.tagName,cls:e.className,text:e.textContent?.slice(0,80),width:e.clientWidth,scroll:e.scrollWidth}))})); assert.equal(overflow.scroll > width,false,JSON.stringify(overflow)); const second=page.getByRole('region',{name:'Background research source',exact:true}); await second.scrollIntoViewIfNeeded(); await second.getByText('Evidence and purchase receipt',{exact:true}).click(); await page.screenshot({path:evidence+`two-source-receipt-${width}.png`}); const brief=page.getByRole('article',{name:'Source-linked report',exact:true}); await brief.scrollIntoViewIfNeeded(); await brief.getByText('Linked evidence',{exact:true}).last().click(); await page.screenshot({path:evidence+`two-source-brief-${width}.png`}); assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.conversation-content')].some(e=>e.scrollWidth>e.clientWidth)),false,'Expanded source/report evidence must not overflow its reading column'); await brief.getByText('Linked evidence',{exact:true}).last().click(); await second.getByText('Evidence and purchase receipt',{exact:true}).click();}
    const admissions=received.filter(r=>r.path==='/api/public/jobs').length;
    await page.reload(); await page.waitForFunction(()=>!!window.integration); await page.evaluate(()=>window.integration.start());
    await page.waitForFunction(()=>!!window.integration.client.getSnapshot().view && !window.integration.client.getSnapshot().busy && !window.integration.auth.getSnapshot().busy);
    snap=await page.evaluate(()=>window.integration.client.getSnapshot()); assert.equal(snap.error,null);
    assert.equal(snap.view.run.report.facts.length,2); assert.equal(received.filter(r=>r.path==='/api/public/jobs').length,admissions);
    await page.getByRole('button',{name:'Run or resume approved job',exact:true}).click(); await page.waitForFunction(()=>!window.integration.client.getSnapshot().busy);
    assert.equal(calls.model,2); assert.deepEqual(nativeCalls,{signs:2,sends:2}); assert.equal(await page.evaluate(()=>window.integration.prompts),1);
    assert.equal(received.filter(r=>r.path==='/api/public/approvals/read').length,3);
    assert.deepEqual(Object.keys(wireBodies.find(r=>r.path==='/api/public/jobs').body).sort(),['admissionKey','approvalId']);
    await page.getByText('Account and session',{exact:true}).click();
    await page.getByRole('button',{name:'Log out of session',exact:true}).click();
    await page.waitForFunction(()=>!window.integration.auth.getSnapshot().busy);
    await context.clearCookies(); await context.addCookies([{name:'__Host-haldir_session',value:tokens.foreign,url:origin,secure:true,httpOnly:true,sameSite:'Strict'}]);
    await page.evaluate(()=>window.integration.auth.resume());
    await page.getByLabel('Approved terms ID',{exact:true}).waitFor();
    assert.equal(await page.getByRole('region',{name:'Background research source',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Approve owner creation in wallet',exact:true}).count(),0);
    assert.match(await page.locator('aside').textContent(),/Fictional existing job/);
    for(const row of received.filter(r=>r.path.startsWith('/api/public/')&&r.status===200)){assert.equal(row.origin,origin);assert.equal(row.csrf,'1');assert.equal(row.cookiePresent,true)}
    assert.equal(calls.forbiddenFetch,0); assert.deepEqual(denied,[]); assert.deepEqual(errors,[]);
    const finalSourceHashes=Object.fromEntries(await Promise.all(backendPaths.map(async path=>[path,createHash('sha256').update(await readFile(root+'../'+path)).digest('hex')])));
    await writeFile(evidence+'two-source-chrome-receipt.json',JSON.stringify({status:'PASS_REAL_HTTP_TWO_SOURCE_SYNTHETIC_LOGIN_WALLET_CHAIN_MODEL',browser:browser.version(),sourceHashes,finalSourceHashes,assembledAssets:Object.fromEntries(output.output.map(a=>[a.fileName,createHash('sha256').update(a.type==='chunk'?a.code:a.source).digest('hex')])),buildWrite:false,syntheticWalletApprovals:await page.evaluate(()=>window.integration.prompts),received,calls,nativeCalls,wireBodies,actualTlsWalletOrChainAcceptance:false},null,2));
    return;
  }
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Approve owner stop in wallet' && !b.disabled));
  const snapshot = () => page.evaluate(() => window.integration.client.getSnapshot());
  const initial = await snapshot();
  assert.equal(initial.config.financialActions, runLane || rateLane);
  assert.equal(initial.error, null, JSON.stringify(received));
  assert.equal(initial.view.job.jobId, existing.jobId);
  assert.equal(initial.view.job.ownerId, ownerId);
  if (staleLane) {
    const secondContext = await browser.newContext({ serviceWorkers: 'block' }); t.after(() => secondContext.close());
    await secondContext.addCookies([{ name: '__Host-haldir_session', value: tokens.owner, url: origin, secure: true, httpOnly: true, sameSite: 'Strict' }]);
    await secondContext.route('**/*', relay);
    await secondContext.routeWebSocket('**/*', socket => { denied.push(socket.url()); socket.close(); });
    await secondContext.addInitScript(initBrowser, { origin, jobId: existing.jobId });
    const second = await secondContext.newPage(); second.on('pageerror', e => errors.push(e.message));
    await second.goto(origin); await second.waitForFunction(() => !!window.integration); await second.evaluate(() => window.integration.start());
    await second.waitForFunction(() => !!window.integration.client.getSnapshot().view && !window.integration.client.getSnapshot().busy && !window.integration.auth.getSnapshot().busy);
    assert.deepEqual((await snapshot()).view.ownerOperations, []);
    assert.deepEqual(await second.evaluate(() => window.integration.client.getSnapshot().view.ownerOperations), []);
    const firstClick = page.getByRole('button', { name: 'Approve owner stop in wallet' }).click();
    await preparationStarted; await firstClick;
    await second.getByRole('button', { name: 'Approve owner stop in wallet' }).click();
    await second.waitForFunction(() => !window.integration.client.getSnapshot().busy);
    assert.equal(calls.prepare, 1);
    assert.equal(await second.evaluate(() => window.integration.prompts), 0);
    const secondView = await second.evaluate(() => window.integration.client.getSnapshot());
    assert.equal(secondView.error, null); assert.equal(secondView.view.ownerOperations[0].preparation.state, 'PREPARING');
    assert.equal(await second.getByRole('button', { name: 'Retry stop preparation' }).count(), 0);
    releasePreparation(); await page.waitForFunction(() => !window.integration.client.getSnapshot().busy);
    assert.equal((await snapshot()).error, null);
    assert.equal(await page.evaluate(() => window.integration.prompts), 1);
    await second.reload(); await second.waitForFunction(() => !!window.integration); await second.evaluate(() => window.integration.start());
    await second.waitForFunction(() => !!window.integration.client.getSnapshot().view && !window.integration.client.getSnapshot().busy && !window.integration.auth.getSnapshot().busy);
    await second.evaluate(() => window.integration.client.approve('stop'));
    assert.equal(await second.evaluate(() => window.integration.prompts), 0);
    assert.equal(calls.prepare, 1); assert.equal(calls.reconcile, 1);
    assert.deepEqual(preparationResponses.map(row => row.walletEligible).sort(), [false, true]);
    assert.equal(new Set(preparationResponses.map(row => row.preparation.attemptId)).size, 1);
    assert.equal(received.filter(row => row.path.endsWith('/owner/prepare')).length, 2);
    assert.equal((await repository.runTransaction(tx => tx.get('ownerOperations', secondView.view.ownerOperations[0].operationId))).status, 'CONFIRMED');
    assert.equal(calls.forbiddenFetch, 0); assert.equal(calls.model, 0); assert.equal(calls.signer, 0);
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    await mkdir(evidence, { recursive: true });
    await writeFile(evidence + 'stale-contexts-chrome-receipt.json', JSON.stringify({ status: 'PASS_REAL_HANDLER_TWO_INDEPENDENT_STALE_BROWSER_CONTEXTS_ONE_ISSUANCE_ONE_SYNTHETIC_PROMPT', received, calls, wireBodies, preparationResponses, actualTlsOrLoginOrChainAcceptance: false }, null, 2));
    return;
  }
  if (rateLane) {
    const path = `/api/public/jobs/${existing.jobId}/owner/prepare`;
    const key = `haldir-public-owner-v1:${origin}:${ownerId}:${existing.jobId}:stop`;
    const id = createHash('sha256').update(JSON.stringify(['haldir-owner-v1', existing.jobId, 'stop'])).digest('hex');
    const withdrawKey = `haldir-public-owner-v1:${origin}:${ownerId}:${existing.jobId}:withdraw`;
    const guard = JSON.stringify({ operationId: null, status: 'preparing', transactionHash: null });
    for (const rejection of ['UNAUTHENTICATED', 'FINANCIAL_NOT_CONFIGURED']) {
      const prepare = options.ownerOperations.prepare;
      if (rejection === 'UNAUTHENTICATED') await context.clearCookies();
      else options.ownerOperations.prepare = undefined;
      await page.getByRole('button', { name: rejection === 'UNAUTHENTICATED' ? 'Approve owner withdrawal in wallet' : 'Retry withdrawal preparation' }).click();
      await page.waitForFunction(() => !window.integration.client.getSnapshot().busy);
      assert.equal((await snapshot()).error, rejection);
      assert.equal(received.at(-1).status, rejection === 'UNAUTHENTICATED' ? 401 : 503);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), withdrawKey), guard);
      assert.equal(await repository.runTransaction(tx => tx.get('ownerOperations', id)), null);
      assert.equal(calls.prepare, 0); assert.equal(await page.evaluate(() => window.integration.prompts), 0);
      options.ownerOperations.prepare = prepare;
      await context.addCookies([{ name: '__Host-haldir_session', value: tokens.owner, url: origin, secure: true, httpOnly: true, sameSite: 'Strict' }]);
    }
    const rejectedBeforeLimit = received.filter(row => row.path === path).length;
    // Real requests consume the real owner/prepare window, then fail action
    // validation before any operation row is created. No seeded rate fixture.
    const exhausted = await page.evaluate(async path => {
      const results = [];
      for (let i = 0; i < 20; i++) {
        const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-haldir-csrf': '1' }, body: JSON.stringify({ action: 'invalid' }) });
        results.push({ status: response.status, body: await response.json() });
      }
      return results;
    }, path);
    assert.equal(exhausted.length, 20);
    for (const result of exhausted) assert.deepEqual(result, { status: 400, body: { error: 'INVALID_BODY', contractVersion: 'haldir.public.v1' } });
    await page.getByRole('button', { name: 'Approve owner stop in wallet' }).click();
    await page.waitForFunction(() => !window.integration.client.getSnapshot().busy);
    assert.equal((await snapshot()).error, 'RATE_LIMITED');
    assert.equal(received.at(-1).status, 429);
    assert.equal(await repository.runTransaction(tx => tx.get('ownerOperations', id)), null);
    assert.equal(calls.prepare, 0); assert.equal(await page.evaluate(() => window.integration.prompts), 0);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), guard, 'HTTP 429 never releases an ambiguous browser guard');
    await page.reload(); await page.waitForFunction(() => !!window.integration);
    await page.evaluate(() => window.integration.start());
    await page.waitForFunction(() => !!window.integration.client.getSnapshot().view && !window.integration.client.getSnapshot().busy && !window.integration.auth.getSnapshot().busy);
    assert.deepEqual((await snapshot()).view.ownerOperations, []);
    assert.equal(received.filter(row => row.path === path).length, rejectedBeforeLimit + 21, 'reload never retries prepare');
    assert.equal(await page.evaluate(() => window.integration.prompts), 0);
    clock += 60000;
    assert.equal(await page.getByRole('button', { name: 'Approve owner stop in wallet' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Retry stop preparation' }).click();
    await page.waitForFunction(() => !window.integration.client.getSnapshot().busy);
    assert.equal((await snapshot()).error, null);
    assert.equal((await snapshot()).view.ownerOperations[0].operationId, id);
    assert.equal((await snapshot()).view.ownerOperations[0].status, 'CONFIRMED');
    assert.equal((await repository.runTransaction(tx => tx.get('ownerOperations', id))).status, 'CONFIRMED');
    assert.equal(calls.prepare, 1); assert.equal(calls.reconcile, 1); assert.equal(await page.evaluate(() => window.integration.prompts), 1);
    assert.equal(received.filter(row => row.path === path).length, rejectedBeforeLimit + 21, 'fresh prepare never reissued');
    assert.equal(received.filter(row => row.path === `/api/public/jobs/${existing.jobId}/owner/retry-prepare`).length, 2, 'only explicit financial-unavailable and recovery retry clicks');
    assert.deepEqual(wireBodies.filter(row => row.path.endsWith('/owner/retry-prepare')).at(-1), { path: `/api/public/jobs/${existing.jobId}/owner/retry-prepare`, body: { action: 'stop', operationId: id, attemptId: 'unreserved' } });
    assert.equal(calls.forbiddenFetch, 0); assert.equal(calls.model, 0); assert.equal(calls.signer, 0);
    assert.deepEqual(denied, []); assert.deepEqual(errors, []);
    await mkdir(evidence, { recursive: true });
    await writeFile(evidence + 'precommit-rate-limit-chrome-receipt.json', JSON.stringify({ status: 'PASS_REAL_HANDLER_429_RETAINED_GUARD_RELOAD_EXPLICIT_UNRESERVED_RETRY_ONE_SYNTHETIC_PROMPT', received, calls, wireBodies, preparationResponses, actualTlsOrLoginOrChainAcceptance: false }, null, 2));
    return;
  }
  if (runLane) {
    const factory = scenario === 'factory-replay', path = `/api/public/jobs/${existing.jobId}`;
    assert.equal(initial.view.job.ownerCreationRequired, factory);
    assert.deepEqual(initial.view.ownerOperations, [], 'no fabricated create operation on admission');
    const run = page.getByRole('button', { name: 'Run or resume approved job' });
    const raw = (route, body) => page.evaluate(async ({ route, body }) => {
      const response = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-haldir-csrf': '1' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }, { route, body });
    if (factory) {
      assert.equal(await run.isDisabled(), true);
      const before = received.length; await page.evaluate(() => window.integration.client.run());
      assert.equal((await snapshot()).error, 'OWNER_CREATION_NOT_CONFIRMED'); assert.equal(received.length, before);
      manifest.chainEvidence.deployment = 'MANDATE_READY';
      const replay = await raw('/api/public/jobs', { approvalId: 'approved', admissionKey: 'existing' });
      assert.equal(replay.status, 201); assert.equal(replay.body.job.jobId, existing.jobId); assert.equal(replay.body.job.ownerCreationRequired, true);
      await page.evaluate(() => window.integration.client.refresh());
      assert.equal((await snapshot()).view.job.ownerCreationRequired, true);
      const blocked = await raw(`${path}/run`, {});
      assert.equal(blocked.status, 409); assert.equal(blocked.body.error, 'OWNER_CREATION_REQUIRED'); assert.equal(calls.signer, 0);
      assert.equal((await repository.runTransaction(tx => tx.get('jobs', existing.jobId))).publicManifest.chainEvidence.deployment, 'FACTORY_READY');
      await page.getByRole('button', { name: 'Approve owner creation in wallet' }).click();
      await page.waitForFunction(() => !window.integration.client.getSnapshot().busy);
      assert.equal((await snapshot()).error, null);
      assert.equal((await snapshot()).view.ownerOperations[0].status, 'CONFIRMED');
      assert.equal((await snapshot()).view.job.ownerCreationRequired, true, 'creation does not rewrite persisted admission phase');
      assert.equal(await run.isEnabled(), true);
    } else {
      assert.equal(await run.isEnabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Approve owner creation in wallet' }).count(), 0);
      const before = received.length; await page.evaluate(() => window.integration.client.approve('create'));
      assert.equal((await snapshot()).error, 'OWNER_CREATION_NOT_REQUIRED'); assert.equal(received.length, before);
      assert.deepEqual((await snapshot()).view.ownerOperations, []);
    }
    await run.click(); await page.waitForFunction(() => !window.integration.client.getSnapshot().busy);
    assert.equal((await snapshot()).error, 'PROVIDER_UNAVAILABLE', 'run reached the deliberately unavailable synthetic signer, not the creation fence');
    assert.equal(calls.signer, 1); assert.equal(calls.model, 0);
    assert.equal(received.filter(row => row.path === `${path}/run`).length, factory ? 2 : 1);
    assert.equal(calls.prepare, factory ? 1 : 0); assert.equal(calls.reconcile, factory ? 1 : 0);
    assert.equal(await page.evaluate(() => window.integration.prompts), factory ? 1 : 0);
    assert.equal(calls.forbiddenFetch, 0); assert.deepEqual(denied, []); assert.deepEqual(errors, []);
    await mkdir(evidence, { recursive: true });
    await writeFile(evidence + `${scenario}-chrome-receipt.json`, JSON.stringify({ status: 'PASS_REAL_HANDLER_CREATION_ADMISSION_FENCE_SYNTHETIC_SIGNER_BOUNDARY', browser: browser.version(), received, calls, realWalletPrompts: 0, actualTlsOrLoginOrChainAcceptance: false, denied, errors }, null, 2));
    return;
  }
  for (const action of ['stop', 'withdraw']) {
    await page.getByRole('button', { name: action === 'stop' ? 'Approve owner stop in wallet' : 'Approve owner withdrawal in wallet' }).click();
    await page.waitForFunction(() => !window.integration.client.getSnapshot().busy);
    if (uncertainPrepare && action === 'stop') {
      assert.equal(prepareResponseLost, losePrepare);
      if (providerUnavailable) {
        assert.equal((await snapshot()).error, 'PROVIDER_UNAVAILABLE');
        assert.equal(received.at(-1).status, 503);
      }
      const key = `haldir-public-owner-v1:${origin}:${ownerId}:${existing.jobId}:stop`;
      assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key), { operationId: null, status: 'preparing', transactionHash: null });
      assert.equal(await page.evaluate(() => window.integration.prompts), 0);
      await page.reload(); await page.waitForFunction(() => !!window.integration);
      await page.evaluate(() => window.integration.start());
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Approve owner withdrawal in wallet' && !b.disabled));
      const recovered = await snapshot();
      assert.equal(recovered.error, null);
      const stop = recovered.view.ownerOperations.find(op => op.action === 'stop');
      assert.equal(stop.status, providerUnavailable ? 'UNKNOWN' : 'AWAITING_WALLET');
      assert.equal(stop.operationId, createHash('sha256').update(JSON.stringify(['haldir-owner-v1', existing.jobId, 'stop'])).digest('hex'));
      assert.equal((await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).operationId, stop.operationId);
      assert.equal(await page.getByRole('button', { name: 'Approve owner stop in wallet' }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Approve owner withdrawal in wallet' }).isEnabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Run or resume approved job' }).isDisabled(), true);
      await page.evaluate(() => window.integration.client.refresh());
      await page.evaluate(() => window.integration.client.approve('stop'));
      assert.equal((await snapshot()).error, 'OWNER_OPERATION_REQUIRES_RECONCILIATION');
      assert.equal(calls.prepare, 1); assert.equal(await page.evaluate(() => window.integration.prompts), 0);
      await page.getByText(stop.operationId, { exact: true }).waitFor();
      if (retryLane) {
        assert.equal(stop.preparation.state, 'UNISSUED_FAILED');
        const before = wireBodies.filter(row => row.path.endsWith('/owner/retry-prepare')).length;
        const jobBefore = await repository.runTransaction(tx => tx.get('jobs', existing.jobId));
        await page.getByRole('button', { name: 'Retry stop preparation' }).click();
        await page.waitForFunction(() => !window.integration.client.getSnapshot().busy);
        assert.equal((await snapshot()).error, null);
        const retried = (await snapshot()).view.ownerOperations.find(op => op.action === 'stop');
        assert.equal(retried.operationId, stop.operationId); assert.equal(retried.status, 'CONFIRMED');
        assert.notEqual(retried.preparation.attemptId, stop.preparation.attemptId); assert.equal(retried.preparation.state, 'ISSUED');
        assert.deepEqual(wireBodies.filter(row => row.path.endsWith('/owner/retry-prepare')).slice(before), [{ path: `/api/public/jobs/${existing.jobId}/owner/retry-prepare`, body: { action: 'stop', operationId: stop.operationId, attemptId: stop.preparation.attemptId } }]);
        const jobAfter = await repository.runTransaction(tx => tx.get('jobs', existing.jobId));
        assert.deepEqual(jobAfter.publicManifest, jobBefore.publicManifest); assert.deepEqual(jobAfter.scope, jobBefore.scope);
        assert.equal(calls.prepare, 2); assert.equal(await page.evaluate(() => window.integration.prompts), 1);
        assert.equal(await page.getByRole('button', { name: 'Retry stop preparation' }).count(), 0);
        assert.equal((await repository.runTransaction(tx => tx.get('ownerPreparationAttempts', stop.preparation.attemptId))).state, 'UNISSUED_FAILED');
      } else if (losePrepare) assert.equal(await page.getByRole('button', { name: 'Retry stop preparation' }).count(), 0);
      continue;
    }
    const observed = await snapshot();
    assert.equal(observed.error, null);
    assert.equal(observed.view.ownerOperations.find(op => op.action === action)?.status, 'CONFIRMED');
    if (action === 'stop') assert.equal(observed.view.job.state, 'STOPPED');
    if (action === 'withdraw') assert.equal(observed.view.ownerOperations.find(op => op.action === action).receipt.amountAtomic, '8');
    await page.reload(); await page.waitForFunction(() => !!window.integration);
    await page.evaluate(() => window.integration.start());
    await page.waitForFunction(() => !!window.integration.client.getSnapshot().view && !window.integration.client.getSnapshot().busy && !window.integration.auth.getSnapshot().busy);
    await page.evaluate(action => window.integration.client.approve(action), action);
    assert.equal((await snapshot()).error, 'OWNER_OPERATION_REQUIRES_RECONCILIATION');
  }
  assert.equal(await page.evaluate(() => window.integration.prompts), uncertainPrepare && !retryLane ? 1 : 2);
  await page.evaluate(() => window.integration.client.open('approved', 'existing'));
  assert.equal((await snapshot()).error, null, 'saved open remains a read after model closure');
  await page.evaluate(() => localStorage.removeItem(`haldir-public-job-v1:${location.origin}:owner.testnet`));
  const attemptsBefore = received.length;
  await page.evaluate(async () => { const c = window.integration.client; await c.open('approved', 'new'); await c.approve('create'); await c.run(); await c.run(true); });
  assert.equal((await snapshot()).error, 'FINANCIAL_NOT_CONFIGURED');
  assert.equal(received.length, attemptsBefore, 'closed admission/create/run must not reach transport');
  const raw = (path, body = {}, csrf = '1') => page.evaluate(async ({ path, body, csrf }) => {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(csrf === null ? {} : { 'x-haldir-csrf': csrf }) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { path, body, csrf });
  const path = `/api/public/jobs/${existing.jobId}`;
  const receipt = { operationId: (await snapshot()).view.ownerOperations.find(op => op.action === 'withdraw').operationId, transactionHash: '1'.repeat(31) + '2', signerId: ownerId };
  // The backend gate also stays closed if a caller bypasses the controller.
  for (const [route, body] of [['/api/public/jobs', { approvalId: 'approved', admissionKey: 'new' }], [`${path}/owner/prepare`, { action: 'create' }], [`${path}/run`, {}], [`${path}/resume`, {}]]) {
    assert.deepEqual(await raw(route, body), { status: 503, body: { error: 'FINANCIAL_NOT_CONFIGURED', contractVersion: 'haldir.public.v1' } });
  }
  const providerCountsBeforeNegatives = { ...calls };
  assert.equal((await raw(`${path}/owner/receipt`, { ...receipt, operationId: 'f'.repeat(64), transactionHash: '1'.repeat(31) + '4' })).status, 404);
  assert.equal((await raw(`${path}/owner/receipt`, { ...receipt, signerId: 'foreign.testnet' })).status, 400);
  assert.equal((await raw(`${path}/owner/receipt`, { ...receipt, transactionHash: '1'.repeat(31) + '3' })).status, 409);
  for (const csrf of [null, '0']) {
    for (const [route, body] of [[path, {}], [`${path}/owner/prepare`, { action: 'stop' }], [`${path}/owner/receipt`, receipt]])
      assert.equal((await raw(route, body, csrf)).status, 403);
  }
  assert.equal(await page.evaluate(async path => (await fetch(path, { headers: { 'x-haldir-csrf': '1' } })).status, path), 403, 'native GET without Origin remains rejected');
  await context.clearCookies();
  assert.equal((await raw(path)).status, 401);
  assert.equal((await raw('/api/wallet-auth/session')).status, 401);
  await context.addCookies([{ name: '__Host-haldir_session', value: tokens.foreign, url: origin, secure: true, httpOnly: true, sameSite: 'Strict' }]);
  assert.equal((await raw('/api/wallet-auth/session')).body.principal.accountId, 'foreign.testnet');
  for (const [route, body] of [[path, {}], [`${path}/owner/prepare`, { action: 'stop' }], [`${path}/owner/prepare`, { action: 'withdraw' }], [`${path}/owner/receipt`, receipt]]) {
    const result = await raw(route, body); assert.equal(result.status, 404); assert.equal(result.body.error, 'NOT_FOUND');
  }
  await context.addCookies([{ name: '__Host-haldir_session', value: tokens.owner, url: origin, secure: true, httpOnly: true, sameSite: 'Strict' }]);
  keyPresent = false;
  assert.equal((await raw(path)).status, 401); assert.equal((await raw('/api/wallet-auth/session')).status, 401);
  keyPresent = true;
  const ownerSessionId = createHash('sha256').update(tokens.owner, 'ascii').digest('hex');
  await repository.runTransaction(async tx => { const row = await tx.get('walletSessions', ownerSessionId); tx.set('walletSessions', ownerSessionId, { ...row, revokedAt: clock }); });
  assert.equal((await raw(path)).status, 401); assert.equal((await raw('/api/wallet-auth/session')).status, 401);
  assert.deepEqual(calls, providerCountsBeforeNegatives);
  assert.equal(calls.prepare, retryLane ? 3 : 2); assert.equal(calls.reconcile, uncertainPrepare && !retryLane ? 1 : 2); assert.equal(calls.manifests, 1); assert.equal(calls.forbiddenFetch, 0);
  const successfulReads = received.filter(row => row.path === path && row.status === 200);
  assert.ok(successfulReads.length >= 5);
  for (const row of successfulReads) { assert.equal(row.method, 'POST'); assert.equal(row.origin, origin); assert.equal(row.csrf, '1'); assert.equal(row.cookiePresent, true); }
  assert.deepEqual(denied, []); assert.deepEqual(errors, []);
  await mkdir(evidence, { recursive: true });
  await writeFile(evidence + `real-handler${uncertainPrepare ? '-' + scenario : ''}-chrome-receipt.json`, JSON.stringify({ status: 'PASS_SYNTHETIC_BROWSER_HEADERS_REAL_HTTP_AUTH_HANDLERS', browser: browser.version(), received, calls, prepareResponseLost, syntheticWalletResults: uncertainPrepare && !retryLane ? 1 : 2, realWalletPrompts: 0, actualTlsOrLoginOrChainAcceptance: false, transport: 'test-owned virtual-host loopback relay; Origin/CSRF/Cookie not synthesized', denied, errors }, null, 2));
});
