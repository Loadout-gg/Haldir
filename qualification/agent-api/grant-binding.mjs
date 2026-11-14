// Offline semantic qualification ONLY; independently implemented, no demo code copied.
// Read-only evidence:
// - Official client demo HEAD 1286f26f75fa392ff7f0a66195714b3872d4c4df,
//   features/wallet/model/message-summary.ts:29,42,97-108,127-129,155-167.
//   These are CLIENT decoder observations, not a server revocation-message spec.
// - https://api.agentsonintents.com/openapi.json, retrieved 2026-11-11,
//   SHA256 ed4b542dbe14ac12b8549ad148d55c649976730169b55f8bce17c1bb966e4b65:
//   generate-intent grant_issue/grant_revoke requests; OwnerWallet; Intent;
//   GrantView.owner_message DOES specify the full v6 issuance envelope.
//   No corresponding owner-admin.v2 revocation-message schema was found there.
// No live generated messages or hosted acceptance have been exercised.
import { PublicKey } from 'near-api-js';

const ISSUE_DOMAIN = 'near-intents-agent-api.agent-grant.v6';
const ISSUE_METADATA = ['tenant_id', 'wallet_id', 'owner_epoch', 'nonce', 'issued_at_ms'];
const OWNER_FIELDS = ['type', 'account_id', 'public_key'];
function reject(reason) { throw new Error(`Grant binding rejected: ${reason}.`); }
function requireThat(condition, reason) { if (!condition) reject(reason); }
function record(value, label) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), `invalid ${label}`);
  requireThat(Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
  }), `non-data ${label}`);
  return value;
}
function fields(value, expected, label) {
  record(value, label);
  const keys = Object.keys(value);
  requireThat(keys.length === expected.length && expected.every(key => Object.hasOwn(value, key)), `unknown or missing ${label} fields`);
}
function text(value, min, max, label) {
  requireThat(typeof value === 'string' && value.length >= min && value.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value), `invalid ${label}`);
}
function hex64(value, label) { requireThat(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), `invalid ${label}`); }
function integer(value, minimum, label) { requireThat(Number.isSafeInteger(value) && value >= minimum, `invalid ${label}`); }
function account(value) {
  requireThat(typeof value === 'string' && value.length >= 2 && value.length <= 64 &&
    /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value), 'invalid NEAR account');
}
function key(value) {
  requireThat(typeof value === 'string' && /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value), 'invalid owner key');
  let parsed;
  try { parsed = PublicKey.fromString(value); } catch { reject('invalid owner key'); }
  requireThat(parsed.keyType === 0 && parsed.data.length === 32 && parsed.toString() === value, 'invalid owner key');
}
function owner(value) {
  fields(value, OWNER_FIELDS, 'owner');
  requireThat(value.type === 'near', 'only NEAR owners supported');
  account(value.account_id); key(value.public_key);
}
function sameOwner(actual, expected) {
  owner(actual);
  requireThat(OWNER_FIELDS.every(field => actual[field] === expected[field]), 'owner mismatch');
}
function timestamp(value, label) {
  // Deliberately narrower than OpenAPI fractional seconds: reject sub-ms precision,
  // offsets and invalid calendar dates, rather than rounding/repairing approved pins.
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value), `invalid ${label}`);
  const milliseconds = Date.parse(value);
  const expanded = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, digits) => `.${digits.padEnd(3, '0')}Z`) : value.replace(/Z$/, '.000Z');
  requireThat(Number.isSafeInteger(milliseconds) && milliseconds > 0 && new Date(milliseconds).toISOString() === expanded, `invalid ${label}`);
  return milliseconds;
}
function metadata(value) {
  text(value.tenant_id, 1, 64, 'tenant');
  text(value.wallet_id, 1, 256, 'wallet');
  integer(value.owner_epoch, 0, 'owner epoch');
  text(value.nonce, 16, 64, 'internal nonce');
  requireThat(value.nonce.trim() === value.nonce, 'noncanonical internal nonce');
  integer(value.issued_at_ms, 0, 'issued time');
}
function nep413Nonce(value) {
  requireThat(typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value), 'invalid NEP413 nonce');
  let decoded;
  try { decoded = atob(value); } catch { reject('invalid NEP413 nonce'); }
  requireThat(decoded.length === 32 && btoa(decoded) === value, 'noncanonical NEP413 nonce');
}

