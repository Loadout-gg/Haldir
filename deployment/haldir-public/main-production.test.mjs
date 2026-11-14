import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { KeyPair } from 'near-api-js';
import { serializeMessageNep413 } from '@meteorwallet/sdk';
import { requiredRuntimeSources, optionalRuntimeSources } from './package-runtime.mjs';

const root = new URL('../../', import.meta.url), origin = 'https://haldir.ldt.sh';
const env = { HALDIR_APPROVED_ORIGIN: origin, GOOGLE_CLOUD_PROJECT: 'loadout-haldir-demo',
  HALDIR_PROJECT_NUMBER: '147018706305', HALDIR_REGION: 'europe-west1', HALDIR_FIRESTORE_DATABASE_ID: 'haldir' };
const preloader = String.raw`
import { registerHooks } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { installClosedFixture } from './deployment/haldir-public/operational-entrypoint-fixture.mjs';
const f = JSON.parse(await readFile(new URL('./fixture.json', import.meta.url)));
// Deterministic clock installed BEFORE constructors capture Date.now.
let forcedNow=Date.parse('2026-11-14T00:00:00Z'); Date.now=()=>forcedNow;
// The incumbent fixture imports transport during setup: install the worker hook
// BEFORE setup, not merely before the later main import.
registerHooks({resolve(specifier,context,next) {
  if(specifier==='node:worker_threads' && context.parentURL===pathToFileURL(f.root+'/deployment/haldir-public/near-ai-transport.mjs').href) {
    const fence=pathToFileURL(f.root+'/worker-fence.mjs').href;
    const source='import {Worker as Native} from "node:worker_threads"; export class Worker extends Native { constructor(url,o) { globalThis.__operationalFixture.c.workerConstructors++; super(url,{...o,execArgv:["--import",'+JSON.stringify(fence)+']}); } }';
    return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
  }
  return next(specifier,context);
}});
await installClosedFixture(f); // Installs transport denial BEFORE application imports.
const x = globalThis.__operationalFixture, c = x.c;
const at = p => pathToFileURL(f.root + '/' + p).href;
const pub = 'deployment/haldir-public/';
const row = x.localQualification.signingBindings[0];
const version = 'projects/147018706305/secrets/haldir-agent-pay-synthetic/versions/1';
const modelVersion = 'projects/147018706305/secrets/haldir-model-synthetic/versions/1';
const sealed = { schemaVersion: 'haldir.production-binding.v1', state: 'sealed',
  activationApprovalId: 'SYNTHETIC_NOT_LIVE_APPROVAL', projectId: 'loadout-haldir-demo', projectNumber: '147018706305',
  region: 'europe-west1', runtimeServiceAccount: 'haldir-runtime@loadout-haldir-demo.iam.gserviceaccount.com',
  model: { model: 'z-ai/glm-5.3-flash', credentialVersion: modelVersion,
    authorizationExpiresAt: '2026-11-16T23:59:00Z', historicalBudgetUsdTotal: '50' },
  signingBindings: [{ ...row, keyVersion: version }] };
const policy = ['closed','compat'].includes(f.policy) ? { schemaVersion: sealed.schemaVersion, state: 'closed' } : sealed;
if (f.policy === 'malformed') policy.model.credentialVersion = modelVersion.replace('/1', '/latest');
if (f.policy === 'expired') forcedNow=Date.parse('2026-11-17T00:00:00Z');
await writeFile(new URL(pub + 'production-policy.mjs', at('')), 'export const PRODUCTION_BINDING = Object.freeze(' + JSON.stringify(policy) + ');\n');
c.secretReads = []; c.metadata = []; c.graph = null;
const rpc = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('http://metadata.google.internal/')) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).get('Metadata-Flavor'), 'Google');
    c.metadata.push(u);
    const prefix = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/';
    if (u === prefix + 'email') return new Response(sealed.runtimeServiceAccount, { headers: { 'Metadata-Flavor': 'Google' } });
    if (u === prefix + 'token') return Response.json({ access_token: 'SYNTHETIC_ADC_TOKEN', token_type: 'Bearer', expires_in: 600 }, { headers: { 'Metadata-Flavor': 'Google' } });
    assert.fail('unexpected metadata path');
  }
  if (u.startsWith('https://secretmanager.googleapis.com/')) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer SYNTHETIC_ADC_TOKEN');
    const name = u.slice('https://secretmanager.googleapis.com/v1/'.length).replace(/:access$/, '');
    assert.ok(name === modelVersion || name === version); c.secretReads.push(name);
    const value = name === modelVersion ? 'SYNTHETIC_CLOSED_OPERATIONAL_AI_KEY' : f.policy === 'wrong-key' ? (await import('near-api-js')).KeyPair.fromRandom('ed25519').toString() : await x.localQualification.resolveKeyMaterial({ keyVersion: row.keyVersion, signal: init.signal });
    if(f.policy==='expires-during-secret' && name===modelVersion) forcedNow=Date.parse('2026-11-17T00:00:00Z');
    const response=Response.json({ name, payload: { data: Buffer.from(value).toString('base64') } });
    if(f.policy==='abort-key' && name===version) {
      const reader=response.body.getReader();
      return {status:200,redirected:false,headers:response.headers,body:{getReader:()=>({read:()=>reader.read(),releaseLock:()=>reader.releaseLock(),
        async cancel(){await reader.cancel();c.secretDrains=(c.secretDrains??0)+1;globalThis.__testResolveAbort.abort('DUMMY_NOT_SECRET_ABORT');}})}};
    }
    return response;
  }
  return rpc(url, init);
};
const main = at(pub + 'main.mjs'), server = at(pub + 'server.mjs'), firestore = at('deployment/haldir-preview/firestore-repository.mjs');
c.workerConstructors=0;
const workerFence=at('worker-fence.mjs');
await writeFile(new URL(workerFence), [
'import net from "node:net"; import tls from "node:tls"; import http from "node:http"; import https from "node:https"; import http2 from "node:http2";',
'import {syncBuiltinESMExports} from "node:module"; import {writeFileSync} from "node:fs";',
'const c={forbidden:0}; const save=()=>writeFileSync('+JSON.stringify(f.root+'/worker-counts.json')+',JSON.stringify(c));',
'const deny=()=>{c.forbidden++;save();throw Error("SYNTHETIC_WORKER_TRANSPORT_DENIED");};',
'for(const [o,k] of [[globalThis,"fetch"],[net.Socket.prototype,"connect"],[tls,"connect"],[http,"request"],[http,"get"],[https,"request"],[https,"get"],[http2,"connect"]])o[k]=deny;',
'syncBuiltinESMExports();save();',
].join('\n'));
registerHooks({ resolve(specifier, context, next) {
  const found = next(specifier, context);
  if (found.url === firestore) { assert.equal(context.parentURL, main); c.hooks.push({ target: found.url, parent: context.parentURL }); }
  return found;
}, load(url, context, next) {
  if (url === firestore) return { format: 'module', shortCircuit: true, source: 'export const openFirestoreRepository=globalThis.__operationalFixture.openRepository;' };
  if (url === server) return { format: 'module', shortCircuit: true, source:
    'import {createPublicServer as real} from ' + JSON.stringify(server + '?actual-production=1') + '; export function createPublicServer(o) { globalThis.__productionGraph=o; const c=globalThis.__operationalFixture.c; c.constructors++; c.graph={model:o.model?.contractVersion,signer:typeof o.trustedSignerProvider,ownerRecovery:typeof o.ownerOperations?.prepare,capabilities:o.capabilities,maxRunMs:o.maxRunMs}; return real(o); }' };
  return next(url, context);
} });
const incumbentMessage = process.listeners('message')[0]; process.removeListener('message', incumbentMessage);
process.on('message', async m => {
  if (m.kind === 'bootstrap-state') { let worker; try {worker=JSON.parse(await readFile(new URL('worker-counts.json',at(''))));}catch{} return process.send({id:m.id,c,worker}); }
  if (m.kind === 'expire-ai') { forcedNow=Date.parse('2026-11-17T00:00:00Z'); return process.send({id:m.id,expired:true}); }
  if (['expired-plan','blocked-plan','recover-plan'].includes(m.kind)) {
    try {
      const g = globalThis.__productionGraph;
      const job = await g.repository.runTransaction(tx => tx.get('jobs', m.jobId));
      const { approvedInput, approvedSources } = await import(at('src/shared/job-contract.mjs'));
      const sources = approvedSources(job.publicManifest.approved);
      await g.model[m.kind==='recover-plan'?'recover':'propose']({phase:'plan',approvedJobInput:approvedInput(job),approvedSources:sources,tools:[{name:'requestquotes',approvedSources:sources}],signal:new AbortController().signal});
      process.send({id:m.id,result:'UNEXPECTED_SUCCESS'});
    } catch (e) { process.send({id:m.id,result:['MODEL_NOT_SENT','MODEL_UNAVAILABLE','MODEL_CACHE_UNAVAILABLE'].includes(e?.code)?'MODEL_BLOCKED':'UNEXPECTED_FAILURE'}); }
    return;
  }
  if (m.kind !== 'resolve-admitted') return incumbentMessage(m);
  try {
    const g = globalThis.__productionGraph;
    const job = await g.repository.runTransaction(tx => tx.get('jobs', m.jobId));
    const controller=new AbortController(); globalThis.__testResolveAbort=controller;
    const manifest = structuredClone(job.publicManifest);
    if (m.wrongKey) manifest.binding.publicKey = (await import('near-api-js')).KeyPair.fromRandom('ed25519').getPublicKey().toString();
    const signer = await g.trustedSignerProvider({ ownerId: m.wrongOwner ? 'foreign.testnet' : job.ownerId, jobId: job.jobId, manifest, signal: controller.signal });
    const publicKey = (await signer.getPublicKey()).toString();
    process.send({ id: m.id, publicKey }); // Synthetic public key only; no signing.
  } catch { process.send({ id: m.id, error: 'SYNTHETIC_RESOLUTION_FAILED' }); }
});
`;
async function tree(t, policy = 'sealed') {
  assert.ok(isAbsolute(process.env.TMPDIR ?? ''), 'APPROVED_TMPDIR_REQUIRED');
  const dir = await mkdtemp(join(process.env.TMPDIR, 'haldir-production-auto-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = [...new Set([...requiredRuntimeSources, ...optionalRuntimeSources,
    'deployment/haldir-public/operational-entrypoint-fixture.mjs',
    'target/mandate-wasm/u01_mandate_proof.wasm', 'target/mandate-factory-wasm/u01_mandate_factory.wasm'])];
  for (const path of paths) {
    let bytes; try { bytes = await readFile(new URL(path, root)); } catch (e) {
      if (['src/server/trusted-public-manifest.mjs', 'deployment/haldir-public/trusted-manifest.mjs'].includes(path)) continue;
      throw e;
    }
    await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), bytes);
  }
  await symlink(new URL('node_modules', root), join(dir, 'node_modules'), 'dir');
  const pub = join(dir, 'deployment/haldir-public'); await mkdir(join(pub, 'ui/assets'), { recursive: true }); await mkdir(join(pub, 'ui/fonts'));
  await writeFile(join(pub, 'ui/index.html'), '<!doctype html>SYNTHETIC NOT UI QUALIFICATION');
  await writeFile(join(pub, 'ui-build-receipt.json'), JSON.stringify({ approvedOrigin: origin, viteApprovedOrigin: origin, publicMode: 'public-testnet' }));
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(r => server.close(r));
  const pair = KeyPair.fromRandom('ed25519');
  await writeFile(join(dir, 'fixture.json'), JSON.stringify({ root: dir, mode: policy==='compat'?'auto':'production', policy, port,
    ownerKey: pair.getPublicKey().toString(), sqlite: join(dir, 'db.sqlite'), checkpoint: join(dir, 'chain.json') }));
  await writeFile(join(dir, 'preload.mjs'), preloader);
  const entry = join(pub, 'main.mjs');
  const child = spawn(process.execPath, ['--import', join(dir, 'preload.mjs'), entry], {
    env: { ...env, PORT: String(port), HOME: dir, TMPDIR: process.env.TMPDIR }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '', exited = false;
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const exit = once(child, 'exit').then(v => { exited = true; return v; });
  t.after(async () => { if (!exited) child.kill('SIGTERM'); await exit; });
  let serial = 0;
  const command = body => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => reject(Error('IPC_TIMEOUT')), 5000);
    const listener = m => { if (m.id === id) { child.off('message', listener); clearTimeout(timer); m.error ? reject(Error(m.error)) : resolve(m); } };
    child.on('message', listener); child.send({ ...body, id });
  });
  return { child, pair, port, command, exit, entry, stdout: () => stdout, stderr: () => stderr,
    async ready() { const end = performance.now() + 10000; while (!stdout.includes('LISTENING')) {
      if (exited || performance.now() >= end) throw Error(stderr || 'NO_LISTEN'); await new Promise(r => setTimeout(r, 10));
    } },
    async stop(expectedWorkers = 0) { child.kill('SIGTERM'); assert.deepEqual(await exit, [0, null], stderr); const r = JSON.parse(stderr.match(/OPERATIONAL_RECEIPT (.+)/)[1]);
      assert.equal(r.pid, child.pid); assert.equal(r.ppid, process.pid); assert.equal(r.argv[1], entry);
      assert.equal(r.forbidden, 1); assert.equal(r.negativeControl, 1); assert.equal(r.drainedBeforeClose, true); assert.equal(r.workerConstructors, expectedWorkers);
      assert.equal(r.signs, 0); assert.equal(r.sends, 0); assert.deepEqual(r.inference, []); return r; } };
}
function call(port, path, body, headers = {}) { return new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { host: 'haldir.ldt.sh', origin,
    'x-haldir-csrf': '1', 'content-type': 'application/json', ...headers } }, res => {
    const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => {
      const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, body: JSON.parse(text), headers: res.headers });
    });
  }); req.on('error', reject); req.end(JSON.stringify(body));
}); }
async function login(h) {
  const challenge = await call(h.port, '/api/wallet-auth/challenge', { accountId: 'alice.testnet', networkId: 'testnet' });
  assert.equal(challenge.status, 200); const c = challenge.body;
  const verified = await call(h.port, '/api/wallet-auth/verify', { accountId: 'alice.testnet', networkId: 'testnet', challengeId: c.challengeId,
    publicKey: h.pair.getPublicKey().toString(), signature: Buffer.from(h.pair.sign(serializeMessageNep413({ ...c.payload,
      nonce: Buffer.from(c.payload.nonce, 'base64') })).signature).toString('base64') });
  assert.equal(verified.status, 200); return { cookie: verified.headers['set-cookie'][0].split(';')[0] };
}
test('production actual auto-entry constructs the default real graph and resolves only a job admitted after startup', async t => {
  const h = await tree(t); await h.ready();
  let snapshot = await h.command({ kind: 'snapshot' });
  assert.deepEqual(snapshot.rows.jobs, []);
  assert.equal(snapshot.c.graph.model, 'haldir.model.runner-recovery.v1');
  assert.equal(snapshot.c.graph.signer, 'function'); assert.equal(snapshot.c.graph.maxRunMs, 20000);
  assert.equal(snapshot.c.graph.capabilities.financialActions, true);
  assert.deepEqual(snapshot.c.secretReads, ['projects/147018706305/secrets/haldir-model-synthetic/versions/1']);
  const headers = await login(h);
  const created = await call(h.port, '/api/public/jobs', { approvalId: 'operational-approval', admissionKey: 'fresh-production-job' }, headers);
  assert.equal(created.status, 201, JSON.stringify(created));
  const jobId = created.body.job.jobId; assert.match(jobId, /^[a-f0-9-]{36}$/);
  const resolved = await h.command({ kind: 'resolve-admitted', jobId });
  snapshot = await h.command({ kind: 'snapshot' });
  assert.equal(resolved.publicKey, snapshot.approved.binding.publicKey);
  assert.equal(snapshot.rows.mandates[0].value.jobId, jobId);
  assert.deepEqual(snapshot.c.secretReads, ['projects/147018706305/secrets/haldir-model-synthetic/versions/1', 'projects/147018706305/secrets/haldir-agent-pay-synthetic/versions/1']);
  const receipt = await h.stop(); assert.equal(receipt.hooks.length, 1, 'only repository boundary is replaced, never composition/model/signer');
  t.diagnostic(JSON.stringify({ classification: 'SYNTHETIC_AUTOENTRY_NOT_LIVE', jobId, graph: receipt.graph,
    secretRoles: ['model', 'pay-only'], signs: receipt.signs, sends: receipt.sends, inference: receipt.inference.length }));
});

