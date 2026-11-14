import { approvedSources } from '../shared/job-contract.mjs';
import { isDeepStrictEqual as equal } from 'node:util';
import { JsonRpcProvider, baseEncode, baseDecode } from 'near-api-js';
import { validatePublicManifest } from './orders.mjs';
import { prepareCreateJob } from '../../qualification/native-wallet/request.mjs';
import { PINS } from '../../deployment/haldir-testnet/manifest.mjs';

const demand = (v, code = 'MANIFEST_UNAVAILABLE') => { if (!v) throw Object.assign(new Error(code), { code }); };
const exact = (v, fields) => v && typeof v === 'object' && !Array.isArray(v) && equal(Object.keys(v).sort(), fields.split(' ').sort());
const account = v => typeof v === 'string' && v.length >= 2 && v.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v);
const token = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
const dec = (v, zero = false) => typeof v === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(v) && BigInt(v) < 2n**128n && (zero || BigInt(v) > 0n);
const hash = v => { try { return typeof v === 'string' && baseDecode(v).length === 32 && baseEncode(baseDecode(v)) === v; } catch { return false; } };
const https = v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && (v === u.origin || v === `${u.origin}/`); } catch { return false; } };
const pinnedHash = name => baseEncode(Buffer.from(PINS[name], 'hex'));

