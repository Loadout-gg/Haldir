import { readFile, writeFile, mkdir, lstat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute, parse, sep, posix } from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as equal } from 'node:util';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const demand = (ok, code) => { if (!ok) throw new Error(code); };
export const requiredRuntimeSources = Object.freeze([
  'deployment/haldir-public/server.mjs',
  'deployment/haldir-preview/firestore-repository.mjs',
  'deployment/haldir-preview/package.json', 'deployment/haldir-preview/package-lock.json',
  'src/server/wallet-auth-http.mjs', 'src/server/wallet-session.mjs', 'src/server/near-owner-keys.mjs',
  'src/server/public-journey.mjs', 'src/server/orders.mjs', 'src/server/near-mandate.mjs', 'src/server/near-receipts.mjs',
  'src/server/near-owner-operations.mjs',
  'src/agent/run-job.mjs', 'src/agent/model-provider.mjs', 'src/vendor/payment-proof.mjs', 'src/vendor/fixture.mjs',
  'qualification/native-wallet/request.mjs', 'src/shared/job-contract.mjs',
]);
// Optional files are never generated, auto-discovered or treated as qualification.
export const optionalRuntimeSources = Object.freeze([
  'deployment/haldir-public/package.json', 'deployment/haldir-public/package-lock.json',
  'src/server/near-manifest.mjs', 'deployment/haldir-testnet/manifest.mjs',
  'src/server/trusted-public-manifest.mjs', 'src/server/near-mandate-status.mjs',
  'deployment/haldir-public/trusted-manifest.mjs', 'deployment/haldir-public/trusted-composition.mjs',
  'deployment/haldir-public/main.mjs',
  'deployment/haldir-public/production-policy.mjs', 'deployment/haldir-public/production-binding.mjs',
  'deployment/haldir-public/protected-secrets.mjs',
  'deployment/haldir-public/agent-signer.mjs',
  'deployment/haldir-public/near-ai-policy.mjs', 'deployment/haldir-public/near-ai-worker.mjs',
  'deployment/haldir-public/near-ai-transport.mjs', 'deployment/haldir-public/near-ai-model.mjs',
  'deployment/haldir-public/near-ai-runner-port.mjs',
]);
const safeRelative = value => typeof value === 'string' && !isAbsolute(value) && value.split('/').every(part =>
  /^[A-Za-z0-9_-][A-Za-z0-9_.\[\]-]*$/.test(part) && !['node_modules', 'private', '__MACOSX'].includes(part) &&
  !/\.(?:test|spec)\./i.test(part));
async function plainFile(root, source) {
  demand(safeRelative(source), 'RUNTIME_SOURCE_INVALID');
  let current = root;
  for (const part of source.split('/')) {
    current = join(current, part);
    demand(!(await lstat(current)).isSymbolicLink(), 'RUNTIME_SOURCE_SYMLINK');
  }
  demand((await lstat(current)).isFile(), 'RUNTIME_SOURCE_INVALID');
  return readFile(current);
}

/** Finite local assembly only. No install, build, environment activation or deploy.
 * Caller supplies an explicit reviewed selection and input hashes after writer freeze.
 */
