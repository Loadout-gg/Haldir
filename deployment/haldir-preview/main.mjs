import { access, readFile } from 'node:fs/promises';
const fail = code => { throw new Error(code); };
const codes = new Set(['EXACT_HTTPS_ORIGIN_REQUIRED', 'TARGET_PROJECT_REQUIRED', 'REGION_REQUIRED',
  'PORT_INVALID', 'DATABASE_ID_REQUIRED', 'HOSTED_CREDENTIAL_OVERRIDE_FORBIDDEN',
  'NODE_26_13_1_REQUIRED', 'FIRESTORE_ADAPTER_REQUIRED', 'UI_APPROVED_ORIGIN_MISMATCH']);
// Fixed composition, never accepts an HTTP adapter path, synthetic identity or SQLite fallback.
async function main() {
  const env = process.env;
  let origin;
  try { origin = new URL(env.HALDIR_APPROVED_ORIGIN); } catch { /* reject below */ }
  if (origin?.protocol !== 'https:' || origin.origin !== env.HALDIR_APPROVED_ORIGIN || origin.username || origin.password)
    fail('EXACT_HTTPS_ORIGIN_REQUIRED');
  if (env.GOOGLE_CLOUD_PROJECT !== 'loadout-haldir-demo' || env.HALDIR_PROJECT_NUMBER !== '147018706305') fail('TARGET_PROJECT_REQUIRED');
  if (env.HALDIR_REGION !== 'europe-west1') fail('REGION_REQUIRED');
  const port = Number(env.PORT ?? '8080');
  if (!/^[1-9][0-9]{0,4}$/.test(env.PORT ?? '8080') || port > 65535) fail('PORT_INVALID');
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(env.HALDIR_FIRESTORE_DATABASE_ID ?? '') && env.HALDIR_FIRESTORE_DATABASE_ID !== '(default)') fail('DATABASE_ID_REQUIRED');
  if (env.FIRESTORE_EMULATOR_HOST || env.GOOGLE_APPLICATION_CREDENTIALS) fail('HOSTED_CREDENTIAL_OVERRIDE_FORBIDDEN');
  if (process.versions.node !== '26.13.1') fail('NODE_26_13_1_REQUIRED');
  // Runtime env alone cannot configure Vite's baked client. Require its exact build binding.
  let uiReceipt;
  try { uiReceipt = JSON.parse(await readFile(new URL('./ui-build-receipt.json', import.meta.url), 'utf8')); }
  catch { fail('UI_APPROVED_ORIGIN_MISMATCH'); }
  if (uiReceipt.approvedOrigin !== env.HALDIR_APPROVED_ORIGIN ||
      uiReceipt.viteApprovedOrigin !== env.HALDIR_APPROVED_ORIGIN) fail('UI_APPROVED_ORIGIN_MISMATCH');
  const adapter = new URL('./firestore-repository.mjs', import.meta.url);
  try { await access(adapter); } catch { fail('FIRESTORE_ADAPTER_REQUIRED'); }
  // Genuine Firestore repository and locked SDK, with no local persistence fallback.
  const { openFirestoreRepository } = await import(adapter.href);
  const repository = await openFirestoreRepository({ projectId: 'loadout-haldir-demo',
    databaseId: env.HALDIR_FIRESTORE_DATABASE_ID, namespace: 'haldirPreviewTestnetV1', timeoutMs: 5000 });
  await repository.verifyReadiness(); // actual bounded ADC/database read, not transport liveness
  const { createNearOwnerKeyReader } = await import('../../src/server/near-owner-keys.mjs');
  const { createPreviewServer } = await import('./server.mjs');
  const server = await createPreviewServer({ uiDir: new URL('./ui/', import.meta.url),
    approvedOrigin: env.HALDIR_APPROVED_ORIGIN, repository,
    trustedAccessKeyReader: createNearOwnerKeyReader({ rpcUrl: 'https://rpc.testnet.near.org', timeoutMs: 5000 }) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  console.log('HALDIR_LOGIN_PREVIEW_LISTENING_FINANCIAL_ACTIONS_DISABLED');
  const shutdown = () => {
    const timer = setTimeout(() => process.exit(1), 8000); timer.unref();
    server.close(async () => { try { await repository.close(); process.exit(0); } catch { process.exit(1); } });
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
main().catch(error => { console.error(codes.has(error.message) ? error.message : 'PREVIEW_STARTUP_FAILED'); process.exitCode = 1; });
