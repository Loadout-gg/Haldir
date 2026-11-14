import { isDeepStrictEqual as equal } from 'node:util';
import { JsonRpcProvider, PublicKey, baseDecode, baseEncode } from 'near-api-js';
import { approvedSources, jobSourceRefs, quoteKey } from '../shared/job-contract.mjs';

const demand = (v, code = 'RPC_UNAVAILABLE') => { if (!v) throw Object.assign(new Error(code), { code }); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && equal(Object.keys(v).sort(), keys.split(' ').sort());
const account = v => typeof v === 'string' && v.length >= 2 && v.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v);
const token = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
const uint = (v, bits = 128) => typeof v === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(v) && BigInt(v) < 2n ** BigInt(bits);
const hash = v => { try { return typeof v === 'string' && v.length >= 32 && v.length <= 44 && baseDecode(v).length === 32 && baseEncode(baseDecode(v)) === v; } catch { return false; } };
const https = v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && (v === u.origin || v === `${u.origin}/`); } catch { return false; } };

// Same finite, SDK-owned request construction / closed transport as near-manifest.
// One monotonic deadline includes repository, headers, bodies and validation.
function boundedScope(timeoutMs, external) {
  const controller = new AbortController(), end = performance.now() + timeoutMs;
  let reject;
  const expired = new Promise((_, r) => { reject = r; }); expired.catch(() => {});
  const abort = () => { controller.abort(); reject(new Error('RPC_UNAVAILABLE')); };
  external.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  const fence = () => demand(!external.aborted && !controller.signal.aborted && performance.now() < end);
  return { signal: controller.signal, fence,
    async read(fn) { fence(); const v = await Promise.race([Promise.resolve().then(() => { fence(); return fn(); }), expired]); fence(); return v; },
    close() { clearTimeout(timer); external.removeEventListener('abort', abort); controller.abort(); } };
}
async function boundedJson(response, signal) {
  demand(response?.ok && !response.redirected && response.body);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      demand(!signal.aborted); const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; demand(size <= 262144); chunks.push(Buffer.from(value));
    }
    demand(!signal.aborted);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}
