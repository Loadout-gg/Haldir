import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { packagePublicRuntime, requiredRuntimeSources, optionalRuntimeSources } from './package-runtime.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const sdk = '@nearai/inference-sdk';
const integrity = 'sha512-OzgOMPe50p9BZc9cJqI8YuHq0J+i5SQQM/Po4ZKhKnAOj6ThJ44fip6FcxNuZxV6eBSejI5spjSE0xOFa9YVrg==';
const publicPair = ['deployment/haldir-public/package.json', 'deployment/haldir-public/package-lock.json'];
const previewPair = ['deployment/haldir-preview/package.json', 'deployment/haldir-preview/package-lock.json'];
test('economics reader is an exact optional reviewed path, never discovered or generated', () => {
  assert.ok(optionalRuntimeSources.includes('src/server/near-mandate-status.mjs'));
  assert.equal(requiredRuntimeSources.includes('src/server/near-mandate-status.mjs'), false);
});
async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'haldir-ts1-packager-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'source'), outDir = join(scratch, 'runtime');
  const selection = { runtimeSources: [], runtimeInputHashes: {}, uiBuildInputs: {} };
  async function put(path, bytes, selected = true) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes);
    if (selected) { if (!selection.runtimeSources.includes(path)) selection.runtimeSources.push(path); selection.runtimeInputHashes[path] = sha(bytes); }
  }
  for (const path of requiredRuntimeSources) await put(path, await readFile(join(repo, path)));
  const app = '// SYNTHETIC UI ONLY'; await put('prototype/src/App.tsx', app, false);
  selection.uiBuildInputs = { 'prototype/src/App.tsx': sha(app) };
  const outputs = { 'index.html': 'SYNTHETIC', 'assets/synthetic.js': '// SYNTHETIC', 'fonts/synthetic.ttf': 'SYNTHETIC' };
  for (const [p,b] of Object.entries(outputs)) await put('deployment/haldir-public/ui/'+p,b,false);
  const receipt = { approvedOrigin: 'https://haldir.example', viteApprovedOrigin: 'https://haldir.example', publicMode: 'public-testnet',
    originClassification: 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE', sourceInputs: selection.uiBuildInputs,
    outputs: Object.fromEntries(Object.entries(outputs).map(([p,b])=>[p,sha(b)])) };
  async function save() { await put('deployment/haldir-public/selection.json', JSON.stringify(selection),false); await put('deployment/haldir-public/ui-receipt.json',JSON.stringify(receipt),false); }
  async function pair({ real = false } = {}) {
    selection.runtimeSources = selection.runtimeSources.filter(p=>!previewPair.includes(p));
    if (real) { for (const p of publicPair) await put(p,await readFile(join(repo,p))); return; }
    const pkg = JSON.parse(await readFile(join(root,previewPair[0]))), lock = JSON.parse(await readFile(join(root,previewPair[1])));
    pkg.dependencies[sdk]='0.3.0'; lock.packages[''].dependencies[sdk]='0.3.0';
    lock.packages['node_modules/'+sdk]={version:'0.3.0',resolved:'https://registry.npmjs.org/@nearai/inference-sdk/-/inference-sdk-0.3.0.tgz',integrity};
    await put(publicPair[0],JSON.stringify(pkg)); await put(publicPair[1],JSON.stringify(lock));
  }
  async function run() { await save(); return packagePublicRuntime({ root,outDir,approvedOrigin:receipt.approvedOrigin,testFixture:true,
    sourceAllowlistPath:'deployment/haldir-public/selection.json',uiReceiptPath:'deployment/haldir-public/ui-receipt.json' }); }
  return { root,outDir,selection,put,pair,run };
}
const additions = ['agent-signer', 'near-ai-policy', 'near-ai-worker', 'near-ai-transport', 'near-ai-model'].map(n=>'deployment/haldir-public/'+n+'.mjs');
test('finite signer and NEAR AI modules copy only with explicit reviewed hashes',async t=>{
  const f=await fixture(t);
  for(const p of additions) await f.put(p,'// SYNTHETIC finite packaging fixture, not production module\nexport const synthetic=true;');
  const result=await f.run();
  for(const p of additions) assert.equal(result.files[p],f.selection.runtimeInputHashes[p]);
});
test('runtime Worker new URL closure cannot disappear from reviewed selection',async t=>{
  const f=await fixture(t);
  for(const name of ['near-ai-policy','near-ai-transport']) { const p='deployment/haldir-public/'+name+'.mjs'; await f.put(p,await readFile(join(repo,p))); }
  await assert.rejects(f.run(),/RUNTIME_WORKER_NOT_SELECTED/);
});
test('selected runtime worker URL is copied and hash-bound',async t=>{
  const f=await fixture(t);
  for(const name of ['near-ai-policy','near-ai-transport']) { const p='deployment/haldir-public/'+name+'.mjs'; await f.put(p,await readFile(join(repo,p))); }
  const worker='deployment/haldir-public/near-ai-worker.mjs'; await f.put(worker,'// SYNTHETIC lifecycle-only worker fixture\nexport const synthetic=true;');
  assert.equal((await f.run()).files[worker],f.selection.runtimeInputHashes[worker]);
});
async function sdkWorker(f) {
  for(const name of ['near-ai-policy','near-ai-worker']) { const p='deployment/haldir-public/'+name+'.mjs'; await f.put(p,await readFile(join(repo,p))); }
}
test('official SDK node subpath is allowed with exact pinned dependency and lock integrity',async t=>{
  const f=await fixture(t); await f.pair(); await sdkWorker(f);
  const receipt=await f.run(); assert.ok(receipt.files['deployment/haldir-public/near-ai-worker.mjs']);
});
for(const mode of ['missing-dependency','wrong-version','missing-lock','wrong-integrity','wrong-registry','wrong-installed-version']) test('SDK selection rejects '+mode,async t=>{
  const f=await fixture(t); await f.pair(); await sdkWorker(f);
  const pkg=JSON.parse(await readFile(join(f.root,publicPair[0]))),lock=JSON.parse(await readFile(join(f.root,publicPair[1])));
  if(mode==='missing-dependency') { delete pkg.dependencies[sdk]; delete lock.packages[''].dependencies[sdk]; }
  if(mode==='wrong-version') { pkg.dependencies[sdk]='^0.3.0'; lock.packages[''].dependencies[sdk]='^0.3.0'; }
  if(mode==='missing-lock') delete lock.packages['node_modules/'+sdk];
  if(mode==='wrong-integrity') lock.packages['node_modules/'+sdk].integrity='sha512-SYNTHETIC';
  if(mode==='wrong-registry') lock.packages['node_modules/'+sdk].resolved='https://evil.example/sdk.tgz';
  if(mode==='wrong-installed-version') lock.packages['node_modules/'+sdk].version='0.3.1';
  await f.put(publicPair[0],JSON.stringify(pkg)); await f.put(publicPair[1],JSON.stringify(lock));
  await assert.rejects(f.run(),/RUNTIME_SDK_LOCK_MISMATCH/);
});
test('real SDK worker cannot select incumbent pair without SDK dependency',async t=>{
  const f=await fixture(t); await sdkWorker(f); await assert.rejects(f.run(),/RUNTIME_SDK_LOCK_MISMATCH/);
});
for(const specifier of ['@nearai/inference-sdk','@nearai/inference-sdk/browser','@nearai/inference-sdk/node/extra','unapproved-sdk']) test('SDK external rejects '+specifier,async t=>{
  const f=await fixture(t); await f.pair(); await f.put('deployment/haldir-public/near-ai-worker.mjs',`import '${specifier}';\n`);
  await assert.rejects(f.run(),/RUNTIME_IMPORT_FORBIDDEN/);
});
test('exact public package pair assembles TS1 backend, real signer and SDK workers with a finite model fixture and SYNTHETIC UI',async t=>{
  const f=await fixture(t); await f.pair({real:true});
  for(const p of additions) await f.put(p,p.endsWith('/near-ai-model.mjs')
    ? '// SYNTHETIC finite model fixture ONLY; active production writer is not frozen\nexport const synthetic=true;'
    : await readFile(join(repo,p)));
  const receipt=await f.run();
  assert.equal(receipt.classification,'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE');
  assert.equal(receipt.files['package-lock.json'],sha(await readFile(join(repo,publicPair[1]))));
  assert.equal(receipt.entrypoint,null); assert.equal(receipt.dependenciesInstalledInArtifact,false);
});
test('missing TS1 helper is rejected explicitly, even when current backend imports it',async t=>{
  const f=await fixture(t); f.selection.runtimeSources=f.selection.runtimeSources.filter(p=>p!=='src/shared/job-contract.mjs');
  await assert.rejects(f.run(),/RUNTIME_REQUIRED_SOURCE_MISSING: src\/shared\/job-contract.mjs/);
});
for(const [name,mutate,error] of [
  ['computed worker URL',async f=>f.put('deployment/haldir-public/near-ai-transport.mjs',"const p='./near-ai-worker.mjs'; const worker = new URL(p, import.meta.url);"),/RUNTIME_COMPUTED_MODULE_URL_FORBIDDEN/],
  ['unselected query worker URL',async f=>f.put('deployment/haldir-public/near-ai-transport.mjs',"const worker = new URL('./near-ai-worker.mjs?fixture', import.meta.url);"),/RUNTIME_WORKER_NOT_SELECTED/],
]) test('module URL rejects '+name,async t=>{ const f=await fixture(t); await mutate(f); await assert.rejects(f.run(),error); });
for(const name of ['near-api-js','@google-cloud/firestore']) test('public package lock rejects wrong installed '+name,async t=>{
  const f=await fixture(t); await f.pair(); const lock=JSON.parse(await readFile(join(f.root,publicPair[1])));
  lock.packages['node_modules/'+name].version='0.0.0'; await f.put(publicPair[1],JSON.stringify(lock));
  await assert.rejects(f.run(),/RUNTIME_LOCK_MISMATCH/);
});
test('public package cannot omit SDK even without SDK source selected',async t=>{
  const f=await fixture(t); await f.pair(); const pkg=JSON.parse(await readFile(join(f.root,publicPair[0]))),lock=JSON.parse(await readFile(join(f.root,publicPair[1])));
  delete pkg.dependencies[sdk]; delete lock.packages[''].dependencies[sdk];
  await f.put(publicPair[0],JSON.stringify(pkg)); await f.put(publicPair[1],JSON.stringify(lock));
  await assert.rejects(f.run(),/RUNTIME_SDK_LOCK_MISMATCH/);
});
test('public complete pinned package pair is an explicit alternative, not an extra preview requirement', async t=>{
  const f=await fixture(t); await f.pair(); assert.equal((await f.run()).classification,'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE');
});
for (const mode of ['mixed','both','missing','duplicate']) test('package pair rejects '+mode,async t=>{
  const f=await fixture(t); await f.pair();
  if(mode==='mixed') { f.selection.runtimeSources=f.selection.runtimeSources.filter(p=>p!==publicPair[1]); f.selection.runtimeSources.push(previewPair[1]); }
  if(mode==='both') f.selection.runtimeSources.push(...previewPair);
  if(mode==='missing') f.selection.runtimeSources=f.selection.runtimeSources.filter(p=>p!==publicPair[1]);
  if(mode==='duplicate') f.selection.runtimeSources.push(publicPair[0]);
  await assert.rejects(f.run(),/RUNTIME_PACKAGE_PAIR_INVALID|RUNTIME_DUPLICATE_FILE/);
});

test('reviewed cache-only runner port assembles with the real finite AI source closure', async t => {
  const f = await fixture(t); await f.pair({ real: true });
  const recovery = 'deployment/haldir-public/near-ai-runner-port.mjs';
  for (const p of [...additions, recovery]) await f.put(p, await readFile(join(repo, p)));
  const receipt = await f.run();
  assert.equal(receipt.classification, 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE');
  assert.equal(receipt.files[recovery], f.selection.runtimeInputHashes[recovery]);
  assert.equal(receipt.files['deployment/haldir-public/near-ai-model.mjs'], f.selection.runtimeInputHashes['deployment/haldir-public/near-ai-model.mjs']);
  assert.equal(receipt.entrypoint, null, 'packaging a port does not activate a runtime');
});