function parseMessage(raw) {
  // JSON.parse checks the complete grammar, but discards duplicate keys and can
  // round numeric values. Walk the original lexical tokens BEFORE trusting its
  // result. Decoded keys are tracked at every depth, including escaped spellings.
  let parsed;
  try { parsed = JSON.parse(raw); } catch { reject('invalid JSON message'); }
  const tokens = raw.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  let index = 0;
  function visit(depth) {
    requireThat(depth <= 32, 'JSON nesting limit');
    const token = tokens[index++];
    if (token === '{') {
      const seen = new Set();
      if (tokens[index] === '}') { index++; return; }
      do {
        const property = JSON.parse(tokens[index++]);
        requireThat(!seen.has(property), 'duplicate JSON key');
        seen.add(property);
        index++; // Colon; whole grammar already validated above.
        visit(depth + 1);
      } while (tokens[index++] === ',');
    } else if (token === '[') {
      if (tokens[index] === ']') { index++; return; }
      do { visit(depth + 1); } while (tokens[index++] === ',');
    } else if (token[0] !== '"' && !['true', 'false', 'null'].includes(token)) {
      // Every supported envelope numeric field is a nonnegative safe integer.
      // Reject decimal/exponent/-0 spellings rather than rounding signed bytes.
      requireThat(/^(?:0|[1-9]\d*)$/.test(token) && Number.isSafeInteger(Number(token)), 'ambiguous JSON number');
    }
  }
  visit(0);
  requireThat(index === tokens.length, 'invalid JSON token boundary');
  return parsed;
}

/**
 * Returns true or throws; NEVER rewrites, signs, saves or submits anything.
 * All three approval arguments must come from a SEPARATE approval/trust source,
 * never generated, generated.preview, or JSON.parse(generated.intent.payload.message).
 * trustedContext = { network:'mainnet', recipient,
 *   envelope: { tenant_id, wallet_id, owner_epoch? } }.
 * Only include owner_epoch if independently observed; otherwise the epoch is
 * a nonnegative safe integer, NOT independently established as the current epoch.
 * There is no assumed initial epoch and no pre-grant epoch-discovery mechanism here.
 * nonce, issued_at_ms and outer expires_at are authenticated response metadata,
 * not generation-request fields or independently preknown authorization pins.
 * The caller must obtain the response over an authenticated channel; this offline
 * semantic helper does NOT authenticate it or detect a fresh metadata substitution.
 * options.qualificationPolicy = { maxClockSkewMs, maxAgeMs, maxSigningWindowMs }
 * is REQUIRED, caller-selected LOCAL qualification policy, NOT provider defaults.
 * Each bound is a safe integer in milliseconds; skew >= 0, age/window > 0.
 * Accept issued time in [now-maxAgeMs, now+maxClockSkewMs], and an unexpired
 * outer deadline strictly after issued time, at most maxSigningWindowMs later.
 * No equality between this signing deadline and the approved grant lifetime.
 * A valid grant_revoke request fails UNSUPPORTED_REVOCATION_FORMAT: the demo recognizes
 * near-intents-agent-api.owner-admin.v2 / revoke_grant / target_id, but validating
 * that exact domain/action/target and the full server metadata/expiry semantics
 * remains future actual-schema-fixture work, NOT proven by a synthetic object.
 * approvedRequest is the exact OpenAPI generation request; owner includes type:'near'.
 * This is a synchronous check, not a durable authorization capability: retain immutable
 * approved pins and recheck the exact generated record before/after async approval.
 * Combine with prepareNep413 for byte snapshots and cryptographic verification.
 * Does not establish terms acceptance, key freshness, replay prevention, token custody,
 * current server format, provider enforcement, or any real-wallet/API success.
 */