for (const policy of ['closed', 'expired']) test(`production ${policy} keeps activation closed and owner recovery mounted without credentials`, async t => {
  const h = await tree(t, policy); await h.ready(); const headers = await login(h);
  const config = await call(h.port, '/api/public/config', {}, headers);
  assert.equal(config.status, 200); assert.equal(config.body.financialActions, false);
  const state = await h.command({ kind: 'bootstrap-state' });
  assert.equal(state.c.graph.ownerRecovery, 'function'); assert.equal(state.c.graph.signer, 'undefined');
  assert.deepEqual(state.c.secretReads, []); assert.deepEqual(state.c.metadata, []);
  await h.stop();
});
test('production malformed fixed binding fails before repository, metadata, secrets and listen', async t => {
  const h = await tree(t, 'malformed');
  const end = performance.now() + 5000;
  while (!h.stderr().includes('PUBLIC_STARTUP_FAILED')) { assert.ok(performance.now() < end); await new Promise(r => setTimeout(r, 10)); }
  const { c } = await h.command({ kind: 'bootstrap-state' });
  assert.equal(c.opens, 0); assert.equal(c.readiness, 0); assert.deepEqual(c.secretReads, []); assert.deepEqual(c.metadata, []);
  assert.deepEqual(c.listens, []); assert.equal(c.constructors, 0); assert.equal(h.stdout(), '');
  h.child.kill('SIGKILL'); assert.deepEqual(await h.exit, [null, 'SIGKILL']);
});
test('production rejects wrong owner/public key before pay-secret access; mismatched material never yields a signer', async t => {
  const h = await tree(t, 'wrong-key'); await h.ready(); const headers = await login(h);
  const created = await call(h.port, '/api/public/jobs', { approvalId: 'operational-approval', admissionKey: 'key-negative' }, headers);
  assert.equal(created.status, 201); const jobId = created.body.job.jobId;
  for (const bad of [{wrongOwner:true}, {wrongKey:true}]) {
    await assert.rejects(h.command({ kind: 'resolve-admitted', jobId, ...bad }), /SYNTHETIC_RESOLUTION_FAILED/);
    assert.equal((await h.command({kind:'bootstrap-state'})).c.secretReads.length, 1);
  }
  await assert.rejects(h.command({kind:'resolve-admitted',jobId}), /SYNTHETIC_RESOLUTION_FAILED/);
  assert.equal((await h.command({kind:'bootstrap-state'})).c.secretReads.length, 2);
  await h.stop();
});

