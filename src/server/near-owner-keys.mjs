import { JsonRpcProvider, PublicKey, baseDecode } from 'near-api-js';

export const OWNER_KEY_RPC_URLS = Object.freeze([
  'https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com',
]);
export class NearOwnerKeyError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const demand = (ok, code = 'OWNER_KEY_UNAVAILABLE') => { if (!ok) throw new NearOwnerKeyError(code); };
const account = s => typeof s === 'string' && s.length >= 2 && s.length <= 64 &&
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(s);
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) &&
  Object.keys(o).sort().join(' ') === [...keys].sort().join(' ');
function publicKeyValid(value) {
  try { const key = PublicKey.fromString(value); return key.keyType === 0 && key.toString() === value; }
  catch { return false; }
}
function hashValid(value) {
  try { return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && baseDecode(value).length === 32; }
  catch { return false; }
}
function deadline(timeoutMs) {
  const controller = new AbortController();
  const until = performance.now() + timeoutMs;
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new NearOwnerKeyError('OWNER_KEY_UNAVAILABLE')); }, timeoutMs);
  });
  return {
    signal: controller.signal,
    async read(fn) {
      demand(performance.now() < until);
      const result = await Promise.race([Promise.resolve().then(fn), expired]);
      demand(performance.now() < until);
      return result;
    },
    close() { clearTimeout(timer); },
  };
}
async function boundedJson(response) {
  demand(response.ok && !response.redirected && response.body);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      demand(size <= 65_536);
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { reader.cancel().catch(() => {}); }
}

// Actual installed SDK status and access-key methods; only transport is narrowed.
// The default SDK transport follows redirects and has no total AbortSignal fence.
class OwnerKeyProvider extends JsonRpcProvider {
  constructor(url, transport, clock) {
    super({ url }, { retries: 1 });
    this.transport = transport; this.clock = clock; this.sequence = 0;
  }
  async sendJsonRpc(method, params) {
    demand((method === 'status' && Array.isArray(params) && params.length === 0) ||
      (method === 'query' && exact(params, ['finality', 'request_type', 'account_id', 'public_key']) &&
        params.finality === 'final' && params.request_type === 'view_access_key'));
    const id = String(++this.sequence);
    const payload = await this.clock.read(async () => {
      const response = await this.transport(this.connection.url, { method: 'POST', redirect: 'error',
        signal: this.clock.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      return boundedJson(response);
    });
    demand(payload?.jsonrpc === '2.0' && payload.id === id && !Object.hasOwn(payload, 'error') &&
      Object.hasOwn(payload, 'result'));
    return payload.result;
  }
}

/**
 * Trusted server-only read port for wallet-session.mjs, NOT a browser key oracle.
 * No signer, key store, wallet, generic RPC, transaction or financial authority.
 * rpcUrl is an EXACT allowlisted HTTPS literal; no URL/chain inference by suffix.
 * transport is a trusted fetch-compatible seam, never populated from HTTP input.
 * Each call rereads actual status.chain_id then current FINAL key membership.
 * One monotonic deadline covers BOTH calls and response bodies, without retries.
 * No caching or logging. Every failure is redacted; no upstream message/cause.
 */
export function createNearOwnerKeyReader({ rpcUrl, transport = globalThis.fetch,
  now = Date.now, timeoutMs = 5_000 } = {}) {
  demand(OWNER_KEY_RPC_URLS.includes(rpcUrl) && typeof transport === 'function' && typeof now === 'function' &&
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000, 'OWNER_KEY_CONFIG_INVALID');
  return async input => {
    let subject;
    try { subject = structuredClone(input); } catch { throw new NearOwnerKeyError('OWNER_KEY_SUBJECT_INVALID'); }
    demand(exact(subject, ['networkId', 'accountId', 'publicKey']) && subject.networkId === 'testnet' &&
      account(subject.accountId) && publicKeyValid(subject.publicKey), 'OWNER_KEY_SUBJECT_INVALID');
    const clock = deadline(timeoutMs);
    try {
      const provider = new OwnerKeyProvider(rpcUrl, transport, clock);
      const status = await clock.read(() => provider.viewNodeStatus());
      demand(status?.chain_id === 'testnet' && status.sync_info?.syncing === false);
      const key = await clock.read(() => provider.viewAccessKey({ accountId: subject.accountId,
        publicKey: subject.publicKey, finalityQuery: { finality: 'final' } }));
      return await clock.read(() => {
        demand(key?.permission === 'FullAccess' && Number.isSafeInteger(key.block_height) && key.block_height > 0 &&
          hashValid(key.block_hash));
        const observedAt = now();
        demand(Number.isSafeInteger(observedAt) && observedAt >= 0);
        return { ...subject, permission: 'FullAccess', finality: 'final', blockHeight: key.block_height,
          blockHash: key.block_hash, observedAt };
      });
    } catch { throw new NearOwnerKeyError('OWNER_KEY_UNAVAILABLE'); }
    finally { clock.close(); }
  };
}