export function assertGrantBinding(generated, approvedRequest, approvedOwner, trustedContext, { clock = Date.now, qualificationPolicy } = {}) {
  record(approvedRequest, 'approved request');
  requireThat(['grant_issue', 'grant_revoke'].includes(approvedRequest.type), 'unsupported approved request type');
  const issuance = approvedRequest.type === 'grant_issue';
  fields(approvedRequest, issuance ? ['type', 'agent_id', 'label', 'credential', 'expires_at'] : ['type', 'agent_id', 'grant_id'], 'approved grant request');
  hex64(approvedRequest.agent_id, 'approved agent');
  let grantExpiry;
  if (issuance) {
    hex64(approvedRequest.credential, 'approved commitment');
    requireThat(typeof approvedRequest.label === 'string' && /^[\x20-\x7e]{1,64}$/.test(approvedRequest.label), 'invalid approved label');
    grantExpiry = timestamp(approvedRequest.expires_at, 'approved grant expiry');
  } else {
    hex64(approvedRequest.grant_id, 'approved grant target');
    reject('UNSUPPORTED_REVOCATION_FORMAT');
  }
  owner(approvedOwner);
  fields(trustedContext, ['network', 'recipient', 'envelope'], 'trusted context');
  requireThat(trustedContext.network === 'mainnet', 'mainnet required');
  text(trustedContext.recipient, 1, 253, 'trusted recipient');
  const envelope = record(trustedContext.envelope, 'trusted envelope');
  fields(envelope, ['tenant_id', 'wallet_id', ...(Object.hasOwn(envelope, 'owner_epoch') ? ['owner_epoch'] : [])], 'trusted envelope');
  text(envelope.tenant_id, 1, 64, 'trusted tenant');
  text(envelope.wallet_id, 1, 256, 'trusted wallet');
  if (Object.hasOwn(envelope, 'owner_epoch')) integer(envelope.owner_epoch, 0, 'observed owner epoch');
  fields(qualificationPolicy, ['maxClockSkewMs', 'maxAgeMs', 'maxSigningWindowMs'], 'local qualification policy');
  integer(qualificationPolicy.maxClockSkewMs, 0, 'qualification policy clock skew');
  integer(qualificationPolicy.maxAgeMs, 1, 'qualification policy max age');
  integer(qualificationPolicy.maxSigningWindowMs, 1, 'qualification policy signing window');
  requireThat(typeof clock === 'function', 'invalid clock');
  const now = clock();
  integer(now, 0, 'clock');
  requireThat(now < grantExpiry, 'expired grant');

  fields(generated, ['correlation_id', 'type', 'agent_id', 'status', 'expires_at', 'signer', 'intent', 'preview'], 'generated response');
  requireThat(typeof generated.correlation_id === 'string' && /^intent_[A-Za-z0-9_-]{43}$/.test(generated.correlation_id), 'invalid correlation');
  requireThat(generated.type === approvedRequest.type && generated.agent_id === approvedRequest.agent_id, 'generated request mismatch');
  requireThat(generated.status === 'PENDING_SIGNATURE', 'intent not pending');
  const intentExpiry = timestamp(generated.expires_at, 'intent expiry');
  requireThat(now < intentExpiry, 'expired intent');
  sameOwner(generated.signer, approvedOwner);
  record(generated.preview, 'preview'); // Not an authorization source; contents unused.
  fields(generated.intent, ['standard', 'payload'], 'intent');
  requireThat(generated.intent.standard === 'nep413', 'unsupported standard');
  const payload = generated.intent.payload;
  fields(payload, ['message', 'recipient', 'nonce'], 'NEP413 payload');
  requireThat(payload.recipient === trustedContext.recipient, 'payload recipient mismatch');
  nep413Nonce(payload.nonce);
  requireThat(typeof payload.message === 'string' && payload.message.length <= 65536, 'invalid message');
  const message = parseMessage(payload.message);
  fields(message, ['domain', 'owner', 'agent_id', 'network', 'recipient', 'expires_at_ms', 'label', 'credential', ...ISSUE_METADATA], 'grant message');
  requireThat(message.domain === ISSUE_DOMAIN, 'unknown domain');
  sameOwner(message.owner, approvedOwner);
  requireThat(message.network === trustedContext.network && message.recipient === trustedContext.recipient, 'message context mismatch');
  requireThat(message.agent_id === approvedRequest.agent_id, 'agent mismatch');
  requireThat(message.label === approvedRequest.label && message.credential === approvedRequest.credential, 'grant request mismatch');
  integer(message.expires_at_ms, 1, 'message expiry');
  requireThat(message.expires_at_ms === grantExpiry, 'message expiry mismatch');
  metadata(message);
  requireThat(message.issued_at_ms - now <= qualificationPolicy.maxClockSkewMs, 'future issued time');
  requireThat(now - message.issued_at_ms <= qualificationPolicy.maxAgeMs, 'stale issued time');
  const signingWindow = intentExpiry - message.issued_at_ms;
  requireThat(signingWindow > 0 && signingWindow <= qualificationPolicy.maxSigningWindowMs, 'invalid signing window');
  requireThat(message.tenant_id === envelope.tenant_id && message.wallet_id === envelope.wallet_id, 'envelope context mismatch');
  if (Object.hasOwn(envelope, 'owner_epoch')) requireThat(message.owner_epoch === envelope.owner_epoch, 'observed owner epoch mismatch');
  return true;
}