export async function packagePublicRuntime({ root = defaultRoot, outDir, approvedOrigin,
  sourceAllowlistPath = 'deployment/haldir-public/source-allowlist.json',
  uiReceiptPath = 'deployment/haldir-public/ui-build-receipt.json',
  uiDir = 'deployment/haldir-public/ui', testFixture = false } = {}) {
  root = resolve(root);
  let ancestor = parse(root).root;
  for (const part of root.slice(ancestor.length).split(sep)) {
    ancestor = join(ancestor, part);
    demand(!(await lstat(ancestor)).isSymbolicLink(), 'RUNTIME_SOURCE_SYMLINK');
  }
  demand(typeof outDir === 'string' && isAbsolute(outDir), 'RUNTIME_OUTPUT_INVALID');
  outDir = resolve(outDir);
  const parent = dirname(outDir);
  ancestor = parse(parent).root;
  for (const part of parent.slice(ancestor.length).split(sep)) {
    ancestor = join(ancestor, part);
    demand(!(await lstat(ancestor)).isSymbolicLink(), 'RUNTIME_OUTPUT_SYMLINK');
  }
  const inside = relative(root, outDir);
  demand(inside && (inside.startsWith('..' + sep) || isAbsolute(inside) ||
    /^deployment\/haldir-public\/(?:runtime(?:-[a-z0-9-]+)?|\.runtime-test-[a-z0-9-]+)$/.test(inside)), 'RUNTIME_OUTPUT_INVALID');
  let origin;
  try { origin = new URL(approvedOrigin); } catch { /* rejected below */ }
  demand(origin?.protocol === 'https:' && origin.origin === approvedOrigin && !origin.username && !origin.password, 'EXACT_HTTPS_ORIGIN_REQUIRED');
  const selectionBytes = await plainFile(root, sourceAllowlistPath);
  const selection = JSON.parse(selectionBytes);
  const uiBytes = await plainFile(root, uiReceiptPath), ui = JSON.parse(uiBytes);
  demand(ui.approvedOrigin === approvedOrigin && ui.viteApprovedOrigin === approvedOrigin, 'RUNTIME_ORIGIN_MISMATCH');
  demand(ui.publicMode === 'public-testnet', 'RUNTIME_PUBLIC_MODE_REQUIRED');
  if (ui.originClassification === 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE') demand(testFixture === true, 'RUNTIME_FIXTURE_FLAG_REQUIRED');
  demand(equal(ui.sourceInputs, selection.uiBuildInputs) && Object.hasOwn(ui.sourceInputs ?? {}, 'prototype/src/App.tsx'), 'RUNTIME_UI_SOURCE_DRIFT');
  for (const [path, hash] of Object.entries(ui.sourceInputs)) {
    demand(path.startsWith('prototype/') && safeRelative(path), 'RUNTIME_UI_SOURCE_INVALID');
    const bytes = await plainFile(root, path);
    demand(/^[a-f0-9]{64}$/.test(hash) && sha(bytes) === hash, `RUNTIME_UI_SOURCE_DRIFT: ${path}`);
    if (/\.(?:tsx?|jsx?|mjs)$/.test(path)) {
      const code = bytes.toString('utf8');
      const imports = [...code.matchAll(/^\s*(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s+)['"]([^'"\n]+)['"]/gm)].map(m => m[1]);
      imports.push(...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)].map(m => m[1]));
      for (const specifier of imports.filter(s => s.startsWith('.') || s.startsWith('@/'))) {
        const base = specifier.startsWith('@/') ? 'prototype/src/' + specifier.slice(2) :
          posix.normalize(posix.join(posix.dirname(path), specifier));
        const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'].map(suffix => base + suffix)];
        demand(candidates.some(candidate => Object.hasOwn(ui.sourceInputs, candidate)),
          `RUNTIME_UI_IMPORT_NOT_SELECTED: ${path} -> ${specifier}`);
      }
    }
  }
  const files = new Map();
  const packageSources = selection.runtimeSources.filter(source => /\/package(?:-lock)?\.json$/.test(source));
  demand(packageSources.length === 2 && ['preview', 'public'].some(kind =>
    ['package.json', 'package-lock.json'].every(name => packageSources.includes(`deployment/haldir-${kind}/${name}`))),
  'RUNTIME_PACKAGE_PAIR_INVALID');
  for (const source of selection.runtimeSources) {
    demand(requiredRuntimeSources.includes(source) || optionalRuntimeSources.includes(source), 'RUNTIME_SOURCE_INVALID');
    const target = /\/package(?:-lock)?\.json$/.test(source) ? source.split('/').at(-1) : source;
    demand(!files.has(target), 'RUNTIME_DUPLICATE_FILE');
    const bytes = await plainFile(root, source);
    demand(/^[a-f0-9]{64}$/.test(selection.runtimeInputHashes?.[source] ?? '') &&
      sha(bytes) === selection.runtimeInputHashes[source], `RUNTIME_SOURCE_DRIFT: ${source}`);
    files.set(target, bytes);
  }
  for (const required of requiredRuntimeSources.filter(source => !/\/package(?:-lock)?\.json$/.test(source)))
    demand(selection.runtimeSources.includes(required), `RUNTIME_REQUIRED_SOURCE_MISSING: ${required}`);
  // Fixed literal-import contract for this finite ESM source family, not a
  // general JS parser or substitute for executing the assembled release.
  let sdkSelected = false;
  for (const [path, bytes] of files) {
    if (!path.endsWith('.mjs')) continue;
    const code = bytes.toString('utf8');
    const imports = [...code.matchAll(/^\s*(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s+)['"]([^'"\n]+)['"]/gm)].map(m => m[1]);
    imports.push(...[...code.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)].map(m => m[1]));
    demand(!/\bimport\s*\((?!\s*['"])/.test(code), 'RUNTIME_COMPUTED_IMPORT_FORBIDDEN');
    // Worker entrypoints are not ESM imports. Check literal module URLs separately.
    demand(!/\bnew\s+URL\s*\((?!\s*['"])[^,]+,\s*import\.meta\.url/.test(code), 'RUNTIME_COMPUTED_MODULE_URL_FORBIDDEN');
    const moduleUrls = [...code.matchAll(/\bnew\s+URL\s*\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url\s*\)/g)].map(m => m[1]);
    for (const specifier of moduleUrls.filter(s => /\.mjs(?:[?#]|$)/.test(s))) {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      demand(specifier.startsWith('.') && files.has(target), `RUNTIME_WORKER_NOT_SELECTED: ${path} -> ${specifier}`);
    }
    for (const specifier of imports) {
      if (specifier === '@nearai/inference-sdk/node') sdkSelected = true;
      if (specifier.startsWith('.')) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        demand(files.has(target), `RUNTIME_IMPORT_NOT_SELECTED: ${path} -> ${specifier}`);
      } else demand(isBuiltin(specifier) || ['near-api-js', 'near-api-js/nep413', '@google-cloud/firestore', '@nearai/inference-sdk/node'].includes(specifier),
        `RUNTIME_IMPORT_FORBIDDEN: ${specifier}`);
    }
  }
  files.set('deployment/haldir-public/ui-build-receipt.json', uiBytes);
  for (const [path, hash] of Object.entries(ui.outputs)) {
    demand(safeRelative(path) && /^(?:index\.html|(?:assets|fonts)\/.+\.(?:js|css|png|svg|ico|woff2?|ttf|txt|pb))$/.test(path), 'RUNTIME_UI_PATH_INVALID');
    const bytes = await plainFile(root, uiDir + '/' + path);
    demand(/^[a-f0-9]{64}$/.test(hash) && sha(bytes) === hash, `RUNTIME_UI_DRIFT: ${path}`);
    files.set('deployment/haldir-public/ui/' + path, bytes);
  }
  demand(Object.hasOwn(ui.outputs, 'index.html') && Object.keys(ui.outputs).some(p => p.startsWith('assets/')) &&
    Object.keys(ui.outputs).some(p => p.startsWith('fonts/')), 'RUNTIME_UI_INCOMPLETE');
  const pkg = JSON.parse(files.get('package.json')), lock = JSON.parse(files.get('package-lock.json'));
  demand(pkg.engines.node === '26.13.1' && lock.packages[''].engines.node === '26.13.1' &&
    pkg.dependencies['@google-cloud/firestore'] === '9.4.1' && pkg.dependencies['near-api-js'] === '7.4.0' &&
    lock.packages['node_modules/@google-cloud/firestore']?.version === '9.4.1' &&
    lock.packages['node_modules/near-api-js']?.version === '7.4.0' &&
    equal(pkg.dependencies, lock.packages[''].dependencies), 'RUNTIME_LOCK_MISMATCH');
  if (sdkSelected || packageSources.includes('deployment/haldir-public/package.json')) {
    const entry = lock.packages['node_modules/@nearai/inference-sdk'];
    demand(pkg.dependencies['@nearai/inference-sdk'] === '0.3.0' && entry?.version === '0.3.0' &&
      entry.resolved === 'https://registry.npmjs.org/@nearai/inference-sdk/-/inference-sdk-0.3.0.tgz' &&
      entry.integrity === 'sha512-OzgOMPe50p9BZc9cJqI8YuHq0J+i5SQQM/Po4ZKhKnAOj6ThJ44fip6FcxNuZxV6eBSejI5spjSE0xOFa9YVrg==',
    'RUNTIME_SDK_LOCK_MISMATCH');
  }
  const entrypoint = files.has('deployment/haldir-public/main.mjs') ? 'node deployment/haldir-public/main.mjs' : null;
  // Preserve dependency identity/lock, but never leave the incumbent auth-only start.
  pkg.scripts = entrypoint ? { start: entrypoint } : {};
  files.set('package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'));
  await mkdir(outDir); // never overwrite an existing output, even an empty directory
  try {
    const hashes = {};
    for (const [path, bytes] of files) {
      const dest = join(outDir, path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, bytes, { flag: 'wx' }); hashes[path] = sha(bytes);
    }
    const receipt = { classification: testFixture ? 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE' : 'PREPARED_SOURCE_NOT_CLOUD_QUALIFIED',
      approvedOrigin, publicMode: 'public-testnet', localNode: process.versions.node, requiredCloudNode: '26.13.1',
      dependenciesInstalledInArtifact: false, entrypoint, fileCount: files.size,
      sourceAllowlistSha256: sha(selectionBytes), uiBuildReceiptSha256: sha(uiBytes), files: hashes };
    await writeFile(outDir + '-manifest.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return receipt;
  } catch (error) { await rm(outDir, { recursive: true, force: true }); throw error; }
}

async function cli() {
  const options = {}, names = { '--root': 'root', '--sources': 'sourceAllowlistPath',
    '--ui-receipt': 'uiReceiptPath', '--ui-dir': 'uiDir', '--out': 'outDir', '--approved-origin': 'approvedOrigin' };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--test-fixture') {
      demand(!Object.hasOwn(options, 'testFixture'), 'RUNTIME_ARGUMENT_INVALID'); options.testFixture = true;
    } else {
      const name = names[flag];
      demand(name && !Object.hasOwn(options, name) && args[i + 1] && !args[i + 1].startsWith('--'), 'RUNTIME_ARGUMENT_INVALID');
      options[name] = args[++i];
    }
  }
  demand(options.outDir && options.approvedOrigin, 'RUNTIME_ARGUMENT_INVALID');
  if (!isAbsolute(options.outDir)) {
    demand(/^(?:runtime(?:-[a-z0-9-]+)?|\.runtime-test-[a-z0-9-]+)$/.test(options.outDir), 'RUNTIME_OUTPUT_INVALID');
    options.outDir = join(options.root ?? defaultRoot, 'deployment/haldir-public', options.outDir);
  }
  console.log(JSON.stringify(await packagePublicRuntime(options)));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
