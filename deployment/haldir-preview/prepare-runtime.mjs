import { readFile, writeFile, mkdir, lstat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const demand = (ok, code) => { if (!ok) throw new Error(code); };
const args = process.argv.slice(2);
const fixture = args.at(-1) === '--test-fixture';
if (fixture) args.pop();
const name = args.length ? args[1] : 'runtime';
demand((args.length === 0 || args.length === 2 && args[0] === '--out') &&
  /^(?:runtime(?:-[a-z0-9-]+)?|\.runtime-test-[a-z0-9-]+|\.runtime-never)$/.test(name), 'RUNTIME_OUTPUT_INVALID');
const out = join(here, name);
const approvedOrigin = process.env.HALDIR_APPROVED_ORIGIN;
const manifest = JSON.parse(await readFile(join(here, 'source-allowlist.json')));
const uiBytes = await readFile(join(here, 'ui-build-receipt.json'));
const ui = JSON.parse(uiBytes);
demand(approvedOrigin && ui.approvedOrigin === approvedOrigin && ui.viteApprovedOrigin === approvedOrigin, 'RUNTIME_ORIGIN_MISMATCH');
if (ui.originClassification === 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE') demand(fixture, 'RUNTIME_FIXTURE_FLAG_REQUIRED');
demand(JSON.stringify(ui.sourceInputs) === JSON.stringify(manifest.uiBuildInputs), 'RUNTIME_UI_SOURCE_DRIFT');
const files = new Map();
async function load(source, target, expected) {
  demand(!files.has(target), 'RUNTIME_DUPLICATE_FILE');
  // Each component must be a real directory/file; never follow symlinked ancestors.
  let current = root;
  for (const part of source.split('/')) {
    demand(part && part !== '.' && part !== '..', 'RUNTIME_SOURCE_INVALID');
    current = join(current, part);
    demand(!(await lstat(current)).isSymbolicLink(), 'RUNTIME_SOURCE_SYMLINK');
  }
  demand((await lstat(current)).isFile(), 'RUNTIME_SOURCE_INVALID');
  const bytes = await readFile(current);
  demand(typeof expected === 'string' && sha(bytes) === expected, `RUNTIME_SOURCE_DRIFT: ${source}`);
  files.set(target, bytes);
}
for (const source of manifest.runtimeSources) {
  demand(/^(?:deployment\/haldir-preview\/(?:main\.mjs|server\.mjs|firestore-repository\.mjs|package(?:-lock)?\.json)|src\/server\/(?:wallet-auth-http|wallet-session|near-owner-keys)\.mjs)$/.test(source), 'RUNTIME_SOURCE_INVALID');
  const target = /\/package(?:-lock)?\.json$/.test(source) ? source.split('/').at(-1) : source;
  await load(source, target, manifest.runtimeInputHashes?.[source]);
}
// UI receipt is packaged because the startup contract checks its origin.
files.set('deployment/haldir-preview/ui-build-receipt.json', uiBytes);
for (const [relative, hash] of Object.entries(ui.outputs)) {
  demand(/^(?:index\.html|(?:assets|fonts)\/[A-Za-z0-9_.\[\]/-]+)$/.test(relative), 'RUNTIME_UI_PATH_INVALID');
  const path = 'deployment/haldir-preview/ui/' + relative;
  await load(path, path, hash);
}
// Explicit outputs only; never traverse/copy repo, fixtures or installed dependencies.
const pkg = JSON.parse(files.get('package.json')), lock = JSON.parse(files.get('package-lock.json'));
demand(pkg.engines.node === '26.13.1' && lock.packages[''].engines.node === '26.13.1' &&
  pkg.dependencies['@google-cloud/firestore'] === '9.4.1' && pkg.dependencies['near-api-js'] === '7.4.0' &&
  JSON.stringify(Object.entries(pkg.dependencies).sort()) === JSON.stringify(Object.entries(lock.packages[''].dependencies).sort()), 'RUNTIME_LOCK_MISMATCH');
await mkdir(out); // refuse overwrite, even an empty existing directory
try {
  const hashes = {};
  for (const [path, bytes] of files) {
    const dest = join(out, path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes, { flag: 'wx' });
    hashes[path] = sha(bytes);
  }
  const receipt = { classification: fixture ? 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE' : 'PREPARED_SOURCE_NOT_CLOUD_QUALIFIED',
    approvedOrigin, localNode: process.versions.node, requiredCloudNode: '26.13.1',
    dependenciesInstalledInArtifact: false, fileCount: files.size,
    start: 'node deployment/haldir-preview/main.mjs', install: 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund',
    sourceAllowlistSha256: sha(await readFile(join(here, 'source-allowlist.json'))), files: hashes };
  await writeFile(out + '-manifest.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ directory: out, manifest: out + '-manifest.json', ...receipt }));
} catch (error) { await rm(out, { recursive: true, force: true }); throw error; }