class StatusProvider extends JsonRpcProvider {
  constructor(url, transport, scope, child) { super({ url }, { retries: 1 }); this.transport = transport; this.scope = scope; this.child = child; this.block = null; this.seq = 0; }
  async sendJsonRpc(method, params) {
    params = JSON.parse(JSON.stringify(params));
    demand(method === 'status' && equal(params, []) || method === 'block' && equal(params, { finality: 'final' }) ||
      method === 'query' && this.block && params.account_id === this.child && params.block_id === this.block.hash &&
      (params.request_type === 'view_account' && exact(params, 'request_type account_id block_id') ||
        params.request_type === 'call_function' && exact(params, 'request_type account_id block_id method_name args_base64') && params.method_name === 'get_status' && params.args_base64 === 'e30='));
    const id = String(++this.seq);
    const payload = await this.scope.read(async () => boundedJson(await this.transport(this.connection.url,
      { method:'POST',redirect:'error',signal:this.scope.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}) }), this.scope.signal));
    demand(payload?.jsonrpc === '2.0' && payload.id === id && (Object.hasOwn(payload,'result') !== Object.hasOwn(payload,'error')));
    if (Object.hasOwn(payload,'error')) {
      const e = payload.error, info = e?.cause?.info;
      // Official near-api-js 7.4.0 UNKNOWN_ACCOUNT shape, bound to this
      // child/account query and this exact FINAL block (not message matching).
      if (method === 'query' && params.request_type === 'view_account' && e?.name === 'HANDLER_ERROR' && e.cause?.name === 'UNKNOWN_ACCOUNT' &&
        info?.requested_account_id === this.child && info.block_hash === this.block.hash && info.block_height === this.block.height)
        demand(false,'NOT_DEPLOYED');
      demand(false);
    }
    return payload.result;
  }
}
// Validate stored immutable schema, not admission freshness or spend eligibility.
function manifestSources(m, ownerId, rpcUrl, urls) {
  const b = m?.binding, e = m?.chainEvidence;
  demand((exact(m,'manifestId ownerId approved binding rpcUrl allowedRpcUrls chainEvidence') || exact(m,'manifestId ownerId approved binding rpcUrl allowedRpcUrls chainEvidence creation')) &&
    token(m.manifestId) && m.ownerId === ownerId && exact(b,'networkId ownerId signerId mandateId publicKey maxAllowanceAtomic codeHash') &&
    b.networkId === 'testnet' && b.ownerId === ownerId && account(b.signerId) && account(b.mandateId) && b.signerId !== ownerId && b.mandateId !== ownerId && b.signerId !== b.mandateId &&
    hash(b.codeHash) && uint(b.maxAllowanceAtomic) && BigInt(b.maxAllowanceAtomic) > 0n &&
    m.rpcUrl === rpcUrl && equal(m.allowedRpcUrls,urls) &&
    (exact(e,'networkId finality blockHash blockHeight observedAt') || exact(e,'networkId finality blockHash blockHeight observedAt deployment') && ['FACTORY_READY','MANDATE_READY'].includes(e.deployment)) &&
    e.networkId === 'testnet' && e.finality === 'final' && hash(e.blockHash) && Number.isSafeInteger(e.blockHeight) && e.blockHeight > 0 && Number.isSafeInteger(e.observedAt) && e.observedAt >= 0 &&
    (e.deployment !== 'FACTORY_READY' || Object.hasOwn(m,'creation')), 'BINDING_MISMATCH');
  const pk = PublicKey.fromString(b.publicKey);
  demand(pk.keyType === 0 && pk.toString() === b.publicKey, 'BINDING_MISMATCH');
  const sources = approvedSources(m.approved), j = m.approved.job;
  demand(j.networkId === 'testnet' && j.mandateId === b.mandateId && uint(String(BigInt(Date.parse(j.expiresAt))*1000000n),64), 'BINDING_MISMATCH');
  return sources;
}
function validateStatus(s, m) {
  const j = m.approved.job, b = m.binding;
  demand(exact(s,'owner agent allowlist cap deadline_ns spent refunded reserved free stopped expired in_flight refund_nonce orders') &&
    s.owner === m.ownerId && s.agent === b.signerId && equal(s.allowlist,j.vendorIds) && s.cap === j.budgetAtomic &&
    uint(s.deadline_ns,64) && s.deadline_ns === String(BigInt(Date.parse(j.expiresAt))*1000000n) &&
    ['cap','spent','refunded','reserved','free'].every(k=>uint(s[k])) && uint(s.refund_nonce,64) && typeof s.stopped === 'boolean' && typeof s.expired === 'boolean' &&
    (s.in_flight === null || typeof s.in_flight === 'string' && (s.in_flight.startsWith('payment:') && token(s.in_flight.slice(8)) || s.in_flight.startsWith('refund:') && uint(s.in_flight.slice(7),64))) &&
    Array.isArray(s.orders) && s.orders.length <= 16 && new Set(s.orders.map(o=>o?.order_id)).size === s.orders.length &&
    s.orders.every(o=>exact(o,'order_id recipient amount state') && token(o.order_id) && account(o.recipient) && s.allowlist.includes(o.recipient) && uint(o.amount) && BigInt(o.amount)>0n && ['pending','paid','failed'].includes(o.state)) &&
    BigInt(s.spent)+BigInt(s.refunded)+BigInt(s.reserved)+BigInt(s.free) === BigInt(s.cap), 'BINDING_MISMATCH');
}

