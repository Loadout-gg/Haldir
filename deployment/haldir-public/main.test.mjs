import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { once } from 'node:events';
import { request, createServer } from 'node:http';
import { KeyPair } from 'near-api-js';
import { serializeMessageNep413 } from '@meteorwallet/sdk';
import { requiredRuntimeSources, packagePublicRuntime } from './package-runtime.mjs';
import { createHash } from 'node:crypto';
import { quoteKey } from '../../src/shared/job-contract.mjs';

// TMPDIR is an explicit test prerequisite; never fall back to system temp.
async function approvedTempRoot() {
  const value = process.env.TMPDIR;
  assert.ok(typeof value === 'string' && isAbsolute(value), 'APPROVED_TMPDIR_REQUIRED');
  try { const root = await realpath(value); assert.ok((await stat(root)).isDirectory());
    await access(root, constants.W_OK | constants.X_OK); return root;
  } catch { throw Error('APPROVED_TMPDIR_UNAVAILABLE_OR_NOT_WRITABLE'); }
}
const scratchRoot = await approvedTempRoot();
const entry = new URL('./main.mjs', import.meta.url);
const configured = Object.freeze({ HALDIR_APPROVED_ORIGIN: 'https://haldir.ldt.sh',
  GOOGLE_CLOUD_PROJECT: 'loadout-haldir-demo', HALDIR_PROJECT_NUMBER: '147018706305',
  HALDIR_REGION: 'europe-west1', HALDIR_FIRESTORE_DATABASE_ID: 'haldir', PORT: '8080' });
// Positive allowlist: never inherit credentials, NODE_OPTIONS or NODE_TEST_CONTEXT.
const validationFence = 'data:text/javascript,' + encodeURIComponent(`
  import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http';
  import https from 'node:https'; import http2 from 'node:http2';
  import {syncBuiltinESMExports} from 'node:module';
  const counts={pid:process.pid,ppid:process.ppid,forbiddenTransport:0,listens:0};
  const deny=()=>{counts.forbiddenTransport++;throw new Error('VALIDATION_EXTERNAL_BLOCKED');};
  for(const [o,k] of [[globalThis,'fetch'],[net.Socket.prototype,'connect'],[tls,'connect'],
    [http,'request'],[http,'get'],[https,'request'],[https,'get'],[http2,'connect']]) o[k]=deny;
  net.Server.prototype.listen=()=>{counts.listens++;throw new Error('VALIDATION_LISTEN_BLOCKED');};
  syncBuiltinESMExports();
  process.on('exit',()=>process.stderr.write('VALIDATION_GUARD '+JSON.stringify(counts)+'\\n'));
`);
function run(patch = {}) {
  const child = spawnSync(process.execPath, ['--import', validationFence, entry.pathname], { encoding: 'utf8', timeout: 5000,
    env: { ...configured, HOME: scratchRoot, TMPDIR: scratchRoot, ...patch } });
  const marker = child.stderr.match(/VALIDATION_GUARD (.+)\n/); assert.ok(marker, child.stderr);
  const counts = JSON.parse(marker[1]); assert.equal(counts.ppid, process.pid);
  assert.equal(counts.forbiddenTransport, 0); assert.equal(counts.listens, 0);
  return { ...child, stderr: child.stderr.replace(marker[0], '') };
}
test('actual executable rejects missing/wrong canonical origin before ADC', () => {
  for (const origin of ['', 'http://haldir.ldt.sh', 'https://haldir.ldt.sh/', 'https://wrong.invalid']) {
    const child = run({ HALDIR_APPROVED_ORIGIN: origin });
    assert.equal(child.status, 1); assert.equal(child.stderr.trim(), 'EXACT_HTTPS_ORIGIN_REQUIRED');
    assert.equal(child.stdout, '');
  }
});
test('exact target, database, port and credential presence are validated before cloud imports', () => {
  for (const [patch, code] of [
    [{ GOOGLE_CLOUD_PROJECT: 'other' }, 'TARGET_PROJECT_REQUIRED'],
    [{ HALDIR_PROJECT_NUMBER: 'other' }, 'TARGET_PROJECT_REQUIRED'],
    [{ HALDIR_REGION: 'us-central1' }, 'REGION_REQUIRED'],
    [{ HALDIR_FIRESTORE_DATABASE_ID: '(default)' }, 'DATABASE_ID_REQUIRED'],
    [{ HALDIR_FIRESTORE_DATABASE_ID: 'preview-auth' }, 'DATABASE_ID_REQUIRED'],
    ...['0', '65536', '8e3', '08080', '-1', '8080x'].map(PORT => [{ PORT }, 'PORT_INVALID']),
    ...['GOOGLE_APPLICATION_CREDENTIALS', 'FIRESTORE_EMULATOR_HOST'].flatMap(key =>
      ['', '/never-read'].map(value => [{ [key]: value }, 'HOSTED_CREDENTIAL_OVERRIDE_FORBIDDEN'])),
  ]) {
    const child = run(patch);
    assert.equal(child.status, 1); assert.equal(child.stderr.trim(), code); assert.equal(child.stdout, '');
  }
});

