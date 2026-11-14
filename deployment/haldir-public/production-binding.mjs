import { isDeepStrictEqual as equal } from 'node:util';
import { PublicKey } from 'near-api-js';
import { PRODUCTION_BINDING } from './production-policy.mjs';
import { createProtectedSecretResolver, immutableSecretVersion } from './protected-secrets.mjs';
import { createNearAiRunnerPort } from './near-ai-runner-port.mjs';

const deny = () => { throw new Error('PRODUCTION_BINDING_INVALID'); };
const demand = ok => { if (!ok) deny(); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && equal(Object.keys(v).sort(), keys.split(' ').sort());
const token = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const account = v => typeof v === 'string' && v.length >= 2 && v.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v);
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };

// Pure validation; callers cannot select a path/module. Main always reads the
// literal imported policy, before Firestore/ADC/secret/server construction.
export function validateProductionBinding(value) {
  try {
    const b = structuredClone(value);
    if (exact(b, 'schemaVersion state') && b.schemaVersion === 'haldir.production-binding.v1' && b.state === 'closed') return freeze(b);
    demand(exact(b, 'schemaVersion state activationApprovalId projectId projectNumber region runtimeServiceAccount model signingBindings') &&
      b.schemaVersion === 'haldir.production-binding.v1' && b.state === 'sealed' && token(b.activationApprovalId) &&
      b.projectId === 'loadout-haldir-demo' && b.projectNumber === '147018706305' && b.region === 'europe-west1' &&
      b.runtimeServiceAccount === 'haldir-runtime@loadout-haldir-demo.iam.gserviceaccount.com');
    demand(exact(b.model, 'model credentialVersion authorizationExpiresAt historicalBudgetUsdTotal') &&
      b.model.model === 'z-ai/glm-5.3-flash' && b.model.authorizationExpiresAt === '2026-11-16T23:59:00Z' &&
      b.model.historicalBudgetUsdTotal === '50' && immutableSecretVersion(b.model.credentialVersion, 'model'));
    demand(Array.isArray(b.signingBindings) && b.signingBindings.length > 0 && b.signingBindings.length <= 32);
    const manifests = new Set(), approvals = new Set(), keys = new Set(), versions = new Set();
    for (const row of b.signingBindings) {
      demand(exact(row, 'ownerId approvalId manifestId publicKey keyVersion') && account(row.ownerId) &&
        token(row.approvalId) && token(row.manifestId) && immutableSecretVersion(row.keyVersion, 'pay-only') &&
        typeof row.publicKey === 'string' && row.publicKey.startsWith('ed25519:') && PublicKey.fromString(row.publicKey).toString() === row.publicKey);
      const m = JSON.stringify([row.ownerId, row.manifestId]), a = JSON.stringify([row.ownerId, row.approvalId]);
      demand(!manifests.has(m) && !approvals.has(a) && !keys.has(row.publicKey) && !versions.has(row.keyVersion));
      manifests.add(m); approvals.add(a); keys.add(row.publicKey); versions.add(row.keyVersion);
    }
    return freeze(b);
  } catch { deny(); }
}
export function readProductionBinding() { return validateProductionBinding(PRODUCTION_BINDING); }

export async function createProductionComposition({ repository, binding }) {
  const b = validateProductionBinding(binding);
  const { createTrustedComposition, createPostAdmissionSignerProvider } = await import('./trusted-composition.mjs');
  const base = createTrustedComposition({ repository });
  // Closed/expired authority never suppresses existing owner stop/withdraw/read.
  // Expiry is not renewed; this does not reset any durable spending counters.
  if (b.state === 'closed' || Date.now() >= Date.parse(b.model.authorizationExpiresAt)) return base;
  const resolve = createProtectedSecretResolver({ modelVersion: b.model.credentialVersion,
    payOnlyVersions: b.signingBindings.map(row => row.keyVersion) });
  const apiKey = await resolve({ keyVersion: b.model.credentialVersion, signal: new AbortController().signal });
  if (Date.now() >= Date.parse(b.model.authorizationExpiresAt)) return base;
  // No transportFactory/budgetFactory/reservationKey override: normal SDK defaults,
  // atomic incumbent counters and cache-only recovery are the production graph.
  const model = createNearAiRunnerPort({ repository, apiKey, authorizationExpiresAt: b.model.authorizationExpiresAt });
  const allowedPayVersions = new Set(b.signingBindings.map(row => row.keyVersion));
  const resolveKeyMaterial = input => {
    if (!allowedPayVersions.has(input?.keyVersion)) throw new Error('PROTECTED_SECRET_UNAVAILABLE');
    return resolve(input);
  };
  return Object.freeze({ ...base, model,
    trustedSignerProvider: createPostAdmissionSignerProvider({ repository, signingBindings: b.signingBindings, resolveKeyMaterial, timeoutMs: 20000 }),
    capabilities: Object.freeze({ publicTestnet: true, financialActions: true, qualifiedModel: true, qualifiedSigning: true }),
  });
}
