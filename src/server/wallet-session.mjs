import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PublicKey } from 'near-api-js';
import { verifyMessage } from 'near-api-js/nep413';

export class WalletSessionError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireValue = (condition, code) => { if (!condition) throw new WalletSessionError(code); };
const account = s => typeof s === 'string' && s.length >= 2 && s.length <= 64 &&
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(s);
const opaque = s => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s) &&
  Buffer.from(s, 'base64url').toString('base64url') === s;
const notice = 'Session authentication only; does not authorize create/pay/stop/withdraw.';

/**
 * Authentication ONLY: never authorizes create/pay/stop/withdraw or a grant.
 * No HTTP, wallet prompt, signer, RPC client, financial operation or JWT.
 *
 * Trusted composition inputs (never browser-supplied): approvedOrigin (exact
 * HTTPS origin, no normalization), approvedRecipient, repository, clock, random,
 * trustedAccessKeyReader({ networkId, accountId, publicKey }). Reader must obtain
 * CURRENT final testnet chain membership and return that exact tuple plus
 * { permission, finality: 'final', blockHeight, blockHash, observedAt: epochMs }.
 * Null/throw/stale/mismatched evidence fails closed. A declared key, an implicit
 * address derivation or a FunctionCall permission is NOT ownership evidence.
 * Provenance/chain identity cannot be inferred from the returned fields alone;
 * authenticating the reader's chain/source is the trusted composition boundary.
 *
 * Repository port is orders.mjs runTransaction, get/create/set, reads first.
 * Callbacks may retry: all clocks/random/chain reads remain outside callbacks.
 * Commit and then expiry/freshness-fence before releasing a bearer token. A
 * queue crossing expiry can consume a challenge without returning its token;
 * start a new challenge rather than replaying an uncertain committed attempt.
 * Production random must be cryptographically secure; clock must be trusted.
 * Wire payload.nonce is canonical base64; decode to 32 bytes for NEP-413 signing.
 */
