import { KeyPairSigner, PublicKey, Transaction, baseDecode, baseEncode } from 'near-api-js';
import { isDeepStrictEqual as equal } from 'node:util';
const deny = () => { throw new Error('SIGNER_UNAVAILABLE'); };
const requireValue = value => { if (!value) deny(); };

const amount = v => typeof v === 'string' && /^[1-9][0-9]{0,38}$/.test(v) && BigInt(v) < 2n ** 128n;
const account = v => typeof v === 'string' && v.length >= 2 && v.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v);
const token = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);

/** Constructor-only authority. Catalog rows carry the incumbent publicManifest
 * unchanged, including generated runtime_binding as manifest.binding. The only
 * added custody field is an opaque immutable keyVersion resolved by the trusted
 * injected port. Never expose this provider or catalog to a model/browser.
 * No RPC, environment loader, ledger, broadcast, or retry belongs here.
 */
export function createTrustedAgentSignerProvider({ catalog, resolveKeyMaterial, timeoutMs = 10_000 } = {}) {
  let records;
  try {
    requireValue(Array.isArray(catalog) && typeof resolveKeyMaterial === 'function' &&
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000);
    records = structuredClone(catalog);
    const jobs = new Set(), keys = new Set(), versions = new Set();
    for (const row of records) {
      requireValue(equal(Object.keys(row).sort(), ['jobId', 'keyVersion', 'manifest', 'ownerId']) &&
        account(row.ownerId) && token(row.jobId) && typeof row.keyVersion === 'string' &&
        row.keyVersion.length > 0 && row.keyVersion.length <= 1024 && !/[\s\x00-\x1f]/.test(row.keyVersion));
      const b = row.manifest.binding, scope = row.manifest.approved.job;
      requireValue(equal(Object.keys(b).sort(), ['codeHash', 'mandateId', 'maxAllowanceAtomic', 'networkId', 'ownerId', 'publicKey', 'signerId']) &&
        b.ownerId === row.ownerId && account(b.signerId) && account(b.mandateId) &&
        new Set([b.ownerId, b.signerId, b.mandateId]).size === 3 && b.networkId === 'testnet' && amount(b.maxAllowanceAtomic) &&
        b.publicKey.startsWith('ed25519:') && PublicKey.fromString(b.publicKey).toString() === b.publicKey &&
        baseDecode(b.codeHash).length === 32 && baseEncode(baseDecode(b.codeHash)) === b.codeHash &&
        scope.networkId === b.networkId && scope.mandateId === b.mandateId && amount(scope.budgetAtomic) &&
        Array.isArray(scope.vendorIds) && scope.vendorIds.length > 0 && scope.vendorIds.every(account) &&
        new Set(scope.vendorIds).size === scope.vendorIds.length);
      requireValue(!jobs.has(row.jobId) && !keys.has(b.publicKey) && !versions.has(row.keyVersion));
      jobs.add(row.jobId); keys.add(b.publicKey); versions.add(row.keyVersion);
    }
  } catch { deny(); }
  const resolving = new Set();
  return async request => {
    let timer, onAbort, signal;
    try {
      requireValue(equal(Object.keys(request).sort(), ['jobId', 'manifest', 'ownerId', 'signal']));
      const { ownerId, jobId, manifest } = request; signal = request.signal;
      requireValue(signal instanceof AbortSignal && !signal.aborted);
      const row = records.find(r => r.ownerId === ownerId && r.jobId === jobId);
      requireValue(row && equal(manifest, row.manifest) && !resolving.has(row));
      const until = performance.now() + timeoutMs, controller = new AbortController();
      const check = () => requireValue(!signal.aborted && !controller.signal.aborted && performance.now() < until);
      let rejectAbort;
      const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
      onAbort = () => { controller.abort(); rejectAbort(new Error('SIGNER_UNAVAILABLE')); };
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onAbort, timeoutMs);
      resolving.add(row);
      const resolution = Promise.resolve().then(() => { check(); return resolveKeyMaterial({ keyVersion: row.keyVersion, signal: controller.signal }); });
      // An uncancellable resolver stays quarantined until settlement; late secret
      // values are discarded. Rejection is consumed, never logged or rethrown.
      resolution.then(() => resolving.delete(row), () => resolving.delete(row));
      const secret = await Promise.race([resolution, cancelled]); check();
      requireValue(typeof secret === 'string' && secret.startsWith('ed25519:'));
      const sdk = KeyPairSigner.fromSecretKey(secret);
      requireValue((await sdk.getPublicKey()).toString() === row.manifest.binding.publicKey); check();
      return Object.freeze({ async getPublicKey() { check(); const pk = PublicKey.fromString(row.manifest.binding.publicKey); check(); return pk; }, async signTransaction(candidate) {
        try {
          check();
          // Snapshot through the installed SDK before any asynchronous signing.
          const tx = Transaction.decode(candidate.encode()), b = row.manifest.binding, scope = row.manifest.approved.job;
          requireValue(tx.signerId === b.signerId && tx.receiverId === b.mandateId && tx.publicKey.toString() === b.publicKey &&
            tx.nonce > 0n && tx.nonce < 2n ** 64n && tx.actions.length === 1 && equal(Object.keys(tx.actions[0]), ['functionCall']));
          const call = tx.actions[0].functionCall;
          requireValue(call.methodName === 'pay' && call.deposit === 0n && call.gas === 100_000_000_000_000n && call.args.length <= 512);
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(call.args)), args = JSON.parse(text);
          requireValue(equal(Object.keys(args).sort(), ['amount', 'order_id', 'recipient']) &&
            typeof args.order_id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(args.order_id) &&
            scope.vendorIds.includes(args.recipient) && typeof args.amount === 'string' && /^[1-9][0-9]{0,38}$/.test(args.amount) &&
            BigInt(args.amount) < 2n ** 128n && BigInt(args.amount) <= BigInt(scope.budgetAtomic) &&
            text === JSON.stringify({ order_id: args.order_id, recipient: args.recipient, amount: args.amount }));
          check(); const result = await sdk.signTransaction(tx); check(); return result;
        } catch { deny(); }
      } });
    } catch { deny(); }
    finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); }
  };
}
