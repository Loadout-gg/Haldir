import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { packagePublicRuntime } from './package-runtime.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const required = [
  'deployment/haldir-public/server.mjs',
  'deployment/haldir-preview/firestore-repository.mjs',
  'deployment/haldir-preview/package.json', 'deployment/haldir-preview/package-lock.json',
  'src/server/wallet-auth-http.mjs', 'src/server/wallet-session.mjs', 'src/server/near-owner-keys.mjs',
  'src/server/public-journey.mjs', 'src/server/orders.mjs', 'src/server/near-mandate.mjs', 'src/server/near-receipts.mjs',
  'src/server/near-owner-operations.mjs',
  'src/agent/run-job.mjs', 'src/agent/model-provider.mjs', 'src/vendor/payment-proof.mjs', 'src/vendor/fixture.mjs',
  'qualification/native-wallet/request.mjs',
  'src/shared/job-contract.mjs', // explicit TS1 closure; frozen historical receipts remain unchanged
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'haldir-public-package-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'source'), outDir = join(scratch, 'runtime');
  const runtimeInputHashes = {};
  async function put(path, bytes) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); }
  for (const source of required) {
    const bytes = await readFile(join(repositoryRoot, source));
    await put(source, bytes); runtimeInputHashes[source] = sha(bytes);
  }
  // SYNTHETIC UI source and output; never public build evidence.
  const app = "// SYNTHETIC fixture only\nif (mode === 'public-testnet') return 'SYNTHETIC';\n";
  await put('prototype/src/App.tsx', app);
  const uiBuildInputs = { 'prototype/src/App.tsx': sha(app) };
  const outputs = { 'index.html': '<!doctype html>SYNTHETIC PACKAGE FIXTURE', 'assets/synthetic.js': '/* SYNTHETIC */', 'fonts/synthetic.ttf': 'SYNTHETIC FONT' };
  for (const [path, bytes] of Object.entries(outputs)) await put('deployment/haldir-public/ui/' + path, bytes);
  const manifest = { runtimeSources: [...required], runtimeInputHashes, uiBuildInputs };
  const receipt = { approvedOrigin: 'https://haldir.example', viteApprovedOrigin: 'https://haldir.example',
    publicMode: 'public-testnet', originClassification: 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE',
    sourceInputs: uiBuildInputs, outputs: Object.fromEntries(Object.entries(outputs).map(([k,v]) => [k, sha(v)])) };
  const options = { root, outDir, approvedOrigin: receipt.approvedOrigin, testFixture: true,
    sourceAllowlistPath: 'deployment/haldir-public/source-allowlist.json', uiReceiptPath: 'deployment/haldir-public/ui-build-receipt.json', uiDir: 'deployment/haldir-public/ui' };
  async function save() { await put(options.sourceAllowlistPath, JSON.stringify(manifest)); await put(options.uiReceiptPath, JSON.stringify(receipt)); }
  await save();
  return { ...options, options, put, save, manifest, receipt };
}
async function files(root, prefix = '') {
  const result = [];
  for (const e of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? prefix + '/' + e.name : e.name;
    if (e.isDirectory()) result.push(...await files(root, path)); else result.push(path);
  }
  return result.sort();
}
test('finite successor package copies exact pinned real financial modules and explicit synthetic UI; no incumbent entrypoint or private tree', async t => {
  const f = await fixture(t);
  await f.put('private/owner.pem', 'SYNTHETIC EXCLUDED');
  await f.put('node_modules/secret/index.js', 'SYNTHETIC EXCLUDED');
  await f.put('prototype/src/assets/haldir/private.macasset', 'SYNTHETIC EXCLUDED');
  const receipt = await packagePublicRuntime(f.options);
  assert.equal(receipt.classification, 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE');
  assert.equal(receipt.entrypoint, null); assert.equal(receipt.dependenciesInstalledInArtifact, false);
  const expected = required.filter(p => !p.endsWith('/package.json') && !p.endsWith('/package-lock.json'));
  expected.push('package.json', 'package-lock.json', 'deployment/haldir-public/ui-build-receipt.json',
    'deployment/haldir-public/ui/index.html', 'deployment/haldir-public/ui/assets/synthetic.js', 'deployment/haldir-public/ui/fonts/synthetic.ttf');
  assert.deepEqual(await files(f.outDir), expected.sort());
  assert.equal(receipt.fileCount, expected.length);
  for (const [path, hash] of Object.entries(receipt.files)) assert.equal(sha(await readFile(join(f.outDir, path))), hash, path);
  const pkg = JSON.parse(await readFile(join(f.outDir, 'package.json')));
  assert.deepEqual(pkg.scripts, {}, 'no stale preview start or invented public bootstrap');
  assert.equal(pkg.engines.node, '26.13.1');
  for (const source of required.filter(p => p.startsWith('src/'))) assert.equal(sha(await readFile(join(f.outDir, source))), f.manifest.runtimeInputHashes[source]);
  const persisted = JSON.parse(await readFile(f.outDir + '-manifest.json'));
  assert.deepEqual(persisted, receipt);
});
test('UI source bytes must match the receipt and source selection, not merely each other’s stale hash maps', async t => {
  const f = await fixture(t);
  await f.put('prototype/src/App.tsx', '// SYNTHETIC changed while writer active');
  await assert.rejects(packagePublicRuntime(f.options), /RUNTIME_UI_SOURCE_DRIFT/);
  await assert.rejects(readFile(join(f.outDir, 'package.json')), { code: 'ENOENT' });
});
test('optional owner and trusted manifest/bootstrap are included only when explicitly selected, present and hash-verified', async t => {
  const f = await fixture(t);
  const owner = 'src/server/near-owner-operations.mjs';
  const trusted = 'deployment/haldir-public/trusted-manifest.mjs';
  const bootstrap = 'deployment/haldir-public/main.mjs';
  const nativeManifest = 'src/server/near-manifest.mjs', pins = 'deployment/haldir-testnet/manifest.mjs';
  for (const [path, bytes] of [[owner, await readFile(join(repositoryRoot, owner))],
    [nativeManifest, await readFile(join(repositoryRoot, nativeManifest))], [pins, await readFile(join(repositoryRoot, pins))],
    [trusted, '// SYNTHETIC TRUSTED-MANIFEST FIXTURE\nexport const manifests = [];\n'],
    [bootstrap, '// SYNTHETIC BOOTSTRAP FIXTURE — not a hosted entrypoint proof\nexport const synthetic = true;\n']]) {
    await f.put(path, bytes);
    if (!f.manifest.runtimeSources.includes(path)) f.manifest.runtimeSources.push(path);
    f.manifest.runtimeInputHashes[path] = sha(bytes);
  }
  await f.save();
  const receipt = await packagePublicRuntime(f.options);
  assert.equal(receipt.entrypoint, 'node deployment/haldir-public/main.mjs');
  assert.equal(JSON.parse(await readFile(join(f.outDir, 'package.json'))).scripts.start, receipt.entrypoint);
  for (const path of [owner, trusted, bootstrap]) assert.equal(sha(await readFile(join(f.outDir, path))), f.manifest.runtimeInputHashes[path]);
});
for (const [name, mutate, error] of [
  ['changed financial source', async f => f.put('src/server/public-journey.mjs', '// SYNTHETIC DRIFT'), /RUNTIME_SOURCE_DRIFT/],
  ['missing pin', async f => { delete f.manifest.runtimeInputHashes['src/server/orders.mjs']; }, /RUNTIME_SOURCE_DRIFT/],
  ['missing required module', async f => { f.manifest.runtimeSources = f.manifest.runtimeSources.filter(p => p !== 'src/agent/run-job.mjs'); }, /RUNTIME_REQUIRED_SOURCE_MISSING/],
  ['missing delivered owner module', async f => { f.manifest.runtimeSources = f.manifest.runtimeSources.filter(p => p !== 'src/server/near-owner-operations.mjs'); }, /RUNTIME_REQUIRED_SOURCE_MISSING/],
  ['duplicate source', async f => { f.manifest.runtimeSources.push('src/server/orders.mjs'); }, /RUNTIME_DUPLICATE_FILE/],
  ['private selection', async f => { f.manifest.runtimeSources.push('private/owner.pem'); }, /RUNTIME_SOURCE_INVALID/],
  ['installed dependency selection', async f => { f.manifest.runtimeSources.push('node_modules/near-api-js/index.js'); }, /RUNTIME_SOURCE_INVALID/],
  ['mac asset selection', async f => { f.manifest.runtimeSources.push('prototype/src/assets/haldir/private.macasset'); }, /RUNTIME_SOURCE_INVALID/],
  ['test selection', async f => { f.manifest.runtimeSources.push('deployment/haldir-public/server.test.mjs'); }, /RUNTIME_SOURCE_INVALID/],
  ['incumbent host selection', async f => { f.manifest.runtimeSources.push('deployment/haldir-preview/server.mjs'); }, /RUNTIME_SOURCE_INVALID/],
  ['optional file absent', async f => { f.manifest.runtimeSources.push('deployment/haldir-public/trusted-manifest.mjs'); f.manifest.runtimeInputHashes['deployment/haldir-public/trusted-manifest.mjs'] = '0'.repeat(64); }, /ENOENT/],
  ['optional file unpinned', async f => { const p = 'deployment/haldir-public/trusted-manifest.mjs'; await f.put(p, '// SYNTHETIC'); f.manifest.runtimeSources.push(p); }, /RUNTIME_SOURCE_DRIFT/],
  ['wrong UI origin', async f => { f.receipt.viteApprovedOrigin = 'https://evil.example'; }, /RUNTIME_ORIGIN_MISMATCH/],
  ['wrong public mode', async f => { f.receipt.publicMode = 'testnet'; }, /RUNTIME_PUBLIC_MODE_REQUIRED/],
  ['UI path traversal', async f => { f.receipt.outputs['assets/../private.txt'] = '0'.repeat(64); }, /RUNTIME_UI_PATH_INVALID/],
  ['UI private key path', async f => { f.receipt.outputs['assets/owner.pem'] = '0'.repeat(64); }, /RUNTIME_UI_PATH_INVALID/],
  ['changed UI bytes', async f => f.put('deployment/haldir-public/ui/assets/synthetic.js', 'CHANGED SYNTHETIC'), /RUNTIME_UI_DRIFT/],
]) test(`packager fail-closed characterization: ${name}`, async t => {
  const f = await fixture(t); await mutate(f); await f.save();
  await assert.rejects(packagePublicRuntime(f.options), error);
  await assert.rejects(readFile(join(f.outDir, 'package.json')), { code: 'ENOENT' });
});
test('fixture output cannot be relabeled deployable by omitting the explicit fixture flag; existing outputs never overwritten', async t => {
  const f = await fixture(t);
  await assert.rejects(packagePublicRuntime({ ...f.options, testFixture: false }), /RUNTIME_FIXTURE_FLAG_REQUIRED/);
  await mkdir(f.outDir); await writeFile(join(f.outDir, 'sentinel'), 'SYNTHETIC KEEP');
  await assert.rejects(packagePublicRuntime(f.options), { code: 'EEXIST' });
  assert.equal(await readFile(join(f.outDir, 'sentinel'), 'utf8'), 'SYNTHETIC KEEP');
});
test('packager rejects symlinked source-root ancestors rather than following a trusted-path alias', async t => {
  const f = await fixture(t), alias = join(dirname(f.root), 'alias');
  await symlink(dirname(f.root), alias);
  await assert.rejects(packagePublicRuntime({ ...f.options, root: join(alias, 'source') }), /RUNTIME_SOURCE_SYMLINK/);
});
test('packager CLI executes real finite assembly with explicit arguments, no environment activation', async t => {
  const f = await fixture(t);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./package-runtime.mjs', import.meta.url)),
    '--root', f.root, '--out', f.outDir, '--approved-origin', f.approvedOrigin, '--test-fixture'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: tmpdir() }, timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /"classification":"TEST_FIXTURE_ONLY_NOT_DEPLOYABLE"/);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result, JSON.parse(await readFile(f.outDir + '-manifest.json')));
});
test('literal local import closure must be present in the explicit hash selection, including future trusted bootstrap imports', async t => {
  const f = await fixture(t), source = 'deployment/haldir-public/server.mjs';
  const bytes = Buffer.concat([await readFile(join(f.root, source)), Buffer.from("\nimport './missing-trusted-adapter.mjs';\n")]);
  await f.put(source, bytes); f.manifest.runtimeInputHashes[source] = sha(bytes); await f.save();
  await assert.rejects(packagePublicRuntime(f.options), /RUNTIME_IMPORT_NOT_SELECTED/);
});
test('new App owner-approval import cannot disappear from the frozen UI input selection', async t => {
  const f = await fixture(t), path = 'prototype/src/App.tsx';
  const app = "// SYNTHETIC new UI dependency\nimport { resolveOwnerManifest } from '@/integration/owner-approval'\nif (mode === 'public-testnet') return 'SYNTHETIC';\n";
  await f.put(path, app); f.manifest.uiBuildInputs[path] = sha(app); await f.save();
  await assert.rejects(packagePublicRuntime(f.options), /RUNTIME_UI_IMPORT_NOT_SELECTED/);
  for (const [helper, source] of [
    ['prototype/src/integration/owner-approval.ts', "// SYNTHETIC source closure fixture\nimport { fixture } from './synthetic-wallet'\nexport const resolveOwnerManifest = fixture;\n"],
    ['prototype/src/integration/synthetic-wallet.ts', '// SYNTHETIC source closure fixture\nexport const fixture = null;\n'],
  ]) {
    await f.put(helper, source); f.manifest.uiBuildInputs[helper] = sha(source);
  }
  await f.save();
  assert.equal((await packagePublicRuntime(f.options)).classification, 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE');
});
test('output parent aliases cannot redirect assembly into a source/private tree', async t => {
  const f = await fixture(t), alias = join(dirname(f.root), 'out-alias');
  await symlink(f.root, alias);
  await assert.rejects(packagePublicRuntime({ ...f.options, outDir: join(alias, 'runtime') }), /RUNTIME_OUTPUT_SYMLINK/);
  await assert.rejects(readFile(join(f.root, 'runtime/package.json')), { code: 'ENOENT' });
});
