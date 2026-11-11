// Offline qualification adapter; no wallet, network, storage or issuance calls.
// Contract references (read against installed Meteor 3.24.1 / Agent SDK 0.8.0):
// https://docs.agentsonintents.com/integration/agent-api/signing-standards
// https://api.agentsonintents.com/openapi.json (Intent / SignedData)
// https://github.com/near/NEPs/blob/master/neps/nep-0413.md
// Meteor dist/index.d.ts: INearSignMessageParams, near::sign_message; its
// V1 makeRequest returns @near-js/crypto PublicKey + Buffer, NOT base64 text.
// Requires browser/Node WebCrypto SHA-256. This is not terms acceptance,
// full-access-key discovery, a wallet controller, replay storage or API acceptance.
// Account is pinned from generated.signer; the caller must trust that generated
// record and independently approve its account/key/preview before any wallet use.
import { PublicKey } from 'near-api-js';
import { serialize } from 'borsh';

// NEP-413, not a transaction: u32(2^31 + 413), string, [u8;32],
// string, Option<string>. Only used for local verification, not API payload rewriting.
const schema = { struct: {
  tag: 'u32', message: 'string', nonce: { array: { type: 'u8', len: 32 } },
  recipient: 'string', callbackUrl: { option: 'string' },
} };

function base64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function decodeBase64(value, size, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`Invalid ${label}.`);
  let bytes;
  try { bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
  catch { throw new Error(`Invalid ${label}.`); }
  if (bytes.length !== size || base64(bytes) !== value) throw new Error(`Invalid ${label}: expected canonical base64 of ${size} bytes.`);
  return bytes;
}
function ownerKey(value) {
  if (typeof value !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(value)) throw new Error('Invalid owner public key.');
  const key = PublicKey.fromString(value);
  if (key.toString() !== value) throw new Error('Invalid owner public key.');
  return key;
}
function unexpired(expiry, clock) {
  const time = clock();
  if (!Number.isFinite(time)) throw new Error('Invalid qualification clock.');
  if (!Number.isFinite(Date.parse(expiry))) throw new Error('Invalid intent expiry.');
  if (time >= Date.parse(expiry)) throw new Error('Intent expired.');
}
function returnedKey(value) {
  if (typeof value === 'string') return ownerKey(value).toString();
  // Meteor uses its own @near-js/crypto PublicKey class, not near-api-js's
  // PublicKey constructor identity. Inspect its sole Ed25519 variant, never toString.
  const data = value?.ed25519Key?.data;
  if (!value || (value.enum !== undefined && value.enum !== 'ed25519Key') ||
      (value.keyType !== undefined && value.keyType !== 0) ||
      value.secp256k1Key !== undefined || value.mlDsa65Key !== undefined ||
      (value.ed25519Key?.keyType !== undefined && value.ed25519Key.keyType !== 0) ||
      (!Array.isArray(data) && !(data instanceof Uint8Array)) || data.length !== 32 ||
      !Array.from(data).every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error('Invalid returned public key.');
  return new PublicKey({ keyType: 0, data: Uint8Array.from(data) }).toString();
}
export function prepareNep413(generated, expectedOwnerPublicKey, { clock = Date.now } = {}) {
  const key = ownerKey(expectedOwnerPublicKey);
  if (generated?.status !== 'PENDING_SIGNATURE') throw new Error('Intent must be pending signature.');
  unexpired(generated.expires_at, clock);
  if (generated.signer?.type !== 'near' || generated.signer.public_key !== expectedOwnerPublicKey) throw new Error('Intent signer key mismatch.');
  if (typeof generated.signer.account_id !== 'string' || !generated.signer.account_id) throw new Error('Invalid signer account.');
  if (generated.intent?.standard !== 'nep413') throw new Error('Unexpected signing standard.');
  const payload = generated.intent.payload;
  if (!payload || typeof payload.message !== 'string' || typeof payload.recipient !== 'string' || !payload.recipient ||
      Object.keys(payload).some(key => !['message', 'recipient', 'nonce', 'callbackUrl'].includes(key)) ||
      (Object.hasOwn(payload, 'callbackUrl') && typeof payload.callbackUrl !== 'string')) throw new Error('Invalid intent payload.');
  const messageParams = {
    message: payload.message, recipient: payload.recipient,
    nonce: decodeBase64(payload.nonce, 32, 'nonce'),
    ...(Object.hasOwn(payload, 'callbackUrl') ? { callbackUrl: payload.callbackUrl } : {}),
  };
  const request = { id: 'near::sign_message', input: {
    target: { blockchain: 'near', network: 'mainnet', accountId: generated.signer.account_id },
    messageParams,
  } };
  const original = JSON.stringify(generated);
  const originalRequest = JSON.stringify(request);
  const intent = structuredClone(generated.intent);
  const accountId = generated.signer.account_id;
  const expiry = generated.expires_at;
  const serialized = serialize(schema, { tag: 2147484061, ...messageParams });
  const check = () => {
    if (JSON.stringify(generated) !== original || JSON.stringify(request) !== originalRequest) throw new Error('Intent or signing request changed after preparation.');
    unexpired(expiry, clock);
  };
  return { request, async signedData(output) {
    check();
    if (!output || typeof output !== 'object') throw new Error('Invalid signature response.');
    if ('publicKey' in output && returnedKey(output.publicKey) !== expectedOwnerPublicKey) throw new Error('Returned public key mismatch.');
    if ('accountId' in output && output.accountId !== accountId) throw new Error('Returned account mismatch.');
    if (!(output.signature instanceof Uint8Array) || output.signature.length !== 64) throw new Error('Invalid signature bytes.');
    const signature = Uint8Array.from(output.signature);
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', serialized));
    check();
    if (!key.verify(digest, signature)) throw new Error('Signature does not match original payload.');
    return { ...structuredClone(intent), public_key: expectedOwnerPublicKey, signature: base64(signature) };
  } };
}