test('expiry of real model authority denies fresh inference without stranding existing owner stop/withdraw', async t => {
  const h = await tree(t); await h.ready(); const headers = await login(h);
  const created = await call(h.port, '/api/public/jobs', { approvalId: 'operational-approval', admissionKey: 'expiry-recovery' }, headers);
  assert.equal(created.status, 201); const jobId = created.body.job.jobId;
  await h.command({kind:'expire-ai'});
  assert.equal((await h.command({kind:'expired-plan',jobId})).result, 'MODEL_BLOCKED');
  // The pre-expiry authenticated session must expire normally: perform fresh real
  // challenge/verification instead of bypassing auth to manufacture recovery.
  const freshHeaders = await login(h);
  for (const action of ['stop','withdraw']) {
    const prepared = await call(h.port, `/api/public/jobs/${jobId}/owner/prepare`, {action}, freshHeaders);
    assert.equal(prepared.status, 200, JSON.stringify(prepared));
    assert.equal(prepared.body.operation.request.methodName, action);
    assert.equal(prepared.body.operation.status, 'AWAITING_WALLET');
  }
  const snapshot = await h.command({kind:'snapshot'});
  for (const key of ['modelReservations','modelGrants','modelReleaseSpend','nativeOperations']) assert.deepEqual(snapshot.rows[key], []);
  assert.equal(snapshot.c.secretReads.length, 1); await h.stop();
});