/** Read-only observation; never admission, spend permission, account balance or a refund receipt. */
export function createNearMandateStatusReader({repository,rpcUrl,allowedRpcUrls,transport=globalThis.fetch,now=Date.now,timeoutMs=5000} = {}) {
  demand(typeof repository?.runTransaction === 'function' && typeof transport === 'function' && typeof now === 'function' && https(rpcUrl) &&
    Array.isArray(allowedRpcUrls) && allowedRpcUrls.length >= 1 && allowedRpcUrls.length <= 4 && allowedRpcUrls.every(https) && allowedRpcUrls.includes(rpcUrl) &&
    !allowedRpcUrls.some(u=>new URL(u).hostname.includes('mainnet')) && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000, 'MANDATE_STATUS_CONFIGURATION_INVALID');
  const urls = structuredClone(allowedRpcUrls);
  return async input => {
    demand(exact(input,'ownerId jobId manifest signal') && account(input.ownerId) && token(input.jobId) && input.signal instanceof AbortSignal, 'MANDATE_STATUS_SUBJECT_INVALID');
    const scope = boundedScope(timeoutMs,input.signal);
    let subject = null;
    const unavailable = reason => ({...subject,state:'unavailable',observation:null,amounts:null,reason});
    try {
      const m = await scope.read(()=>repository.runTransaction(async tx=>{
        const job = await tx.get('jobs',input.jobId);
        // No foreign metadata is inspected or projected, even on malformed input.
        demand(job?.ownerId === input.ownerId && job.jobId === input.jobId,'NOT_FOUND');
        const stored = job.publicManifest;
        demand(account(stored?.binding?.mandateId) && stored.ownerId === input.ownerId,'BINDING_MISMATCH');
        subject = {schemaVersion:'haldir.mandate-economics.v1',networkId:'testnet',ownerId:input.ownerId,mandateId:stored.binding.mandateId,source:{rpcUrl,method:'get_status',finality:'final'}};
        let sources, refs;
        try { sources = manifestSources(stored,input.ownerId,rpcUrl,urls); refs = jobSourceRefs(job); }
        catch { demand(false,'BINDING_MISMATCH'); }
        demand(equal(stored,input.manifest) && equal(job.scope,stored.approved.job) && job.qualification === 'PUBLIC_TESTNET_FICTIONAL_VENDOR' &&
          ['LOCAL_ACTIVE','LOCAL_STOPPED'].includes(job.state) && equal(refs,sources.map(({sourceId,quoteId})=>({sourceId,quoteId}))), 'BINDING_MISMATCH');
        const key = Buffer.from(JSON.stringify(['haldir-local-v1',job.scope.networkId,job.scope.mandateId])).toString('base64url');
        demand(equal(await tx.get('mandates',key),{networkId:'testnet',mandateId:job.scope.mandateId,ownerId:input.ownerId,jobId:input.jobId}),'BINDING_MISMATCH');
        for (const source of sources) {
          const q = await tx.get('quotes',source.quoteId), o = await tx.get('orders',source.quoteId);
          demand(q?.ownerId === input.ownerId && q.jobId === input.jobId && o?.jobId === input.jobId && o.quoteId === source.quoteId && o.orderId === source.quote.orderId &&
            quoteKey(source.quote) === source.quoteId && equal(q.quote,source.quote) && equal(o.quote,source.quote),'BINDING_MISMATCH');
        }
        return structuredClone(stored);
      }));
      const p = new StatusProvider(rpcUrl,transport,scope,m.binding.mandateId);
      const status = await p.viewNodeStatus(); demand(status?.chain_id === 'testnet' && status.sync_info?.syncing === false);
      const block = await p.viewBlock({finality:'final'}), h = block?.header;
      demand(hash(h?.hash) && Number.isSafeInteger(h.height) && h.height>0 && uint(h.timestamp_nanosec,64)); p.block=h;
      const started = now(); demand(Number.isSafeInteger(started) && started >= 0 && BigInt(h.timestamp_nanosec) <= BigInt(started)*1000000n);
      const query = async (request_type, extras={})=>{
        const result = await p.query({request_type,account_id:m.binding.mandateId,block_id:h.hash,...extras});
        demand(result?.block_hash === h.hash && result.block_height === h.height); return result;
      };
      const acct = await query('view_account'); demand(hash(acct.code_hash) && acct.code_hash === m.binding.codeHash,'BINDING_MISMATCH');
      const result = await query('call_function',{method_name:'get_status',args_base64:'e30='});
      demand(Array.isArray(result.result) && result.result.length <= 262144 && result.result.every(n=>Number.isInteger(n) && n>=0 && n<=255));
      const s = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(result.result))); validateStatus(s,m);
      const observedAt = now(); scope.fence(); demand(Number.isSafeInteger(observedAt) && observedAt>=started && BigInt(h.timestamp_nanosec)<=BigInt(observedAt)*1000000n);
      const stale = BigInt(observedAt)*1000000n - BigInt(h.timestamp_nanosec) > 30000000000n;
      return {...subject,state:stale?'stale':'known',observation:{blockHash:h.hash,blockHeight:h.height,blockTimestampNs:h.timestamp_nanosec,observedAt},
        amounts:{capAtomic:s.cap,spentAtomic:s.spent,reservedAtomic:s.reserved,availableAtomic:s.free,refundedAtomic:s.refunded},reason:stale?'STALE_BLOCK':null};
    } catch (error) {
      if (!subject || error.code === 'NOT_FOUND') throw Object.assign(new Error(error.code === 'NOT_FOUND'?'NOT_FOUND':'MANDATE_STATUS_UNAVAILABLE'),{code:error.code === 'NOT_FOUND'?'NOT_FOUND':'MANDATE_STATUS_UNAVAILABLE'});
      return unavailable(['BINDING_MISMATCH','NOT_DEPLOYED'].includes(error.code)?error.code:'RPC_UNAVAILABLE');
    } finally { scope.close(); }
  };
}
