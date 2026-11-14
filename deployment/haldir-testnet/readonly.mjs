import { JsonRpcProvider } from 'near-api-js';
export const RPC = 'https://rpc.testnet.near.org';
export const GENESIS = 'FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b';
// No broadcaster is allowed through this transport, even with signed bytes.
export class ReadOnlyProvider extends JsonRpcProvider {
  constructor(url = RPC, { localTestOnly = false } = {}) {
    const u = new URL(url);
    if (!(url === RPC || (localTestOnly === true && u.protocol === 'http:' && u.hostname === '127.0.0.1')))
      throw new Error('RPC_CONFIGURATION');
    super({ url }, { retries: 1 }); this.seq = 0;
  }
  async sendJsonRpc(method, params) {
    if (!['status','query','block','gas_price','EXPERIMENTAL_protocol_config','EXPERIMENTAL_tx_status'].includes(method)) throw new Error('READ_ONLY_RPC');
    const id = String(++this.seq);
    const r = await fetch(this.connection.url, { method:'POST', redirect:'error', signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}) });
    if (!r.ok) throw new Error('RPC_HTTP');
    const text = await r.text(); if (text.length > 4_000_000) throw new Error('RPC_BODY');
    const v = JSON.parse(text);
    if (v?.id !== id || v.jsonrpc !== '2.0') throw new Error('RPC_ENVELOPE');
    if (v.error) {
      if (v.error?.cause?.name === 'UNKNOWN_ACCOUNT' || v.error?.data?.includes?.('does not exist')) throw new Error('UNKNOWN_ACCOUNT');
      throw new Error('RPC_QUERY_FAILED');
    }
    return v.result;
  }
}
export async function snapshot(provider, localChain = null) {
  const s = await provider.sendJsonRpc('status', []);
  if (s.sync_info?.syncing !== false || (localChain ? s.chain_id !== localChain : s.chain_id !== 'testnet' || s.genesis_hash !== GENESIS)) throw new Error('CHAIN');
  const b = await provider.sendJsonRpc('block', {finality:'final'});
  const c = await provider.sendJsonRpc('EXPERIMENTAL_protocol_config', {block_id:b.header.hash});
  const g = await provider.sendJsonRpc('gas_price', [b.header.hash]);
  return { chain_id:s.chain_id, genesis_hash:s.genesis_hash, rpc:provider.connection.url,
    block_hash:b.header.hash, block_height:b.header.height, timestamp_nanosec:b.header.timestamp_nanosec,
    protocol_version:c.protocol_version, storage_amount_per_byte:c.runtime_config.storage_amount_per_byte,
    account_overhead:c.runtime_config.transaction_costs.storage_usage_config.num_bytes_account,
    record_overhead:c.runtime_config.transaction_costs.storage_usage_config.num_extra_bytes_record,
    gas_price:g.gas_price, min_gas_purchase_price:c.runtime_config.min_gas_purchase_price,
    account_creation_charge:c.runtime_config.account_creation_charge,
    node_version:s.version.version, observed_at:new Date().toISOString(),
    protocol_config:c };
}
export const query = (p, account_id, request_type, extras={}) => p.sendJsonRpc('query',{request_type,account_id,finality:'final',...extras});
export async function maybeAccount(p, id) { try { return await query(p,id,'view_account'); } catch(e) { if(e.message === 'UNKNOWN_ACCOUNT') return null; throw e; } }
