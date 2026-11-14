import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, lstat, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
const here = new URL('./', import.meta.url);
const json = async path => JSON.parse(await readFile(new URL(path, here), 'utf8'));
const fixtureOrigin = 'https://preview-build-fixture.invalid';
function prepare(out, origin = fixtureOrigin, fixture = true) {
  return spawnSync(process.execPath, [new URL('prepare-runtime.mjs', here).pathname, '--out', out,
    ...(fixture ? ['--test-fixture'] : [])], { encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, HALDIR_APPROVED_ORIGIN: origin } });
}
test('runtime preparation copies exactly hashed runtime/UI bytes, relocates locked package to root and refuses reuse', async t => {
  const out = '.runtime-test-' + randomUUID();
  const directory = new URL(out + '/', here);
  t.after(async () => { await rm(directory, { recursive: true, force: true }); await rm(new URL(out + '-manifest.json', here), { force: true }); });
  const child = prepare(out);
  assert.equal(child.status, 0, child.stderr);
  const receipt = await json(out + '-manifest.json');
  assert.equal(receipt.approvedOrigin, fixtureOrigin);
  assert.equal(receipt.classification, 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE');
  const found = [];
  async function collect(dir, prefix = '') {
    for (const name of await readdir(dir)) {
      const path = new URL(name, dir), rel = prefix + name, stat = await lstat(path);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) await collect(new URL(name + '/', dir), rel + '/');
      else { found.push(rel); assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), receipt.files[rel], rel); }
    }
  }
  await collect(directory);
  assert.deepEqual(found.sort(), Object.keys(receipt.files).sort());
  const sources = await json('source-allowlist.json'), ui = await json('ui-build-receipt.json');
  const expected = [...sources.runtimeSources.map(p => p.endsWith('/package.json') ? 'package.json' :
    p.endsWith('/package-lock.json') ? 'package-lock.json' : p),
    'deployment/haldir-preview/ui-build-receipt.json',
    ...Object.keys(ui.outputs).map(p => 'deployment/haldir-preview/ui/' + p)];
  assert.deepEqual(found.sort(), expected.sort());
  assert.equal(receipt.fileCount, found.length);
  assert.ok(found.includes('deployment/haldir-preview/firestore-repository.mjs'));
  assert.equal(found.some(p => /(?:node_modules|\.hermes|private|fixtures|target|\.test\.)/.test(p)), false);
  assert.equal(prepare(out).status, 1, 'existing target must not be overwritten');
});
test('runtime preparation rejects origin drift, unlabelled fixture origin and unsafe target before staging', () => {
  for (const child of [prepare('.runtime-never', 'https://other.invalid'), prepare('.runtime-never', fixtureOrigin, false),
    prepare('../haldir-cloud'), prepare('node_modules')]) {
    assert.equal(child.status, 1);
    assert.match(child.stderr, /RUNTIME_(?:ORIGIN_MISMATCH|FIXTURE_FLAG_REQUIRED|OUTPUT_INVALID)/);
  }
});
test('finite runtime allowlist includes genuine Firestore adapter and locked minimal SDK package, never SQLite', async () => {
  const manifest = await json('source-allowlist.json');
  assert.deepEqual(manifest.runtimeSources, [
    'deployment/haldir-preview/main.mjs', 'deployment/haldir-preview/server.mjs',
    'deployment/haldir-preview/firestore-repository.mjs',
    'deployment/haldir-preview/package.json', 'deployment/haldir-preview/package-lock.json',
    'src/server/wallet-auth-http.mjs', 'src/server/wallet-session.mjs', 'src/server/near-owner-keys.mjs',
  ]);
  assert.deepEqual(manifest.missingRuntimeFiles, []);
  const pkg = await json('package.json'), lock = await json('package-lock.json');
  assert.deepEqual(pkg.dependencies, { 'near-api-js': '7.4.0', '@google-cloud/firestore': '9.4.1' });
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//, name);
    assert.match(entry.integrity, /^sha512-/, name);
  }
});