export function createWalletSessions({ repository, approvedOrigin, approvedRecipient,
  now = Date.now, random = randomBytes, challengeTtlMs = 120_000,
  sessionTtlMs = 900_000, keyMaxAgeMs = 30_000, trustedAccessKeyReader } = {}) {
  const bounded = (v, max) => Number.isSafeInteger(v) && v > 0 && v <= max;
  let url;
  try { url = new URL(approvedOrigin); } catch { /* fail closed below */ }
  requireValue(url?.protocol === 'https:' && url.origin === approvedOrigin &&
    typeof approvedRecipient === 'string' && /^[\x21-\x7e]{1,253}$/.test(approvedRecipient) &&
    typeof repository?.runTransaction === 'function' && typeof trustedAccessKeyReader === 'function' &&
    typeof now === 'function' && typeof random === 'function' && bounded(challengeTtlMs, 300_000) &&
    bounded(sessionTtlMs, 3_600_000) && bounded(keyMaxAgeMs, 30_000), 'INVALID_CONFIG');
  function time() {
    const value = now();
    requireValue(Number.isSafeInteger(value) && value >= 0, 'INVALID_CLOCK');
    return value;
  }
  function bytes() {
    const value = random(32);
    requireValue(value instanceof Uint8Array && value.length === 32, 'INVALID_RANDOM');
    return Buffer.from(value);
  }
  function context(input) {
    requireValue(input?.origin === approvedOrigin && input?.networkId === 'testnet' &&
      account(input?.accountId), 'INVALID_CONTEXT');
  }
  function challengeAvailable(record, input, observedAt) {
    const c = record?.challenge;
    requireValue(c && record.consumedAt === null && c.challengeId === input.challengeId &&
      c.origin === approvedOrigin && c.payload.recipient === approvedRecipient &&
      c.networkId === 'testnet' && c.accountId === input.accountId, 'CHALLENGE_UNAVAILABLE');
    requireValue(observedAt >= c.issuedAt && observedAt < c.expiresAt, 'CHALLENGE_EXPIRED');
    return c;
  }
  function evidenceValid(e, subject, observedAt) {
    requireValue(e && e.networkId === 'testnet' && e.accountId === subject.accountId &&
      e.publicKey === subject.publicKey && e.permission === 'FullAccess' &&
      e.finality === 'final' && Number.isSafeInteger(e.blockHeight) && e.blockHeight > 0 &&
      typeof e.blockHash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(e.blockHash) &&
      Number.isSafeInteger(e.observedAt) && e.observedAt <= observedAt &&
      observedAt - e.observedAt <= keyMaxAgeMs, 'OWNERSHIP_UNVERIFIED');
  }
  async function ownership(subject) {
    let evidence;
    try { evidence = structuredClone(await trustedAccessKeyReader({ networkId: 'testnet',
      accountId: subject.accountId, publicKey: subject.publicKey })); }
    catch { throw new WalletSessionError('OWNERSHIP_UNVERIFIED'); }
    evidenceValid(evidence, subject, time());
    return evidence;
  }
  function principal(s) {
    return { sessionId: s.sessionId, accountId: s.accountId, publicKey: s.publicKey,
      networkId: s.networkId, origin: s.origin, recipient: s.recipient,
      expiresAt: s.expiresAt, authenticationOnly: true };
  }
  function tokenHash(input) {
    requireValue(input?.origin === approvedOrigin && input?.networkId === 'testnet' &&
      opaque(input?.token), 'UNAUTHENTICATED');
    return createHash('sha256').update(input.token, 'ascii').digest('hex');
  }
  function validSession(s, hash, observedAt) {
    requireValue(s && typeof s.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(s.tokenHash) &&
      timingSafeEqual(Buffer.from(s.tokenHash, 'hex'), Buffer.from(hash, 'hex')) &&
      s.sessionId === hash && s.origin === approvedOrigin && s.recipient === approvedRecipient &&
      s.networkId === 'testnet' && s.revokedAt === null &&
      observedAt >= s.issuedAt && observedAt < s.expiresAt, 'UNAUTHENTICATED');
    return s;
  }
  async function revoke(sessionId, expectedHash) {
    if (typeof sessionId !== 'string' || !/^[a-f0-9]{64}$/.test(sessionId)) return false;
    const revokedAt = time();
    return repository.runTransaction(async tx => {
      const s = await tx.get('walletSessions', sessionId);
      if (!s || s.revokedAt !== null || s.origin !== approvedOrigin ||
        s.recipient !== approvedRecipient || s.networkId !== 'testnet') return false;
      if (expectedHash) {
        try { validSession(s, expectedHash, revokedAt); } catch { return false; }
      }
      tx.set('walletSessions', sessionId, { ...s, revokedAt });
      return true;
    });
  }
  return {
    async authenticate(input) {
      const hash = tokenHash(input);
      const s = validSession(await repository.runTransaction(tx => tx.get('walletSessions', hash)), hash, time());
      // Fail closed on deleted/downgraded keys and unavailable trusted chain reads.
      let evidence;
      try { evidence = await ownership(s); }
      catch { throw new WalletSessionError('UNAUTHENTICATED'); }
      const observedAt = time();
      const latest = await repository.runTransaction(async tx => {
        const current = validSession(await tx.get('walletSessions', hash), hash, observedAt);
        requireValue(isDeepStrictEqual(current, s), 'UNAUTHENTICATED');
        return current;
      });
      validSession(latest, hash, time());
      try { evidenceValid(evidence, latest, time()); }
      catch { throw new WalletSessionError('UNAUTHENTICATED'); }
      return principal(latest);
    },
    async logout(input) {
      let hash;
      try { hash = tokenHash(input); } catch { return false; }
      return revoke(hash, hash);
    },
    // Trusted server-only operation. Do not expose as an unauthenticated route.
    revokeSession({ sessionId } = {}) { return revoke(sessionId); },
    async verifyChallenge(input) {
      const proof = structuredClone(input);
      context(proof);
      requireValue(opaque(proof.challengeId) && typeof proof.publicKey === 'string' &&
        /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(proof.publicKey) &&
        typeof proof.signature === 'string' && proof.signature.length === 88, 'INVALID_PROOF');
      let publicKey;
      try { publicKey = PublicKey.fromString(proof.publicKey); }
      catch { throw new WalletSessionError('INVALID_PROOF'); }
      requireValue(publicKey.toString() === proof.publicKey && publicKey.keyType === 0, 'INVALID_PROOF');
      const signature = Buffer.from(proof.signature, 'base64');
      requireValue(signature.length === 64 && signature.toString('base64') === proof.signature, 'INVALID_PROOF');
      const record = await repository.runTransaction(tx => tx.get('walletChallenges', proof.challengeId));
      const c = challengeAvailable(record, proof, time());
      const evidence = await ownership(proof);
      try {
        // Reuse SDK's exact tagged Borsh/SHA-256 and FullAccess verification.
        // The provider facade cannot make network calls or accept a client key claim.
        await verifyMessage({ signerAccountId: c.accountId, signerPublicKey: publicKey,
          payload: { ...c.payload, nonce: Buffer.from(c.payload.nonce, 'base64') }, signature,
          provider: { viewAccessKey: async () => ({ permission: evidence.permission }) } });
      } catch { throw new WalletSessionError('INVALID_SIGNATURE'); }
      const issuedAt = time();
      challengeAvailable(record, proof, issuedAt);
      evidenceValid(evidence, proof, issuedAt);
      const token = bytes().toString('base64url');
      const tokenHash = createHash('sha256').update(token, 'ascii').digest('hex');
      const session = { sessionId: tokenHash, tokenHash, accountId: c.accountId,
        networkId: 'testnet', origin: approvedOrigin, recipient: approvedRecipient,
        publicKey: proof.publicKey, issuedAt, expiresAt: issuedAt + sessionTtlMs, revokedAt: null };
      await repository.runTransaction(async tx => {
        const latest = await tx.get('walletChallenges', c.challengeId);
        const collision = await tx.get('walletSessions', tokenHash);
        challengeAvailable(latest, proof, issuedAt);
        requireValue(isDeepStrictEqual(latest, record), 'CHALLENGE_UNAVAILABLE');
        requireValue(!collision, 'TOKEN_COLLISION');
        tx.set('walletChallenges', c.challengeId, { ...latest, consumedAt: issuedAt });
        tx.create('walletSessions', tokenHash, session);
      });
      // A queued/retried transaction may cross expiry. Never release its token.
      challengeAvailable(record, proof, time());
      evidenceValid(evidence, proof, time());
      requireValue(time() < session.expiresAt, 'SESSION_EXPIRED');
      return { token, expiresAt: session.expiresAt, principal: principal(session) };
    },
    async issueChallenge(input) {
      context(input);
      const issuedAt = time();
      const challengeId = bytes().toString('base64url');
      const expiresAt = issuedAt + challengeTtlMs;
      const challenge = { challengeId, origin: approvedOrigin, networkId: 'testnet',
        accountId: input.accountId, issuedAt, expiresAt,
        payload: { message: JSON.stringify({ type: 'haldir.wallet-login.v1', origin: approvedOrigin,
          recipient: approvedRecipient, networkId: 'testnet', accountId: input.accountId,
          challengeId, issuedAt, expiresAt, notice }),
          recipient: approvedRecipient, nonce: bytes().toString('base64') } };
      await repository.runTransaction(tx => {
        tx.create('walletChallenges', challengeId, { challenge, consumedAt: null });
      });
      requireValue(time() < expiresAt, 'CHALLENGE_EXPIRED');
      return challenge;
    },
  };
}
