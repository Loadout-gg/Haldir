import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const here = new URL('./', import.meta.url);
const read = async path => JSON.parse(await readFile(new URL(path, here), 'utf8'));
test('UI builder requires explicit canonical HTTPS approval and rejects conflicting Vite input before writing', () => {
  for (const env of [{}, { HALDIR_APPROVED_ORIGIN: 'http://fixture.invalid' },
    { HALDIR_APPROVED_ORIGIN: 'https://fixture.invalid/' },
    { HALDIR_APPROVED_ORIGIN: 'https://*.invalid' },
    { HALDIR_APPROVED_ORIGIN: 'https://fixture.invalid', VITE_HALDIR_APPROVED_ORIGIN: 'https://other.invalid' }]) {
    const child = spawnSync(process.execPath, [new URL('build-local-ui.mjs', here).pathname], {
      encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, ...env } });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /EXPLICIT_MATCHED_HTTPS_ORIGIN_REQUIRED/);
  }
});
test('built UI receipt binds both origin inputs, every finite asset hash and the installed dynamic SDK chunk', async () => {
  const receipt = await read('ui-build-receipt.json');
  assert.equal(receipt.approvedOrigin, 'https://preview-build-fixture.invalid');
  assert.equal(receipt.viteApprovedOrigin, receipt.approvedOrigin);
  assert.equal(receipt.originClassification, 'TEST_FIXTURE_ONLY_NOT_DEPLOYABLE');
  assert.deepEqual(receipt.sourceInputs, (await read('source-allowlist.json')).uiBuildInputs);
  const names = Object.keys(receipt.outputs);
  assert.equal(names.filter(name => /^assets\/dist-.*\.js$/.test(name)).length, 1);
  const main = names.find(name => /^assets\/index-.*\.js$/.test(name));
  assert.ok((await readFile(new URL('ui/' + main, here), 'utf8')).includes(receipt.approvedOrigin));
  for (const [path, hash] of Object.entries(receipt.outputs))
    assert.equal(createHash('sha256').update(await readFile(new URL('ui/' + path, here))).digest('hex'), hash, path);
});
test('approved source snapshot includes current hosted client and preserves the existing SDK global fix', async () => {
  const manifest = await read('source-allowlist.json');
  for (const [name, hash] of Object.entries(manifest.uiBuildInputs)) {
    const path = new URL('../../' + name, here);
    assert.ok((await lstat(path)).isFile());
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hash, name);
  }
  assert.match(await readFile(new URL('../../prototype/vite.config.ts', here), 'utf8'), /global:\s*'globalThis'/);
});