// All fixture files are disposable scratch, never approved runtime source/UI.
const sourceRoot = new URL('../../', import.meta.url);
const fixtureReceipt = { approvedOrigin: configured.HALDIR_APPROVED_ORIGIN,
  viteApprovedOrigin: configured.HALDIR_APPROVED_ORIGIN, publicMode: 'public-testnet',
  originClassification: 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE' };
const preloadCode = String.raw`
import net from 'node:net'; import tls from 'node:tls';
import http from 'node:http'; import https from 'node:https'; import http2 from 'node:http2';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
const f = JSON.parse(await readFile(new URL('./fixture.json', import.meta.url)));
const c = { pid: process.pid, ppid: process.ppid, nativeNode: process.versions.node,
  testOnlyVersionGuardEmulation: f.nodeVersion !== process.versions.node,
  forbiddenTransport: 0, fixtureAdcInitializations: 0, readinessReads: 0,
  readinessDone: 0, serverCreations: 0, listens: [], sdkTerminations: 0, rpc: [] };
const deny = () => { c.forbiddenTransport++; throw new Error('TEST_EXTERNAL_NETWORK_BLOCKED'); };
for (const [o, k] of [[globalThis,'fetch'],[net.Socket.prototype,'connect'],[tls,'connect'],
  [http,'request'],[http,'get'],[https,'request'],[https,'get'],[http2,'connect']]) o[k] = deny;
const makeServer = http.createServer;
http.createServer = function(...args) { c.serverCreations++; if(!c.readinessDone) throw new Error('SERVER_BEFORE_READINESS'); return makeServer(...args); };
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(port,host,...args) {
  c.listens.push({port,host});
  if(!c.readinessDone || host !== '0.0.0.0' || port !== f.port) throw new Error('LISTEN_POLICY');
  return listen.call(this,port,host,...args);
};
syncBuiltinESMExports();
process.on('exit', () => process.stderr.write('PUBLIC_TEST_RECEIPT ' + JSON.stringify(c) + '\n'));
if (f.localStart) globalThis[Symbol.for('haldir.test.local-readiness')] = () => { c.readinessReads++; c.readinessDone++; };
if (f.guardControl) { try { await fetch('https://forbidden.invalid'); } catch {} }
Object.defineProperty(process.versions,'node',{value:f.nodeVersion});
// Fixture ADC exists ONLY here in the child, before actual adapter import.
const require = createRequire(new URL('./deployment/haldir-preview/package.json', import.meta.url));
const { Firestore } = require('@google-cloud/firestore');
const records = new Map(), transactions = new Map(); let serial = 0;
const stamp = {seconds:'1',nanos:0};
const doc = (collection,key) => 'projects/loadout-haldir-demo/databases/haldir/documents/namespaces/haldirPreviewTestnetV1/' + collection + '/k1_' + Buffer.from(key,'utf16le').toString('base64url');
for(const [collection,key,value] of f.records || []) {
  const name = doc(collection,key);
  records.set(name,{name,fields:{json:{stringValue:JSON.stringify(value)}},createTime:stamp,updateTime:stamp});
}
Firestore.prototype.initializeIfNeeded = async function() { c.fixtureAdcInitializations++; };
Firestore.prototype.requestStream = async function(method,bidi,r) {
  if(method !== 'batchGetDocuments' || bidi || r.documents.some(name=>!name.startsWith('projects/loadout-haldir-demo/databases/haldir/documents/namespaces/haldirPreviewTestnetV1/'))) throw new Error('UNEXPECTED_SDK_READ');
  if(r.documents.includes(doc('walletChallenges','haldir-readiness-v1'))) {
    c.readinessReads++;
    if(f.readiness === 'deny') throw new Error('FIXTURE_READINESS_DENIED_SECRET_MUST_NOT_LEAK');
    if(f.readiness === 'hold') {
      process.send({event:'readiness-read',pid:process.pid});
      await new Promise(resolve=>process.once('message',m=> {if(m !== 'release-readiness') throw new Error('BAD_RELEASE'); resolve();}));
    }
    c.readinessDone++;
  }
  let transaction = r.transaction;
  if(r.newTransaction) { transaction=Buffer.from(String(++serial)); transactions.set(transaction.toString(),new Map(records)); }
  const rows=transaction?transactions.get(Buffer.from(transaction).toString()):records;
  return Readable.from(r.documents.map(name=>({...rows.has(name)?{found:rows.get(name)}:{missing:name},readTime:stamp,...transaction?{transaction}:{}})),{objectMode:true});
};
Firestore.prototype.request = async function(method,r) {
  if(!['commit','rollback'].includes(method)) throw new Error('UNEXPECTED_SDK_WRITE');
  if(method === 'rollback') return {};
  for(const w of r.writes) {
    if(!w.update || w.delete || w.transform || (w.currentDocument?.exists === false && records.has(w.update.name))) throw new Error('UNEXPECTED_WRITE');
    if(w.update.name.includes('/publicApprovals/')) throw new Error('APPROVAL_MUTATION');
    records.set(w.update.name,{...structuredClone(w.update),createTime:stamp,updateTime:stamp});
  }
  return {commitTime:stamp,writeResults:r.writes.map(()=>({updateTime:stamp}))};
};
const terminate=Firestore.prototype.terminate;
Firestore.prototype.terminate = function() {c.sdkTerminations++;return terminate.call(this);};
// Closed fixture at the existing SDK transport boundary; no native fallback.
// Only real owner-key reads and owner receipt status attempts are admitted.
globalThis.fetch = async (url,init) => {
  if(url !== 'https://rpc.testnet.near.org' || init.method !== 'POST' || init.redirect !== 'error' || !(init.signal instanceof AbortSignal)) return deny();
  const r=JSON.parse(init.body); c.rpc.push(r);
  let result;
  if(r.method === 'status') result={chain_id:'testnet',sync_info:{syncing:false}};
  else if(r.method === 'query' && r.params.request_type === 'view_access_key' && r.params.public_key === f.ownerKey && r.params.account_id === 'alice.testnet' && r.params.finality === 'final')
    result={nonce:1,permission:'FullAccess',block_height:123,block_hash:'11111111111111111111111111111111'};
  else if(r.method === 'EXPERIMENTAL_tx_status') result={}; // Insufficient proof stays UNKNOWN.
  else return deny();
  return Response.json({jsonrpc:'2.0',id:r.id,result});
};
`;
async function tree(t, fixture = {}) {
  const root = await mkdtemp(join(scratchRoot, 'haldir-public-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = [...requiredRuntimeSources.filter(path => !/\/package(?:-lock)?\.json$/.test(path)),
    'deployment/haldir-public/package.json', 'deployment/haldir-public/package-lock.json',
    'src/server/near-manifest.mjs', 'src/server/near-mandate-status.mjs', 'deployment/haldir-testnet/manifest.mjs',
    'deployment/haldir-public/agent-signer.mjs', 'deployment/haldir-public/near-ai-model.mjs',
    'deployment/haldir-public/near-ai-runner-port.mjs', 'deployment/haldir-public/near-ai-policy.mjs',
    'deployment/haldir-public/near-ai-transport.mjs', 'deployment/haldir-public/near-ai-worker.mjs',
    'deployment/haldir-public/main.mjs', 'deployment/haldir-public/trusted-composition.mjs',
    'deployment/haldir-public/production-policy.mjs', 'deployment/haldir-public/production-binding.mjs',
    'deployment/haldir-public/protected-secrets.mjs'];
  for (const path of sources) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), await readFile(new URL(path, sourceRoot)));
  }
  await symlink(new URL('node_modules', sourceRoot), join(root, 'node_modules'), 'dir');
  await symlink(new URL('deployment/haldir-preview/node_modules', sourceRoot), join(root, 'deployment/haldir-preview/node_modules'), 'dir');
  const pub = join(root, 'deployment/haldir-public');
  await mkdir(join(pub, 'ui/assets'), { recursive: true }); await mkdir(join(pub, 'ui/fonts'));
  await writeFile(join(pub, 'ui/index.html'), '<!doctype html>SYNTHETIC BOOTSTRAP UI, NOT BUILT');
  await writeFile(join(pub, 'ui/assets/fixture.js'), '/* SYNTHETIC */');
  await writeFile(join(pub, 'ui/fonts/fixture.txt'), 'SYNTHETIC');
  if (!fixture.missingReceipt) await writeFile(join(pub, 'ui-build-receipt.json'), JSON.stringify(fixture.receipt ?? fixtureReceipt));
  await mkdir(join(root, 'home')); await mkdir(join(root, 'tmp'));
  await writeFile(join(root, 'preload.mjs'), preloadCode);
  await writeFile(join(root, 'fixture.json'), JSON.stringify({ nodeVersion: '26.13.1', port: 8080, ...fixture }));
  return { root, sources, entry: join(pub, 'main.mjs'), preload: join(root, 'preload.mjs') };
}
test('actual new bootstrap/composition fit the unchanged finite packager and literal import closure', async t => {
  const f = await tree(t), outDir = f.root + '-packaged';
  t.after(async () => { await rm(outDir, { recursive: true, force: true }); await rm(outDir + '-manifest.json', { force: true }); });
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const app = '// SYNTHETIC SOURCE ONLY, NOT BUILT\n';
  await mkdir(join(f.root, 'prototype/src'), { recursive: true });
  await writeFile(join(f.root, 'prototype/src/App.tsx'), app);
  const sourceInputs = { 'prototype/src/App.tsx': sha(app) }, runtimeInputHashes = {};
  for (const path of f.sources) runtimeInputHashes[path] = sha(await readFile(join(f.root, path)));
  const outputs = {};
  for (const path of ['index.html', 'assets/fixture.js', 'fonts/fixture.txt']) outputs[path] = sha(await readFile(join(dirname(f.entry), 'ui', path)));
  await writeFile(join(dirname(f.entry), 'ui-build-receipt.json'), JSON.stringify({ ...fixtureReceipt, sourceInputs, outputs }));
  await writeFile(join(dirname(f.entry), 'source-allowlist.json'), JSON.stringify({ runtimeSources: f.sources, runtimeInputHashes, uiBuildInputs: sourceInputs }));
  const receipt = await packagePublicRuntime({ root: f.root, outDir, approvedOrigin: configured.HALDIR_APPROVED_ORIGIN, testFixture: true });
  assert.equal(receipt.classification, 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE');
  assert.equal(receipt.entrypoint, 'node deployment/haldir-public/main.mjs');
  for (const path of ['deployment/haldir-public/main.mjs', 'deployment/haldir-public/trusted-composition.mjs'])
    assert.equal(sha(await readFile(join(outDir, path))), runtimeInputHashes[path]);
});
test('exported real start uses the exact local opener rather than the fixed hosted opener', async t => {
  const target = await tree(t, { readiness: 'deny' });
  const child = guarded(target, {}, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const {startPublicRuntime}=await import(${JSON.stringify(new URL('file://' + target.entry).href)});
    let opens=0;
    const localQualification={signingBindings:[],resolveKeyMaterial:async()=>{throw Error('NEVER');},model:{
      apiKey:'synthetic-not-provider-key',authorizationExpiresAt:'2099-01-01T00:00:00Z',transportFactory:()=>{throw Error('NEVER');}}};
    await assert.rejects(startPublicRuntime({localQualification,openRepository:async input=>{
      opens++;assert.deepEqual(input,{projectId:'loadout-haldir-demo',databaseId:'haldir',namespace:'haldirPreviewTestnetV1',timeoutMs:5000});
      throw Error('INJECTED_OPEN_SENTINEL');
    }}),{message:'INJECTED_OPEN_SENTINEL'});
    assert.equal(opens,1);
  `]);
  assert.equal(child.status, 0, child.stderr);
  const r = report(child); assert.equal(r.forbiddenTransport, 0); assert.equal(r.fixtureAdcInitializations, 0);
  assert.equal(r.readinessReads, 0); assert.equal(r.serverCreations, 0);
});

test('injected real start listens with the real local graph, shares repository with wallet auth, and drains before close', async t => {
  const pair = KeyPair.fromRandom('ed25519'), port = await reservePort();
  const target = await tree(t, { localStart: true, port, ownerKey: pair.getPublicKey().toString() });
  const script = `
    import assert from 'node:assert/strict';
    const {startPublicRuntime}=await import(${JSON.stringify(new URL('file://' + target.entry).href)});
    const {openLocalRepository}=await import(${JSON.stringify(new URL('file://' + join(target.root, 'src/server/orders.mjs')).href)});
    const collections=new Set();let opens=0,closes=0,runtime;
    const localQualification={signingBindings:[],resolveKeyMaterial:async()=>{throw Error('NO_SECRET_EXPECTED');},model:{
      apiKey:'synthetic-not-provider-key',authorizationExpiresAt:'2099-01-01T00:00:00Z',transportFactory:()=>{throw Error('NO_MODEL_EXPECTED');}}};
    runtime=await startPublicRuntime({localQualification,openRepository:async input=>{
      opens++;assert.deepEqual(input,{projectId:'loadout-haldir-demo',databaseId:'haldir',namespace:'haldirPreviewTestnetV1',timeoutMs:5000});
      const local=openLocalRepository({filename:${JSON.stringify(join(target.root, 'local-start.sqlite'))},localTestOnly:true});
      return {runTransaction:fn=>local.runTransaction(tx=>fn({
        get:(c,k)=>{collections.add(c);return tx.get(c,k);},create:(...a)=>tx.create(...a),set:(...a)=>tx.set(...a)})),
        verifyReadiness:async()=>globalThis[Symbol.for('haldir.test.local-readiness')](),
        close:async()=>{assert.equal(runtime.server.listening,false);closes++;local.close();}};
    }});
    assert.equal(opens,1);assert.equal(runtime.server.listening,true);
    process.send({event:'local-listening',pid:process.pid});
    process.once('message',async m=>{try{
      assert.equal(m,'close');assert.ok(collections.has('walletChallenges'));assert.ok(collections.has('walletSessions'));
      const a=runtime.close(),b=runtime.close();assert.equal(a,b);await a;assert.equal(closes,1);
      process.send({event:'local-closed',pid:process.pid,collections:[...collections],closes});process.disconnect();
    }catch(e){console.error(e);process.exitCode=1;process.disconnect();}});
  `;
  const child = spawn(process.execPath, ['--import', target.preload, '--input-type=module', '--eval', script], {
    env: { ...configured, HOME: join(target.root, 'home'), TMPDIR: join(target.root, 'tmp'), PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  const [ready] = await Promise.race([once(child, 'message'), exited.then(() => { throw Error(stderr); })]);
  assert.deepEqual(ready, { event: 'local-listening', pid: child.pid });
  assert.equal((await call(port, '/healthz')).status, 200);
  const challenge = await call(port, '/api/wallet-auth/challenge', { accountId: 'alice.testnet', networkId: 'testnet' });
  assert.equal(challenge.status, 200, challenge.text);
  const c = JSON.parse(challenge.text);
  const verified = await call(port, '/api/wallet-auth/verify', { accountId: 'alice.testnet', networkId: 'testnet', challengeId: c.challengeId,
    publicKey: pair.getPublicKey().toString(), signature: Buffer.from(pair.sign(serializeMessageNep413({ ...c.payload,
      nonce: Buffer.from(c.payload.nonce, 'base64') })).signature).toString('base64') });
  assert.equal(verified.status, 200, verified.text);
  const config = await call(port, '/api/public/config', {}, { cookie: verified.headers['set-cookie'][0].split(';')[0] });
  assert.equal(config.status, 200, config.text); assert.equal(JSON.parse(config.text).financialActions, true);
  assert.deepEqual(JSON.parse(config.text).missingConfiguration, []);
  const closed = once(child, 'message'); child.send('close');
  const [result] = await closed; assert.equal(result.event, 'local-closed'); assert.equal(result.closes, 1);
  assert.deepEqual(await exited, [0, null]);
  const r = report({ stderr }); assert.equal(r.forbiddenTransport, 0); assert.equal(r.fixtureAdcInitializations, 0);
  assert.equal(r.readinessReads, 1); assert.equal(r.serverCreations, 2);
});

test('injected start rejects partial/extended options and nested policy before opening', async t => {
  const target = await tree(t);
  const child = guarded(target, {}, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const {startPublicRuntime}=await import(${JSON.stringify(new URL('file://' + target.entry).href)});
    let opens=0;const openRepository=async()=>{opens++;throw Error('OPENED');};
    const q={signingBindings:[],resolveKeyMaterial:async()=>{},model:{apiKey:'synthetic-not-provider-key',
      authorizationExpiresAt:'2099-01-01T00:00:00Z',transportFactory:()=>{}}};
    for(const options of [null,[],{openRepository},{localQualification:q},{openRepository,localQualification:q,server:{}},
      {openRepository,localQualification:{...q,enabled:true}},{openRepository,localQualification:{...q,model:{...q.model,budgetFactory:()=>{}}}}])
      await assert.rejects(startPublicRuntime(options));
    process.env.GOOGLE_APPLICATION_CREDENTIALS='';
    await assert.rejects(startPublicRuntime({openRepository,localQualification:q}),{message:'HOSTED_CREDENTIAL_OVERRIDE_FORBIDDEN'});
    assert.equal(opens,0);
  `]);
  assert.equal(child.status, 0, child.stderr);
  const r = report(child); assert.equal(r.forbiddenTransport, 0); assert.equal(r.fixtureAdcInitializations, 0);
  assert.equal(r.readinessReads, 0); assert.equal(r.serverCreations, 0);
});

