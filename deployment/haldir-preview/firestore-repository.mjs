import { Firestore } from '@google-cloud/firestore';

/**
 * Hosted implementation of the orders.mjs JSON repository port; never imports
 * its LOCAL SQLite implementation. SDK exact-reference create/set commit
 * atomically; the SDK enforces reads before writes and maxAttempts is five.
 * Callbacks can rerun: keep clocks, randomness, RPC and other effects outside.
 *
 * Official contracts (reference headings may lag the pinned registry version):
 * https://docs.cloud.google.com/nodejs/docs/reference/firestore/latest/firestore/transaction
 * https://docs.cloud.google.com/docs/authentication/provide-credentials-adc
 * https://docs.cloud.google.com/firestore/quotas
 *
 * verifyReadiness's wall deadline includes ADC initialization. Failure poisons
 * this repository immediately; close drains outstanding SDK work before pool
 * termination. The SDK's bounded stream retries can outlive that wall deadline.
 * A timed-out write is uncertain, not proof of rollback; do not replay effects.
 * No runtime, hosted ADC/IAM, real durability or spend-cap claim is made here.
 */
export function openFirestoreRepository(options = {}) {
  const { projectId, databaseId, namespace, timeoutMs } = options;
  const allowed = ['projectId', 'databaseId', 'namespace', 'timeoutMs'];
  if (Object.keys(options).some(key => !allowed.includes(key)) || projectId !== 'loadout-haldir-demo' ||
    typeof databaseId !== 'string' || (databaseId !== '(default)' &&
      (!/^[a-z][a-z0-9-]{2,62}$/.test(databaseId) || /[^a-z0-9-]/.test(databaseId))) ||
    namespace !== 'haldirPreviewTestnetV1' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error('FIRESTORE_CONFIG_INVALID');
  // Attached runtime identity/ADC only. No credential files, custom endpoints,
  // emulator, injected client or local persistence branch is accepted.
  if (['GOOGLE_APPLICATION_CREDENTIALS', 'FIRESTORE_EMULATOR_HOST'].some(key => Object.hasOwn(process.env, key)))
    throw new Error('HOSTED_CREDENTIAL_OVERRIDE_FORBIDDEN');
  const rpc = { timeout_millis: timeoutMs, retry_codes_name: 'haldirNoRetry' };
  const db = new Firestore({ projectId, databaseId, servicePath: 'firestore.googleapis.com',
    ssl: true, preferRest: false,
    clientConfig: { interfaces: { 'google.firestore.v1.Firestore': {
      retry_codes: { haldirNoRetry: [] },
      methods: { BatchGetDocuments: { ...rpc }, Commit: { ...rpc }, Rollback: { ...rpc } },
    } } },
  });
  let closed = false, closing;
  const inFlight = new Set();
  const track = promise => {
    inFlight.add(promise);
    void promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
    return promise;
  };
  const requireOpen = () => { if (closed) throw new Error('FIRESTORE_REPOSITORY_CLOSED'); };
  const close = () => {
    closed = true;
    // The SDK's streaming retry runner can outlive its first RPC deadline.
    // Terminating its pool mid-retry produces an unhandled SDK rejection. Drain
    // tracked operations first; poisoning is immediate, resource cleanup is not.
    return closing ??= Promise.allSettled([...inFlight]).then(() => db.terminate());
  };
  // Versioned reversible UTF-16LE encoding preserves even lone surrogates. Split
  // into fixed 1000-character IDs: the port's full 2048-code-unit key stays below
  // Firestore's 1500-byte ID / 6-KiB document-name limits without hash collisions.
  // These are exact document references, never query-then-create uniqueness.
  const ref = (collection, key) => {
    if (typeof collection !== 'string' || !/^[A-Za-z]/.test(collection) ||
      /[^A-Za-z0-9]/.test(collection) || collection.length > 32 ||
      typeof key !== 'string' || !key.length || key.length > 2048)
      throw new Error('invalid repository key');
    const encoded = Buffer.from(key, 'utf16le').toString('base64url');
    const chunks = encoded.match(/.{1,1000}/g);
    return db.doc(`namespaces/${namespace}/${collection}/k1_${chunks.join('/keyChunks/k1_')}`);
  };
  const document = value => {
    // Store a JSON string envelope, not native Firestore fields. This preserves
    // the port's JSON.stringify semantics (primitives, arrays, nested arrays,
    // Date/toJSON, undefined object members) and avoids field/index fan-out.
    const json = JSON.stringify(value);
    if (typeof json !== 'string' || Buffer.byteLength(json) > 512 * 1024)
      throw new Error('document too large or not JSON');
    return { json };
  };
  return {
    async runTransaction(callback) {
      requireOpen();
      return track(db.runTransaction(async sdk => {
        requireOpen();
        let active = true;
        const requireActive = () => {
          if (!active) throw new Error('FIRESTORE_TRANSACTION_FINISHED');
          requireOpen();
        };
        try {
          return await callback({
            async get(collection, key) {
              requireActive();
              const snapshot = await sdk.get(ref(collection, key));
              requireActive();
              return snapshot.exists ? JSON.parse(snapshot.data().json) : null;
            },
            create(collection, key, value) { requireActive(); sdk.create(ref(collection, key), document(value)); },
            set(collection, key, value) { requireActive(); sdk.set(ref(collection, key), document(value)); },
          });
        } finally { active = false; }
      }, { maxAttempts: 5 }));
    },
    async verifyReadiness() {
      requireOpen();
      let timer;
      try {
        // Missing probe document is OK; a successful server read still requires
        // ADC, a real selected database and read permission. Never writes a probe.
        await Promise.race([
          track(ref('walletChallenges', 'haldir-readiness-v1').get()),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('FIRESTORE_READINESS_TIMEOUT')), timeoutMs);
          }),
        ]);
        requireOpen();
      } catch (error) {
        // Fail closed even if initialization/read completes after the deadline.
        // terminate() is requested, not proof that an RPC was remotely cancelled.
        void close().catch(() => {});
        throw error;
      } finally { clearTimeout(timer); }
    },
    close,
  };
}
