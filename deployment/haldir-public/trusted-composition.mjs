import { isDeepStrictEqual as equal } from 'node:util';
import { createNearOwnerKeyReader } from '../../src/server/near-owner-keys.mjs';
import { createNearOwnerOperations } from '../../src/server/near-owner-operations.mjs';
import { createNearManifestProvider } from '../../src/server/near-manifest.mjs';
import { createNearMandateStatusReader } from '../../src/server/near-mandate-status.mjs';
import { PublicKey } from 'near-api-js';
import { approvedSources, jobSourceRefs, quoteKey } from '../../src/shared/job-contract.mjs';
import { createTrustedAgentSignerProvider } from './agent-signer.mjs';
import { createNearAiRunnerPort } from './near-ai-runner-port.mjs';

// Reviewed testnet constructor policy, never selected by env, browser or model.
const RPC_URL = 'https://rpc.testnet.near.org';
const RPC_URLS = Object.freeze([RPC_URL]);
const RPC_TIMEOUT_MS = 5000;
export const APPROVAL_COLLECTION = 'publicApprovals';
const demand = (ok, code) => { if (!ok) throw new Error(code); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  equal(Object.keys(value).sort(), keys.split(' ').sort());
const account = value => typeof value === 'string' && value.length >= 2 && value.length <= 64 &&
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
const approval = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
function subject(input) {
  demand((exact(input, 'ownerId approvalId') || exact(input, 'ownerId approvalId signal')) &&
    account(input.ownerId) && approval(input.approvalId) &&
    (input.signal === undefined || input.signal instanceof AbortSignal), 'APPROVAL_SUBJECT_INVALID');
  input.signal?.throwIfAborted();
}
export function approvalKey(input) {
  subject(input);
  return JSON.stringify(['haldir-public-approval-v1', input.ownerId, input.approvalId]);
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Read-only operator-owned, create-once records, in the SAME repository as jobs
 * and sessions. No browser provisioning, mutation port, cached approval or default
 * record. Operator tooling/IAM must enforce create-only publication; changing
 * terms requires a new approvalId. Full economics and live chain qualification
 * belong to createNearManifestProvider, not this storage projection.
 */
export function createTrustedApprovalStore(options = {}) {
  demand(exact(options, 'repository') && typeof options.repository?.runTransaction === 'function', 'TRUSTED_COMPOSITION_INVALID');
  const { repository } = options;
  return Object.freeze({ async get(input) {
    subject(input);
    const key = approvalKey(input);
    try {
      const row = await repository.runTransaction(async tx => {
        input.signal?.throwIfAborted();
        const value = await tx.get(APPROVAL_COLLECTION, key);
        input.signal?.throwIfAborted();
        return value;
      });
      demand(exact(row, 'schemaVersion ownerId approvalId manifest') && row.schemaVersion === 'haldir.public.approval.v1' &&
        row.ownerId === input.ownerId && row.approvalId === input.approvalId, 'APPROVAL_UNAVAILABLE');
      const m = row.manifest;
      demand((exact(m, 'manifestId ownerId approved binding rpcUrl allowedRpcUrls') ||
        exact(m, 'manifestId ownerId approved binding rpcUrl allowedRpcUrls creation')) &&
        m.ownerId === input.ownerId && m.binding?.ownerId === input.ownerId && m.binding.networkId === 'testnet' &&
        m.approved?.job?.networkId === 'testnet' && m.rpcUrl === RPC_URL && equal(m.allowedRpcUrls, RPC_URLS), 'APPROVAL_UNAVAILABLE');
      input.signal?.throwIfAborted();
      return freeze(structuredClone(m));
    } catch { throw new Error('APPROVAL_UNAVAILABLE'); }
  } });
}

function snapshotBindings(bindings) {
  demand(Array.isArray(bindings), 'SIGNER_UNAVAILABLE');
  const rows = structuredClone(bindings), manifests = new Set(), approvals = new Set(), keys = new Set(), versions = new Set();
  for (const row of rows) {
    demand(exact(row, 'ownerId approvalId manifestId publicKey keyVersion') && account(row.ownerId) &&
      approval(row.approvalId) && approval(row.manifestId) && typeof row.keyVersion === 'string' &&
      row.keyVersion.length > 0 && row.keyVersion.length <= 1024 && !/[\s\x00-\x1f]/.test(row.keyVersion) &&
      typeof row.publicKey === 'string' && row.publicKey.startsWith('ed25519:') &&
      PublicKey.fromString(row.publicKey).toString() === row.publicKey, 'SIGNER_UNAVAILABLE');
    const m = JSON.stringify([row.ownerId, row.manifestId]), a = JSON.stringify([row.ownerId, row.approvalId]);
    demand(!manifests.has(m) && !approvals.has(a) && !keys.has(row.publicKey) && !versions.has(row.keyVersion), 'SIGNER_UNAVAILABLE');
    manifests.add(m); approvals.add(a); keys.add(row.publicKey); versions.add(row.keyVersion);
  }
  return freeze(rows);
}

/** Metadata only at startup. Ordinary admission owns all job and membership rows.
 * A cached incumbent provider retains unresolved-key quarantine across requests;
 * every invocation revalidates current records before entering that provider.
 */
export function createPostAdmissionSignerProvider(options = {}) {
  let bindings, store, repository, resolveKeyMaterial, timeoutMs;
  try {
    ({ repository, resolveKeyMaterial, timeoutMs = 20000 } = options);
    demand((exact(options, 'repository signingBindings resolveKeyMaterial') ||
      exact(options, 'repository signingBindings resolveKeyMaterial timeoutMs')) &&
      typeof repository?.runTransaction === 'function' && typeof resolveKeyMaterial === 'function' &&
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000, 'SIGNER_UNAVAILABLE');
    bindings = snapshotBindings(options.signingBindings);
    store = createTrustedApprovalStore({ repository });
  } catch { throw new Error('SIGNER_UNAVAILABLE'); }
  const providers = new Map();
  return async input => {
    try {
      demand(exact(input, 'ownerId jobId manifest signal') && account(input.ownerId) && approval(input.jobId) &&
        input.signal instanceof AbortSignal && !input.signal.aborted, 'SIGNER_UNAVAILABLE');
      const { ownerId, jobId, signal } = input, manifest = structuredClone(input.manifest);
      const check = () => demand(!signal.aborted, 'SIGNER_UNAVAILABLE');
      const binding = bindings.find(row => row.ownerId === ownerId && row.manifestId === manifest?.manifestId);
      demand(binding && binding.publicKey === manifest.binding?.publicKey, 'SIGNER_UNAVAILABLE');
      const approved = await store.get({ ownerId, approvalId: binding.approvalId, signal }); check();
      const { chainEvidence: _observation, ...terms } = manifest;
      demand(approved.manifestId === binding.manifestId && approved.binding.publicKey === binding.publicKey &&
        equal(approved, terms), 'SIGNER_UNAVAILABLE');
      const persisted = await repository.runTransaction(async tx => {
        check();
        const job = await tx.get('jobs', jobId);
        demand(job?.jobId === jobId && job.ownerId === ownerId && job.qualification === 'PUBLIC_TESTNET_FICTIONAL_VENDOR' &&
          job.state === 'LOCAL_ACTIVE' && equal(job.publicManifest, manifest) && equal(job.scope, manifest.approved.job), 'SIGNER_UNAVAILABLE');
        const sources = approvedSources(manifest.approved);
        demand(equal(jobSourceRefs(job), sources.map(({ sourceId, quoteId }) => ({ sourceId, quoteId }))), 'SIGNER_UNAVAILABLE');
        const mandateKey = Buffer.from(JSON.stringify(['haldir-local-v1', manifest.approved.job.networkId, manifest.binding.mandateId])).toString('base64url');
        const mandate = await tx.get('mandates', mandateKey);
        demand(exact(mandate, 'networkId mandateId ownerId jobId') && mandate.networkId === manifest.approved.job.networkId &&
          mandate.mandateId === manifest.binding.mandateId && mandate.ownerId === ownerId && mandate.jobId === jobId, 'SIGNER_UNAVAILABLE');
        for (const source of sources) {
          const quote = await tx.get('quotes', source.quoteId), order = await tx.get('orders', source.quoteId);
          demand(quoteKey(source.quote) === source.quoteId && quote?.jobId === jobId && quote.ownerId === ownerId &&
            equal(quote.quote, source.quote) && order?.jobId === jobId && order.quoteId === source.quoteId &&
            order.orderId === source.quote.orderId && equal(order.quote, source.quote), 'SIGNER_UNAVAILABLE');
        }
        check(); return freeze(structuredClone(job.publicManifest));
      });
      check();
      let cached = providers.get(jobId);
      if (cached) demand(cached.ownerId === ownerId && cached.keyVersion === binding.keyVersion && equal(cached.manifest, persisted), 'SIGNER_UNAVAILABLE');
      else {
        cached = { ownerId, keyVersion: binding.keyVersion, manifest: persisted,
          provider: createTrustedAgentSignerProvider({ catalog: [{ ownerId, jobId, manifest: persisted, keyVersion: binding.keyVersion }],
            resolveKeyMaterial, timeoutMs }) };
        providers.set(jobId, cached);
      }
      check(); return await cached.provider({ ownerId, jobId, manifest, signal });
    } catch { throw new Error('SIGNER_UNAVAILABLE'); }
  };
}

/** Shared validation lets main reject a malformed test boundary before opening a
 * repository. This is programmatic-only; no env/config/module interpretation. */
export function validateLocalQualification(value) {
  try {
    demand(exact(value, 'signingBindings resolveKeyMaterial model') && typeof value.resolveKeyMaterial === 'function' &&
      exact(value.model, 'apiKey authorizationExpiresAt transportFactory') && typeof value.model.apiKey === 'string' &&
      /^[\x21-\x7e]{8,4096}$/.test(value.model.apiKey) && typeof value.model.authorizationExpiresAt === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value.model.authorizationExpiresAt) &&
      Number.isFinite(Date.parse(value.model.authorizationExpiresAt)) &&
      new Date(value.model.authorizationExpiresAt).toISOString() === value.model.authorizationExpiresAt.replace('Z', '.000Z') &&
      typeof value.model.transportFactory === 'function', 'TRUSTED_COMPOSITION_INVALID');
    snapshotBindings(value.signingBindings);
  } catch { throw new Error('TRUSTED_COMPOSITION_INVALID'); }
}

/** Default graph remains closed. The complete qualification graph is a trusted
 * test-only constructor boundary, never a production activation mechanism. */
export function createTrustedComposition(options = {}) {
  demand((exact(options, 'repository') || exact(options, 'repository localQualification')) &&
    typeof options.repository?.runTransaction === 'function', 'TRUSTED_COMPOSITION_INVALID');
  const { repository, localQualification } = options;
  const qualified = Object.hasOwn(options, 'localQualification');
  if (qualified) validateLocalQualification(localQualification);
  return Object.freeze({
    trustedAccessKeyReader: createNearOwnerKeyReader({ rpcUrl: RPC_URL, timeoutMs: RPC_TIMEOUT_MS }),
    trustedManifestProvider: createNearManifestProvider({ trustedApprovalStore: createTrustedApprovalStore({ repository }),
      rpcUrl: RPC_URL, allowedRpcUrls: RPC_URLS, timeoutMs: RPC_TIMEOUT_MS }),
    ownerOperations: createNearOwnerOperations({ repository, rpcUrl: RPC_URL, allowedRpcUrls: RPC_URLS, timeoutMs: RPC_TIMEOUT_MS }),
    trustedMandateStatusReader: createNearMandateStatusReader({ repository, rpcUrl: RPC_URL, allowedRpcUrls: RPC_URLS, timeoutMs: RPC_TIMEOUT_MS }),
    ...(qualified ? { trustedSignerProvider: createPostAdmissionSignerProvider({ repository,
      signingBindings: localQualification.signingBindings, resolveKeyMaterial: localQualification.resolveKeyMaterial, timeoutMs: 20000 }),
      model: createNearAiRunnerPort({ repository, apiKey: localQualification.model.apiKey,
        authorizationExpiresAt: localQualification.model.authorizationExpiresAt, transportFactory: localQualification.model.transportFactory }) } : {}),
    capabilities: Object.freeze({ publicTestnet: true, financialActions: qualified, qualifiedModel: qualified, qualifiedSigning: qualified }),
    maxRunMs: 20000,
  });
}
