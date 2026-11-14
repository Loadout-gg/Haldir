import { readFile, writeFile, mkdir, copyFile, symlink, lstat, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Single explicit public input configures both halves; never infer a provider URL.
const approvedOrigin = process.env.HALDIR_APPROVED_ORIGIN;
let origin;
try { origin = new URL(approvedOrigin); } catch { /* reject below */ }
if (origin?.protocol !== 'https:' || origin.origin !== approvedOrigin || origin.username || origin.password ||
    origin.hostname.includes('*') || (process.env.VITE_HALDIR_APPROVED_ORIGIN !== undefined &&
      process.env.VITE_HALDIR_APPROVED_ORIGIN !== approvedOrigin))
  throw new Error('EXPLICIT_MATCHED_HTTPS_ORIGIN_REQUIRED');
const here = dirname(fileURLToPath(import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(join(here, 'source-allowlist.json')));
const stage = join(here, '.ui-source');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// The only source copy operation is a finite, hash-bound allowlist. No repository upload/context.
await mkdir(stage); // refuse an existing stage, never remove another writer's files
try {
  for (const [name, hash] of Object.entries(manifest.uiBuildInputs)) {
    if (!/^prototype\/(?:src\/|public\/|(?:package(?:-lock)?\.json|index\.html|vite\.config\.ts|tsconfig\.(?:app|node)\.json)$)/.test(name)) throw new Error('SOURCE_NOT_ALLOWED');
    const source = join(root, name);
    if (!(await lstat(source)).isFile() || sha(await readFile(source)) !== hash) throw new Error(`SOURCE_DRIFT: ${name}`);
    const dest = join(stage, name.slice('prototype/'.length));
    await mkdir(dirname(dest), { recursive: true }); await copyFile(source, dest);
  }
  // Installed dependency reuse for local build ONLY. This symlink is never an image input.
  await symlink(join(root, 'prototype/node_modules'), join(stage, 'node_modules'), 'dir');
  function run(args) {
    const result = spawnSync(process.execPath, args, { cwd: stage, stdio: 'inherit', timeout: 120000,
      env: { PATH: process.env.PATH, HALDIR_APPROVED_ORIGIN: approvedOrigin,
        VITE_HALDIR_APPROVED_ORIGIN: approvedOrigin } });
    if (result.status !== 0) throw new Error(`LOCAL_BUILD_FAILED: ${result.status}`);
  }
  for (const project of ['tsconfig.app.json', 'tsconfig.node.json'])
    run([join(stage, 'node_modules/typescript/bin/tsc'), '-p', project, '--noEmit', '--incremental', 'false']);
  run([join(stage, 'node_modules/vite/bin/vite.js'), 'build', '--configLoader', 'native',
    '--outDir', join(here, 'ui'), '--emptyOutDir', '--sourcemap', 'false']);
  for (const [name, hash] of Object.entries(manifest.uiBuildInputs))
    if (sha(await readFile(join(root, name))) !== hash) throw new Error(`SOURCE_CHANGED_DURING_BUILD: ${name}`);
  const output = {};
  async function collect(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) await collect(join(dir, entry.name), rel + '/');
      else if (entry.isFile()) output[rel] = sha(await readFile(join(dir, entry.name)));
      else throw new Error('OUTPUT_SYMLINK_FORBIDDEN');
    }
  }
  await collect(join(here, 'ui'));
  await writeFile(join(here, 'ui-build-receipt.json'), JSON.stringify({
    classification: 'LOCAL_UI_BUILD_ONLY_NOT_HOSTED_LOGIN_READY', node: process.versions.node,
    approvedOrigin, viteApprovedOrigin: approvedOrigin,
    originClassification: origin.hostname.endsWith('.invalid') ? 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE' : 'EXPLICIT_OPERATOR_INPUT_NOT_HOSTED_QUALIFIED',
    sourceInputs: manifest.uiBuildInputs,
    installedDependenciesReused: true, sourceInputCount: Object.keys(manifest.uiBuildInputs).length,
    sourceUnchanged: true, outputs: output }, null, 2) + '\n');
  console.log('LOCAL_UI_BUILD_ONLY_NOT_HOSTED_LOGIN_READY');
} finally { await rm(stage, { recursive: true, force: true }); }