test('normal production model reaches installed SDK default worker behind a worker-local denied transport; no fixture completion or dependent finance', async t => {
  const h = await tree(t); await h.ready(); const headers = await login(h);
  const created = await call(h.port, '/api/public/jobs', {approvalId:'operational-approval',admissionKey:'sdk-default-denied'}, headers);
  assert.equal(created.status, 201); const jobId = created.body.job.jobId;
  assert.equal((await h.command({kind:'blocked-plan',jobId})).result, 'MODEL_BLOCKED');
  const first = await h.command({kind:'bootstrap-state'});
  assert.equal(first.c.workerConstructors, 1); assert.ok(first.worker?.forbidden > 0, 'actual SDK attempted only denied worker-local transport');
  assert.equal((await h.command({kind:'recover-plan',jobId})).result, 'MODEL_BLOCKED');
  const after = await h.command({kind:'bootstrap-state'}); assert.equal(after.c.workerConstructors, 1, 'cache-only recovery never resends');
  const snapshot = await h.command({kind:'snapshot'});
  assert.equal(snapshot.rows.modelReservations.length, 1);
  assert.equal(snapshot.rows.modelReservations[0].value.state, 'RESERVED_NO_AUTOMATIC_REFUND');
  assert.equal(snapshot.rows.modelGrants[0].value.calls, 1); assert.equal(snapshot.rows.modelReleaseSpend.length, 1);
  assert.deepEqual(snapshot.rows.nativeOperations, []); assert.equal(snapshot.c.secretReads.length, 1);
  await h.stop(1);
});