// One monotonic deadline covers store, every RPC/body, and final validation.
function boundedScope(timeoutMs, external) {
  const controller = new AbortController(), end = performance.now() + timeoutMs;
  let reject, timer;
  const expired = new Promise((_, r) => { reject = r; }); expired.catch(() => {});
  const abort = () => { controller.abort(); reject(new Error('MANIFEST_UNAVAILABLE')); };
  external?.addEventListener('abort', abort, { once: true });
  timer = setTimeout(abort, timeoutMs);
  const fence = () => demand(!external?.aborted && !controller.signal.aborted && performance.now() < end);
  return { signal: controller.signal, fence,
    async read(fn) { fence(); const v = await Promise.race([Promise.resolve().then(() => { fence(); return fn(); }), expired]); fence(); return v; },
    close() { clearTimeout(timer); external?.removeEventListener('abort', abort); controller.abort(); } };
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

// Installed SDK supplies query/block/gas parameter construction. No SDK
// fetch fallback, retries, redirects, arbitrary methods, signing or broadcaster.
class ManifestProvider extends JsonRpcProvider {
  constructor(url, transport, scope) { super({ url }, { retries: 1 }); this.transport = transport; this.scope = scope; this.seq = 0; this.block = null; this.child = null; }
  async sendJsonRpc(method, params) {
    // Match actual JSON wire semantics (SDK includes undefined block_id).
    params = JSON.parse(JSON.stringify(params));
    demand((method === 'status' && equal(params, [])) || (method === 'block' && equal(params, { finality: 'final' })) ||
      (method === 'gas_price' && this.block && equal(params, [this.block.hash])) ||
      (method === 'EXPERIMENTAL_protocol_config' && this.block && equal(params, { block_id: this.block.hash })) ||
      (method === 'query' && this.block && params.block_id === this.block.hash && !Object.hasOwn(params, 'finality') && account(params.account_id) &&
        ((['view_account', 'view_access_key_list'].includes(params.request_type) && exact(params, 'request_type account_id block_id')) ||
          (params.request_type === 'view_state' && exact(params, 'request_type account_id block_id prefix_base64') && params.prefix_base64 === 'U1RBVEU=') ||
          (params.request_type === 'call_function' && exact(params, 'request_type account_id block_id method_name args_base64') &&
            ['get_status', 'job_id', 'get_entry'].includes(params.method_name)))), 'RPC_METHOD_DENIED');
    const id = String(++this.seq);
    const payload = await this.scope.read(async () => boundedJson(await this.transport(this.connection.url,
      { method: 'POST', redirect: 'error', signal: this.scope.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }), this.scope.signal));
    demand(payload?.jsonrpc === '2.0' && payload.id === id && (Object.hasOwn(payload, 'result') !== Object.hasOwn(payload, 'error')));
    if (Object.hasOwn(payload, 'error')) {
      const e = payload.error, info = e?.cause?.info;
      // Absence is authoritative ONLY for this exact child, query and block.
      // Free text, timeout, UNKNOWN_BLOCK and unavailable nodes are NOT absence.
      if (method === 'query' && params.request_type === 'view_account' && params.account_id === this.child &&
          e?.name === 'HANDLER_ERROR' && e.cause?.name === 'UNKNOWN_ACCOUNT' && info?.requested_account_id === this.child &&
          info.block_hash === this.block.hash && info.block_height === this.block.height)
        throw Object.assign(new Error('CHILD_ABSENT'), { code: 'CHILD_ABSENT' });
      demand(false);
    }
    return payload.result;
  }
}
function factoryState(result) {
  demand(Array.isArray(result.values) && result.values.length === 1 && result.values[0].key === 'U1RBVEU=' && result.last_key == null);
  const encoded = result.values[0].value;
  demand(typeof encoded === 'string' && Buffer.from(encoded, 'base64').toString('base64') === encoded);
  const bytes = Buffer.from(encoded, 'base64'); let at = 0;
  const u32 = () => { demand(at + 4 <= bytes.length); const v = bytes.readUInt32LE(at); at += 4; return v; };
  const string = () => { const n = u32(); demand(n <= 64 && at+n <= bytes.length); const v = new TextDecoder('utf-8', {fatal:true}).decode(bytes.subarray(at, at+n)); at += n; return v; };
  const count = u32(); demand(count <= 256); const entries = [];
  for (let i=0;i<count;i++) {
    const job = string(), owner = string(); demand(account(job) && account(owner) && at+16 <= bytes.length);
    const amount = String(bytes.readBigUInt64LE(at) + (bytes.readBigUInt64LE(at+8)<<64n)); at += 16;
    const state = string(); demand(dec(amount) && ['creating','ready','credit','refunding','refunded'].includes(state));
    entries.push({job,owner,amount,state});
  }
  const maxJobs = u32(); demand(at === bytes.length && maxJobs >= 1 && maxJobs <= 256 && count <= maxJobs && new Set(entries.map(e => e.job)).size === count);
  return { entries, maxJobs };
}

/** Server-only authority. Store is independently operator approved, indexed by
 * exact ownerId+approvalId. Never inject browser/model terms into this port.
 * Returns observed phase, not an instruction to deploy or permission to pay.
 */
export function createNearManifestProvider({ trustedApprovalStore, rpcUrl, allowedRpcUrls,
  transport = globalThis.fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  demand(typeof trustedApprovalStore?.get === 'function' && typeof transport === 'function' && typeof now === 'function' &&
    https(rpcUrl) && Array.isArray(allowedRpcUrls) && allowedRpcUrls.length >= 1 && allowedRpcUrls.length <= 4 &&
    allowedRpcUrls.every(https) && allowedRpcUrls.includes(rpcUrl) && !allowedRpcUrls.some(u => new URL(u).hostname.includes('mainnet')) &&
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000, 'MANIFEST_CONFIGURATION_INVALID');
  const urls = structuredClone(allowedRpcUrls);
  return async input => {
    demand((exact(input, 'ownerId approvalId') || exact(input, 'ownerId approvalId signal')) && account(input.ownerId) && token(input.approvalId) &&
      (input.signal === undefined || input.signal instanceof AbortSignal), 'MANIFEST_SUBJECT_INVALID');
    const scope = boundedScope(timeoutMs, input.signal);
    try {
      const m = structuredClone(await scope.read(() => trustedApprovalStore.get({ ownerId: input.ownerId, approvalId: input.approvalId, signal: scope.signal })));
      demand((exact(m, 'manifestId ownerId approved binding rpcUrl allowedRpcUrls') || exact(m, 'manifestId ownerId approved binding rpcUrl allowedRpcUrls creation')) &&
        m.ownerId === input.ownerId && m.binding?.ownerId === input.ownerId && m.binding.networkId === 'testnet' && m.approved?.job?.networkId === 'testnet' &&
        m.rpcUrl === rpcUrl && equal(m.allowedRpcUrls, urls) && account(m.binding.signerId) && account(m.binding.mandateId) &&
        m.binding.codeHash === pinnedHash('mandate') && dec(m.binding.maxAllowanceAtomic));
      const sources = approvedSources(m.approved);
      const total = sources.reduce((n,s)=>n+BigInt(s.quote.amountAtomic),0n);
      const b = m.binding, j = m.approved.job, c = m.creation;
      const deadline = String(BigInt(Date.parse(j.expiresAt))*1000000n);
      if (c) {
        demand(exact(c, 'factory job_label operating_float create_gas factoryCodeHash') && c.factoryCodeHash === pinnedHash('factory'));
        prepareCreateJob({ network: 'testnet', owner: m.ownerId, agent: b.signerId, mandate: b.mandateId,
          allowlist: j.vendorIds, cap: j.budgetAtomic, deadline_ns: deadline, ...c });
      }
      const p = new ManifestProvider(rpcUrl, transport, scope); p.child = b.mandateId;
      const status = await p.viewNodeStatus(); demand(status?.chain_id === 'testnet' && status.sync_info?.syncing === false);
      const block = await p.viewBlock({ finality: 'final' });
      demand(hash(block?.header?.hash) && Number.isSafeInteger(block.header.height) && block.header.height > 0 && dec(block.header.timestamp_nanosec));
      p.block = block.header;
      const clock = now(), timestamp = BigInt(block.header.timestamp_nanosec);
      demand(Number.isSafeInteger(clock) && timestamp <= BigInt(clock)*1000000n && BigInt(clock)*1000000n - timestamp <= 30000000000n &&
        BigInt(deadline) > BigInt(clock)*1000000n && BigInt(deadline) - timestamp <= 7n*24n*3600n*1000000000n);
      const protocol = await p.sendJsonRpc('EXPERIMENTAL_protocol_config', { block_id: block.header.hash });
      const r = protocol?.runtime_config, storage = r?.transaction_costs?.storage_usage_config;
      demand(protocol?.chain_id === 'testnet' && protocol.protocol_version === 88 && r?.storage_amount_per_byte === '10000000000000000000' &&
        storage?.num_bytes_account === 100 && storage.num_extra_bytes_record === 40 && dec(r.min_gas_purchase_price) && dec(r.account_creation_charge));
      const gas = await p.viewGasPrice(block.header.hash); demand(dec(gas?.gas_price));
      const gasPrice = BigInt(gas.gas_price) > BigInt(r.min_gas_purchase_price) ? BigInt(gas.gas_price) : BigInt(r.min_gas_purchase_price);
      const reserve = 300000000000000n * gasPrice * 2n, price = BigInt(r.storage_amount_per_byte);
      const checked = value => { demand(value?.block_hash === block.header.hash && value.block_height === block.header.height); return value; };
      const query = async (id, type, extras = {}) => checked(await p.query({ request_type: type, account_id: id, block_id: block.header.hash, ...extras }));
      const view = async (id, method, args) => {
        const v = await query(id, 'call_function', {method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
        demand(Array.isArray(v.result) && v.result.every(n => Number.isInteger(n) && n >= 0 && n <= 255));
        return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(v.result)));
      };
      const acct = async id => {
        const a = await query(id, 'view_account');
        demand(dec(a.amount, true) && a.locked === '0' && Number.isSafeInteger(a.storage_usage) && a.storage_usage >= 0 && hash(a.code_hash)); return a;
      };
      const keyless = async id => { const k = await query(id, 'view_access_key_list'); demand(Array.isArray(k.keys) && k.keys.length === 0 && k.last_key == null); };
      const agent = await acct(b.signerId);
      // SDK viewAccessKeyList ignores blockId; use its generic query for an
      // actual hash-pinned complete key set rather than a second final head.
      const keys = await query(b.signerId, 'view_access_key_list');
      const k = keys?.keys?.[0], permission = k?.access_key?.permission?.FunctionCall;
      demand(keys.keys?.length === 1 && keys.last_key == null && k.public_key === b.publicKey && exact(k.access_key.permission, 'FunctionCall') &&
        exact(permission, 'receiver_id method_names allowance') && permission.receiver_id === b.mandateId && equal(permission.method_names, ['pay']) &&
        dec(permission.allowance) && BigInt(permission.allowance) <= BigInt(b.maxAllowanceAtomic) && BigInt(permission.allowance) >= reserve &&
        BigInt(agent.amount) >= BigInt(agent.storage_usage)*price + BigInt(permission.allowance));
      let child = null;
      try { child = await acct(b.mandateId); } catch (error) { if (error.code !== 'CHILD_ABSENT') throw error; }
      demand(child !== null || (c && permission.allowance === b.maxAllowanceAtomic));
      if (c) {
        const factory = await acct(c.factory); demand(factory.code_hash === c.factoryCodeHash); await keyless(c.factory);
        const fs = factoryState(await query(c.factory, 'view_state', {prefix_base64:'U1RBVEU='}));
        const expectedEntry = child ? {job:b.mandateId,owner:m.ownerId,amount:String(BigInt(j.budgetAtomic)+BigInt(c.operating_float)),state:'ready'} : null;
        demand(child ? equal(fs.entries.find(e => e.job === b.mandateId), expectedEntry) :
          fs.entries.length < fs.maxJobs && !fs.entries.some(e => e.job === b.mandateId));
        demand(BigInt(factory.amount) >= BigInt(Math.max(factory.storage_usage, 281701+100+45+8+fs.maxJobs*165))*price + reserve + BigInt(r.account_creation_charge));
        demand(await view(c.factory, 'job_id', {owner:m.ownerId,job_label:c.job_label}) === b.mandateId);
        demand(equal(await view(c.factory, 'get_entry', {owner:m.ownerId,job_label:c.job_label}), expectedEntry));
      }
      // Borsh storage upper bounds are qualified only for the pinned child code.
      const str = a => 4 + Buffer.byteLength(a);
      const stateBytes = str(m.ownerId)+str(b.signerId)+4+j.vendorIds.reduce((n,a)=>n+str(a),0)+16+8+16+16+1+4+1+8;
      const growth = 16*(89+Math.max(...j.vendorIds.map(a=>Buffer.byteLength(a))))+85;
      const childStorage = BigInt(143894+100+45+stateBytes+growth)*price;
      if (c) demand(BigInt(c.operating_float) >= childStorage);
      if (child) {
        demand(child.code_hash === b.codeHash); await keyless(b.mandateId);
        const state = await view(b.mandateId, 'get_status', {});
        demand(state.owner === m.ownerId && state.agent === b.signerId && state.cap === j.budgetAtomic && equal(state.allowlist,j.vendorIds) &&
          state.deadline_ns === deadline && state.stopped === false && state.expired === false && state.in_flight === null &&
          ['spent','reserved','refunded','free'].every(k => dec(state[k],true)) && state.reserved === '0' &&
          BigInt(state.spent)+BigInt(state.refunded)+BigInt(state.free) === BigInt(j.budgetAtomic) &&
          Array.isArray(state.orders) && state.orders.length + sources.length <= 16 && !state.orders.some(o => sources.some(s => o.order_id === s.quote.orderId)) &&
          BigInt(state.free) >= total &&
          BigInt(child.amount) >= BigInt(state.free)+childStorage);
      } else {
        const owner = await acct(m.ownerId);
        demand(BigInt(owner.amount) >= BigInt(owner.storage_usage)*price + BigInt(j.budgetAtomic)+BigInt(c.operating_float)+reserve+BigInt(r.account_creation_charge));
      }
      for (const vendor of j.vendorIds) await acct(vendor);
      const observedAt = now(); scope.fence();
      demand(Number.isSafeInteger(observedAt) && observedAt >= clock && observedAt - clock <= 30000 &&
        BigInt(observedAt)*1000000n - timestamp <= 30000000000n && BigInt(deadline) > BigInt(observedAt)*1000000n);
      return validatePublicManifest({ ...m, chainEvidence: { networkId: 'testnet', finality: 'final', blockHash: block.header.hash,
        blockHeight: block.header.height, observedAt, deployment: child ? 'MANDATE_READY' : 'FACTORY_READY' } }, input.ownerId, observedAt);
    } catch { throw Object.assign(new Error('MANIFEST_UNAVAILABLE'), { code: 'MANIFEST_UNAVAILABLE' }); }
    finally { scope.close(); }
  };
}
