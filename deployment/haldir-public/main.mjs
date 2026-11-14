import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const startupCodes = new Set(['EXACT_HTTPS_ORIGIN_REQUIRED', 'TARGET_PROJECT_REQUIRED', 'REGION_REQUIRED',
  'DATABASE_ID_REQUIRED', 'PORT_INVALID', 'HOSTED_CREDENTIAL_OVERRIDE_FORBIDDEN',
  'NODE_26_13_1_REQUIRED', 'UI_APPROVED_ORIGIN_MISMATCH']);

// Import is inert. Only this fixed entrypoint can open ADC/listen, and only after
// validating every noncredential binding. No environment module/provider loader.
export async function startPublicRuntime(options = {}) {
  const env = process.env;
  if (env.HALDIR_APPROVED_ORIGIN !== 'https://haldir.ldt.sh') throw new Error('EXACT_HTTPS_ORIGIN_REQUIRED');
  if (env.GOOGLE_CLOUD_PROJECT !== 'loadout-haldir-demo' || env.HALDIR_PROJECT_NUMBER !== '147018706305') throw new Error('TARGET_PROJECT_REQUIRED');
  if (env.HALDIR_REGION !== 'europe-west1') throw new Error('REGION_REQUIRED');
  if (env.HALDIR_FIRESTORE_DATABASE_ID !== 'haldir') throw new Error('DATABASE_ID_REQUIRED');
  const portText = env.PORT ?? '8080';
  if (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535) throw new Error('PORT_INVALID');
  if (['GOOGLE_APPLICATION_CREDENTIALS', 'FIRESTORE_EMULATOR_HOST'].some(key => Object.hasOwn(env, key))) throw new Error('HOSTED_CREDENTIAL_OVERRIDE_FORBIDDEN');
  if (process.versions.node !== '26.13.1') throw new Error('NODE_26_13_1_REQUIRED');
  let receipt;
  try { receipt = JSON.parse(await readFile(new URL('./ui-build-receipt.json', import.meta.url), 'utf8')); }
  catch { throw new Error('UI_APPROVED_ORIGIN_MISMATCH'); }
  if (receipt?.approvedOrigin !== env.HALDIR_APPROVED_ORIGIN ||
      receipt?.viteApprovedOrigin !== env.HALDIR_APPROVED_ORIGIN || receipt?.publicMode !== 'public-testnet')
    throw new Error('UI_APPROVED_ORIGIN_MISMATCH');

  const keys = options && typeof options === 'object' && !Array.isArray(options) ? Object.keys(options).sort() : null;
  const injected = keys?.length === 2 && keys[0] === 'localQualification' && keys[1] === 'openRepository';
  if (!(keys?.length === 0 || (injected && typeof options.openRepository === 'function')))
    throw new Error('PUBLIC_START_OPTIONS_INVALID');
  const { createTrustedComposition, validateLocalQualification } = await import('./trusted-composition.mjs');
  let localQualification;
  if (injected) {
    validateLocalQualification(options.localQualification);
    // Capture constructor data before awaiting opening; no environment/config path.
    localQualification = { signingBindings: structuredClone(options.localQualification.signingBindings),
      resolveKeyMaterial: options.localQualification.resolveKeyMaterial, model: { ...options.localQualification.model } };
  }
  // Validate the complete fixed production policy BEFORE any ADC/storage access.
  const production = injected ? null : await import('./production-binding.mjs');
  const binding = production?.readProductionBinding();
  // The default remains a fixed literal hosted adapter. Only explicit test-owned
  // programmatic calls can supply the local opener, never the auto-entry block.
  const openRepository = injected ? options.openRepository :
    (await import('../haldir-preview/firestore-repository.mjs')).openFirestoreRepository;
  const repository = await openRepository({ projectId: 'loadout-haldir-demo', databaseId: 'haldir',
    namespace: 'haldirPreviewTestnetV1', timeoutMs: 5000 });
  let server, closing;
  const close = () => closing ??= (async () => {
    try {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally { await repository.close(); }
  })();
  try {
    await repository.verifyReadiness(); // bounded real ADC/database read BEFORE server construction
    const { createPublicServer } = await import('./server.mjs');
    const composition = injected || binding.state === 'closed'
      ? createTrustedComposition({ repository, ...(injected ? { localQualification } : {}) })
      : await production.createProductionComposition({ repository, binding });
    server = await createPublicServer({ uiDir: new URL('./ui/', import.meta.url),
      approvedOrigin: env.HALDIR_APPROVED_ORIGIN, repository,
      ...composition });
    await new Promise((resolve, reject) => {
      const error = cause => { server.off('listening', listening); reject(cause); };
      const listening = () => { server.off('error', error); resolve(); };
      server.once('error', error); server.once('listening', listening);
      server.listen(Number(portText), '0.0.0.0');
    });
    return Object.freeze({ server, close, financialActions: composition.capabilities.financialActions });
  } catch (error) {
    await close().catch(() => {}); // preserve redacted startup failure, but always request drain/termination
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startPublicRuntime().then(runtime => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return; stopping = true;
      // Cloud Run's existing 30s request bound is unchanged; no detached financial
      // task is scheduled. Stop admission, drain HTTP then SDK; force fail after 8s.
      const timer = setTimeout(() => process.exit(1), 8000); timer.unref();
      runtime.close().then(() => process.exit(0), () => process.exit(1));
    };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    console.log(runtime.financialActions ? 'HALDIR_PUBLIC_LISTENING_SEALED_BINDING' : 'HALDIR_PUBLIC_LISTENING_FINANCIAL_ACTIONS_DISABLED');
  }).catch(error => {
    console.error(startupCodes.has(error?.message) ? error.message : 'PUBLIC_STARTUP_FAILED');
    process.exitCode = 1;
  });
}
