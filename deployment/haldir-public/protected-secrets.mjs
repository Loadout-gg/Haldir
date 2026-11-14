import { isDeepStrictEqual as equal } from 'node:util';

const unavailable = () => new Error('PROTECTED_SECRET_UNAVAILABLE');
const demand = ok => { if (!ok) throw unavailable(); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && equal(Object.keys(v).sort(), keys.split(' ').sort());
export function immutableSecretVersion(value, role) {
  const prefix = role === 'model' ? 'haldir-model-' : role === 'pay-only' ? 'haldir-agent-pay-' : null;
  return prefix !== null && typeof value === 'string' &&
    new RegExp('^projects/147018706305/secrets/' + prefix + '[A-Za-z0-9_-]{1,96}/versions/[1-9][0-9]{0,18}$').test(value);
}
const META = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/';
const IDENTITY = 'haldir-runtime@loadout-haldir-demo.iam.gserviceaccount.com';
const API = 'https://secretmanager.googleapis.com/v1/';

// Fixed attached service-identity ADC REST source, not local user ADC, a vault,
// env credential, configurable endpoint, Secret Manager list or latest alias.
// Native fetch is intentional: installed Compute metadata refresh has automatic
// retries and no per-call AbortSignal. This path uses the documented metadata
// protocol directly so the ENTIRE resolution shares one cancellable deadline.
export function createProtectedSecretResolver(options = {}) {
  let allowed;
  try {
    demand(exact(options, 'modelVersion payOnlyVersions') && immutableSecretVersion(options.modelVersion, 'model') &&
      Array.isArray(options.payOnlyVersions) && options.payOnlyVersions.length > 0 && options.payOnlyVersions.length <= 32 &&
      options.payOnlyVersions.every(v => immutableSecretVersion(v, 'pay-only')) &&
      new Set(options.payOnlyVersions).size === options.payOnlyVersions.length);
    allowed = new Map([[options.modelVersion, 'model'], ...options.payOnlyVersions.map(v => [v, 'pay-only'])]);
  } catch { throw unavailable(); }
  const transport = globalThis.fetch;
  const pending = new Set();
  return async input => {
    let timer, abort, controller, signal, keyVersion;
    try {
      demand(exact(input, 'keyVersion signal') && input.signal instanceof AbortSignal && !input.signal.aborted &&
        allowed.has(input.keyVersion) && !pending.has(input.keyVersion));
      ({ signal, keyVersion } = input);
      const until = performance.now() + 5000;
      controller = new AbortController();
      abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, 5000);
      const check = () => demand(!signal.aborted && !controller.signal.aborted && performance.now() < until);
      pending.add(keyVersion);
      const get = async (url, headers, limit, metadata = false) => {
        check();
        const response = await transport(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
        const reader = response?.body?.getReader(), chunks = []; let length = 0;
        try {
          check();
          demand(reader && response.status === 200 && !response.redirected && (!response.url || response.url === url) &&
            (!metadata || response.headers.get('Metadata-Flavor') === 'Google'));
          const declared = response.headers.get('content-length');
          demand(declared === null || (/^[0-9]+$/.test(declared) && Number(declared) <= limit));
          while (true) {
            check(); const { value, done } = await reader.read(); check();
            if (done) break;
            length += value.byteLength; demand(length <= limit); chunks.push(value);
          }
          const bytes = Buffer.concat(chunks); check();
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } finally {
          // Drain/cancel before returning or propagating failure. Never abandon a
          // body and release a financial dependency while cleanup is outstanding.
          try { await reader?.cancel(); } finally { reader?.releaseLock(); }
          check();
        }
      };
      const metadataHeaders = { 'Metadata-Flavor': 'Google' };
      const identity = await get(META + 'email', metadataHeaders, 256, true); check();
      demand(identity === IDENTITY);
      const token = JSON.parse(await get(META + 'token', metadataHeaders, 16384, true)); check();
      demand(exact(token, 'access_token token_type expires_in') && token.token_type === 'Bearer' &&
        Number.isSafeInteger(token.expires_in) && token.expires_in > 0 &&
        typeof token.access_token === 'string' && /^[\x21-\x7e]{8,8192}$/.test(token.access_token));
      const response = JSON.parse(await get(API + keyVersion + ':access', { Authorization: 'Bearer ' + token.access_token }, 8192)); check();
      demand(exact(response, 'name payload') && response.name === keyVersion &&
        (exact(response.payload, 'data') || exact(response.payload, 'data dataCrc32c')));
      const data = response.payload.data;
      demand(typeof data === 'string' && data.length > 0 && data.length <= 5464 &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data));
      const bytes = Buffer.from(data, 'base64'); demand(bytes.length > 0 && bytes.length <= 4096 && bytes.toString('base64') === data);
      if (Object.hasOwn(response.payload, 'dataCrc32c')) {
        let crc = 0xffffffff;
        for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0); }
        demand(response.payload.dataCrc32c === String((crc ^ 0xffffffff) >>> 0));
      }
      const secret = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      demand(allowed.get(keyVersion) === 'model' ? /^[\x21-\x7e]{8,4096}$/.test(secret) : /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(secret));
      check(); return secret; // Pay-only SDK/public-key correspondence checked by incumbent signer.
    } catch { throw unavailable(); }
    finally {
      clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort);
      controller?.abort(); if (keyVersion) pending.delete(keyVersion);
    }
  };
}