function report(child) {
  const match = child.stderr.match(/PUBLIC_TEST_RECEIPT (.+)/);
  assert.ok(match, child.stderr);
  const value = JSON.parse(match[1]); assert.equal(value.ppid, process.pid);
  assert.equal(value.nativeNode, process.versions.node);
  return value;
}
function guarded(target, env = {}, argv) {
  return spawnSync(process.execPath, ['--import', target.preload, ...(argv ?? [target.entry])], {
    encoding: 'utf8', timeout: 10000, env: { ...configured, HOME: join(target.root, 'home'), TMPDIR: join(target.root, 'tmp'), ...env } });
}
test('actual import is inert even with complete/poisoned env; guard detects caught external attempts', async t => {
  for (const guardControl of [false, true]) {
    const target = await tree(t, { guardControl });
    const child = guarded(target, { HALDIR_FINANCIAL_ACTIONS: 'true', HALDIR_MODEL: 'forbidden',
      HALDIR_SIGNER_MODULE: 'https://forbidden.invalid/evil.mjs', GOOGLE_APPLICATION_CREDENTIALS: '/must-not-read' },
    ['--input-type=module', '--eval', `await import(${JSON.stringify(new URL('file://' + target.entry).href)}); await import(${JSON.stringify(new URL('file://' + join(dirname(target.entry), 'trusted-composition.mjs')).href)})`]);
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, '');
    const r = report(child);
    assert.equal(r.forbiddenTransport, guardControl ? 1 : 0);
    assert.equal(r.fixtureAdcInitializations, 0); assert.equal(r.readinessReads, 0);
    assert.equal(r.serverCreations, 0); assert.deepEqual(r.rpc, []);
  }
});
test('guarded actual entrypoint rejects runtime, receipt, credentials and origin before any SDK/DB activity', async t => {
  for (const [fixture, env, code] of [
    [{ nodeVersion: '26.13.0' }, {}, 'NODE_26_13_1_REQUIRED'],
    [{ missingReceipt: true }, {}, 'UI_APPROVED_ORIGIN_MISMATCH'],
    [{ receipt: { ...fixtureReceipt, viteApprovedOrigin: 'https://wrong.invalid' } }, {}, 'UI_APPROVED_ORIGIN_MISMATCH'],
    [{ receipt: { ...fixtureReceipt, approvedOrigin: 'https://wrong.invalid' } }, {}, 'UI_APPROVED_ORIGIN_MISMATCH'],
    [{ receipt: { ...fixtureReceipt, publicMode: 'wallet-auth-qualification' } }, {}, 'UI_APPROVED_ORIGIN_MISMATCH'],
    [{}, { GOOGLE_APPLICATION_CREDENTIALS: '' }, 'HOSTED_CREDENTIAL_OVERRIDE_FORBIDDEN'],
    [{}, { HALDIR_APPROVED_ORIGIN: 'https://wrong.invalid' }, 'EXACT_HTTPS_ORIGIN_REQUIRED'],
  ]) {
    const target = await tree(t, fixture), child = guarded(target, env);
    assert.equal(child.status, 1); assert.equal(child.stderr.split('\n')[0], code);
    const r = report(child);
    assert.equal(r.forbiddenTransport, 0); assert.equal(r.fixtureAdcInitializations, 0);
    assert.equal(r.readinessReads, 0); assert.equal(r.serverCreations, 0); assert.deepEqual(r.listens, []);
  }
});
test('real adapter readiness failure is redacted and closes SDK without constructing/listening', async t => {
  const target = await tree(t, { readiness: 'deny' }), child = guarded(target);
  assert.equal(child.status, 1); assert.equal(child.stderr.split('\n')[0], 'PUBLIC_STARTUP_FAILED');
  const r = report(child); assert.equal(r.forbiddenTransport, 0);
  assert.equal(r.readinessReads, 1); assert.equal(r.sdkTerminations, 1);
  assert.equal(r.serverCreations, 0); assert.deepEqual(r.listens, []);
});
test('post-readiness UI construction failure still drains the real SDK and never listens', async t => {
  const target = await tree(t);
  await rm(join(dirname(target.entry), 'ui/index.html'));
  const child = guarded(target);
  assert.equal(child.status, 1); assert.equal(child.stderr.split('\n')[0], 'PUBLIC_STARTUP_FAILED');
  const r = report(child); assert.equal(r.readinessDone, 1); assert.equal(r.sdkTerminations, 1);
  assert.equal(r.serverCreations, 0); assert.equal(r.forbiddenTransport, 0); assert.deepEqual(r.listens, []);
});
test('listen failure closes repository without advertising a working server', async t => {
  const reservation = createServer(); reservation.listen(0, '0.0.0.0'); await once(reservation, 'listening');
  t.after(() => new Promise(resolve => reservation.close(resolve)));
  const port = reservation.address().port;
  const target = await tree(t, { port });
  const child = guarded(target, { PORT: String(port) });
  assert.equal(child.status, 1); assert.equal(child.stderr.split('\n')[0], 'PUBLIC_STARTUP_FAILED'); assert.equal(child.stdout, '');
  const r = report(child); assert.equal(r.readinessDone, 1); assert.equal(r.sdkTerminations, 1);
  assert.equal(r.forbiddenTransport, 0); assert.equal(r.listens.length, 1);
});
function call(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST',
      headers: { host: 'haldir.ldt.sh', ...(body === undefined ? {} : {
        origin: configured.HALDIR_APPROVED_ORIGIN, 'content-type': 'application/json', 'x-haldir-csrf': '1' }), ...headers } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function reservePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function existingJob() {
  const scope = { networkId: 'testnet', mandateId: 'mandate.testnet', purpose: 'SYNTHETIC recovery', output: 'Report',
    vendorIds: ['vendor.testnet'], budgetAtomic: '30', expiresAt: '2026-11-13T18:00:00Z' };
  const quote = { networkId: 'testnet', mandateId: scope.mandateId, vendorId: 'vendor.testnet',
    amountAtomic: '8', orderId: 'quote-1', content: 'SYNTHETIC' };
  return { jobId: 'existing-job', ownerId: 'alice.testnet', quoteId: quoteKey(quote), scope, state: 'LOCAL_ACTIVE',
    qualification: 'PUBLIC_TESTNET_FICTIONAL_VENDOR', publicManifest: {
      manifestId: 'synthetic-persisted-approval', ownerId: 'alice.testnet',
      approved: { job: scope, quote },
      binding: { networkId: 'testnet', ownerId: 'alice.testnet', signerId: 'agent.testnet', mandateId: scope.mandateId,
        publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString(), maxAllowanceAtomic: '1000',
        codeHash: '11111111111111111111111111111111' },
      rpcUrl: 'https://rpc.testnet.near.org', allowedRpcUrls: ['https://rpc.testnet.near.org'],
      chainEvidence: { networkId: 'testnet', finality: 'final', blockHash: '11111111111111111111111111111111',
        blockHeight: 123, observedAt: Date.now(), deployment: 'MANDATE_READY' },
    } };
}
test('real autoentrypoint awaits readiness, mounts auth/owned reads/recovery without model, drains on SIGTERM', async t => {
  const pair = KeyPair.fromRandom('ed25519'), port = await reservePort();
  // Historical closed-admission recovery fixture: explicit validated source rows,
  // not used as evidence for new post-start admission (qualified separately).
  const stored = existingJob(), quote = stored.publicManifest.approved.quote;
  const target = await tree(t, { readiness: 'hold', port, ownerKey: pair.getPublicKey().toString(),
    records: [['jobs', 'existing-job', stored],
      ['quotes', stored.quoteId, { jobId: stored.jobId, ownerId: stored.ownerId, quote }],
      ['orders', stored.quoteId, { jobId: stored.jobId, quoteId: stored.quoteId, orderId: quote.orderId, quote,
        lifecycle: 'PAYMENT_PENDING', proof: null, artifact: null, lastCheckCode: null }]] });
  const child = spawn(process.execPath, ['--import', target.preload, target.entry], {
    env: { ...configured, HOME: join(target.root, 'home'), TMPDIR: join(target.root, 'tmp'), PORT: String(port), HALDIR_FINANCIAL_ACTIONS: 'true', HALDIR_QUALIFIED_MODEL: 'true',
      HALDIR_QUALIFIED_SIGNING: 'true', HALDIR_MODEL: 'not-a-provider', HALDIR_SIGNER_MODULE: 'https://forbidden.invalid' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM'); await exited;
    if (!t.passed) t.diagnostic(stderr);
  });
  const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(stderr); })]);
  assert.deepEqual(message, { event: 'readiness-read', pid: child.pid }); assert.equal(stdout, '');
  await assert.rejects(call(port, '/healthz'), { code: 'ECONNREFUSED' });
  child.send('release-readiness');
  while (!stdout.includes('HALDIR_PUBLIC_LISTENING_FINANCIAL_ACTIONS_DISABLED')) {
    await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error(stderr); })]);
  }
  assert.equal((await call(port, '/healthz')).status, 200);
  assert.equal((await call(port, '/?mode=public-testnet')).status, 200);
  assert.equal((await call(port, '/', undefined, { host: 'evil.invalid' })).status, 403);
  assert.equal((await call(port, '/api/public/config', {})).status, 401);
  const challenge = await call(port, '/api/wallet-auth/challenge', { accountId: 'alice.testnet', networkId: 'testnet' });
  assert.equal(challenge.status, 200, challenge.text);
  const c = JSON.parse(challenge.text);
  const proof = { accountId: 'alice.testnet', networkId: 'testnet', challengeId: c.challengeId,
    publicKey: pair.getPublicKey().toString(), signature: Buffer.from(pair.sign(serializeMessageNep413({
      ...c.payload, nonce: Buffer.from(c.payload.nonce, 'base64') })).signature).toString('base64') };
  const verified = await call(port, '/api/wallet-auth/verify', proof);
  assert.equal(verified.status, 200, verified.text);
  const cookie = verified.headers['set-cookie'][0].split(';')[0], headers = { cookie };
  assert.equal((await call(port, '/api/wallet-auth/session', {}, headers)).status, 200);
  const config = await call(port, '/api/public/config', {}, headers);
  assert.equal(config.status, 200, config.text);
  const value = JSON.parse(config.text);
  assert.equal(value.financialActions, false); assert.equal(value.maxRunMs, 20000);
  assert.deepEqual(value.missingConfiguration, ['financialActions', 'qualifiedModel', 'qualifiedSigning', 'trustedSignerProvider', 'model']);
  assert.equal((await call(port, '/api/public/jobs', { approvalId: 'not-provisioned', admissionKey: 'one' }, headers)).status, 503);
  const owned = await call(port, '/api/public/jobs/existing-job', {}, headers);
  assert.equal(owned.status, 200, owned.text); assert.equal(JSON.parse(owned.text).job.jobId, 'existing-job');
  assert.equal(JSON.parse(owned.text).job.ownerCreationRequired, false);
  assert.equal((await call(port, '/api/public/jobs/foreign-job', {}, headers)).status, 404);
  for (const action of ['create', 'stop', 'withdraw']) {
    const result = await call(port, '/api/public/jobs/existing-job/owner/prepare', { action }, headers);
    assert.equal(result.status, action === 'create' ? 503 : 200, result.text);
    if (action === 'create') continue;
    const op = JSON.parse(result.text).operation;
    assert.equal(op.status, 'AWAITING_WALLET'); assert.equal(op.request.methodName, action);
    assert.equal(op.request.signerId, 'alice.testnet'); assert.equal(op.request.gas, '100000000000000');
    const receipt = await call(port, '/api/public/jobs/existing-job/owner/receipt', {
      operationId: op.operationId, transactionHash: action === 'stop' ? '11111111111111111111111111111111' : '11111111111111111111111111111112', signerId: 'alice.testnet' }, headers);
    assert.equal(receipt.status, 200, receipt.text); assert.equal(JSON.parse(receipt.text).operation.status, 'UNKNOWN');
  }
  assert.equal((await call(port, '/api/public/jobs/existing-job/run', {}, headers)).status, 503);
  assert.equal((await call(port, '/api/public/config', {}, { ...headers, origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await call(port, '/api/public/approvals', {}, headers)).status, 404);
  child.kill('SIGTERM'); assert.deepEqual(await exited, [0, null]);
  const r = report({ stderr }); assert.equal(r.pid, child.pid);
  assert.equal(r.forbiddenTransport, 0); assert.equal(r.readinessReads, 1); assert.equal(r.readinessDone, 1);
  assert.equal(r.serverCreations, 2); // Delivered auth factory also constructs one unlistened server.
  assert.deepEqual(r.listens, [{ port, host: '0.0.0.0' }]);
  assert.equal(r.sdkTerminations, 1); assert.ok(r.rpc.some(r => r.method === 'EXPERIMENTAL_tx_status'));
  assert.equal(r.rpc.some(r => /send|broadcast/i.test(r.method)), false);
  t.diagnostic(JSON.stringify({ ...r, rpc: r.rpc.map(row => row.method) }));
});