test('actual production signer abort during protected cleanup drains and never releases a finance capability', async t=>{
  const h=await tree(t,'abort-key'); await h.ready();const headers=await login(h);
  const created=await call(h.port,'/api/public/jobs',{approvalId:'operational-approval',admissionKey:'abort-key'},headers);
  assert.equal(created.status,201);
  await assert.rejects(h.command({kind:'resolve-admitted',jobId:created.body.job.jobId}),/SYNTHETIC_RESOLUTION_FAILED/);
  const {c}=await h.command({kind:'bootstrap-state'});assert.equal(c.secretDrains,1);assert.equal(c.secretReads.length,2);
  await h.stop();
});

test('authority expiring during startup credential resolution cannot enable finance', async t => {
  const h=await tree(t,'expires-during-secret'); await h.ready(); const {c}=await h.command({kind:'bootstrap-state'});
  assert.equal(c.graph.capabilities.financialActions,false); assert.equal(c.graph.ownerRecovery,'function');
  assert.equal(c.secretReads.length,1); await h.stop();
});

test('accepted auto-entry qualification harness remains compatible while package production policy stays closed', async t => {
  const h=await tree(t,'compat'); await h.ready(); const state=await h.command({kind:'bootstrap-state'});
  assert.equal(state.c.graph.model,'haldir.model.runner-recovery.v1'); assert.deepEqual(state.c.secretReads,[]); await h.stop();
});
