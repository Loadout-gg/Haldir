// Pure readback validation; no key generation, bootstrap signer or submission.
import { PublicKey, baseDecode, baseEncode } from 'near-api-js';
const U128_MAX = (1n << 128n) - 1n;
const named = s => typeof s === 'string' && s === s.trim() && s.length >= 2 && s.length <= 64 &&
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(s);
function validateManifest(m) {
  if (!m || m.network !== 'testnet' || !named(m.agent) || !named(m.mandate) || m.agent === m.mandate)
    throw new Error('KEY_MANIFEST');
  for (const value of [m.executionPublicKey, m.bootstrapPublicKey]) {
    if (typeof value !== 'string' || value.length > 200 || PublicKey.fromString(value).toString() !== value)
      throw new Error('KEY_MANIFEST');
  }
  if (m.executionPublicKey === m.bootstrapPublicKey || typeof m.allowance !== 'string' ||
      m.allowance.length > 39 || m.allowance !== m.allowance.trim() ||
      !/^[1-9][0-9]*$/.test(m.allowance) || BigInt(m.allowance) > U128_MAX)
    throw new Error('KEY_MANIFEST');
}
/** Validate an INITIAL activation snapshot, not a spent/partially exhausted allowance.
 * Caller must supply a complete FINAL list read for m.agent from a chain-id-verified
 * testnet provider. RPC key-list responses do not themselves identify account/network;
 * this pure validator cannot authenticate provenance, code hash or secret-store isolation.
 */
export function verifyRestrictedKeys(read, m) {
  validateManifest(m);
  if (!read || read.last_key != null || !Array.isArray(read.keys) || read.keys.length !== 1)
    throw new Error('KEY_SET');
  if (typeof read.block_hash !== 'string' || read.block_hash.length > 44 ||
      baseDecode(read.block_hash).length !== 32 || baseEncode(baseDecode(read.block_hash)) !== read.block_hash ||
      !Number.isSafeInteger(read.block_height) || read.block_height < 0) throw new Error('KEY_EVIDENCE');
  const k = read.keys[0], p = k?.access_key?.permission;
  const f = p && typeof p === 'object' && Object.keys(p).length === 1 &&
    Object.hasOwn(p, 'FunctionCall') && p.FunctionCall;
  if (k?.public_key !== m.executionPublicKey || k.public_key === m.bootstrapPublicKey || !f ||
      Object.keys(f).length !== 3 || !['receiver_id', 'method_names', 'allowance'].every(x => Object.hasOwn(f, x)) ||
      f.receiver_id !== m.mandate || !Array.isArray(f.method_names) ||
      f.method_names.length !== 1 || f.method_names[0] !== 'pay' ||
      typeof f.allowance !== 'string' || f.allowance !== m.allowance || BigInt(f.allowance) <= 0n)
    throw new Error('KEY_PERMISSION');
  return { block_hash: read.block_hash, block_height: read.block_height };
}
