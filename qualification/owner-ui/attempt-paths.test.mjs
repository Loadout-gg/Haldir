import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerAttemptPaths } from './attempt-paths.mjs';
const root = new URL('file:///synthetic/u01/');

test('default selects the preserved legacy record', () => {
  const result = ownerAttemptPaths(root);
  assert.equal(result.generated.href,
    'file:///synthetic/u01/.hermes/proposals/owner-intent-generated.json');
  assert.equal(result.signature.href,
    'file:///synthetic/u01/.hermes/proposals/owner-signature.json');
});

test('attempt02 keeps proposal, response and signature in one directory', () => {
  const result = ownerAttemptPaths(root, 'owner-qualification-02');
  const prefix = 'file:///synthetic/u01/.hermes/proposals/attempts/owner-qualification-02/';
  assert.equal(result.generated.href, prefix + 'owner-intent-generated.json');
  assert.equal(result.approved.href, prefix + 'owner-qualification.json');
  assert.equal(result.signature.href, prefix + 'owner-signature.json');
});

test('arbitrary attempts and traversal are refused', () => {
  for (const value of ['', '../', 'owner-qualification-03', '__proto__',
    'constructor', '/tmp', 'file:///tmp', null, 2, {}]) {
    assert.throws(() => ownerAttemptPaths(root, value), /Unsupported owner/);
  }
});
