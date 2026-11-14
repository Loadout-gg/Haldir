import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { JsonRpcProvider, baseDecode, baseEncode } from 'near-api-js';
import { approvedSources } from '../shared/job-contract.mjs';

const account = s => typeof s === 'string' && s.length >= 2 && s.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(s);
const hash = s => { try { return typeof s === 'string' && baseDecode(s).length === 32 && baseEncode(baseDecode(s)) === s; } catch { return false; } };
const decimal = (s, bits = 128, zero = false) => typeof s === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(s) && BigInt(s) < 2n ** BigInt(bits) && (zero || BigInt(s) > 0n);
export const OWNER_ACTION_GAS = '100000000000000';
function ownerTerms(m) {
  const scope = m?.approved?.job;
  demand(scope && Number.isSafeInteger(Date.parse(scope.expiresAt)));
  return {...m.creation,agent:m.binding.signerId,allowlist:scope.vendorIds,cap:scope.budgetAtomic,
    deadline_ns:String(BigInt(Date.parse(scope.expiresAt))*1000000n),stop_gas:OWNER_ACTION_GAS,withdraw_gas:OWNER_ACTION_GAS};
}
function terms(request, networkId, localTestOnly) {
  const { manifest: m, job, ownerId } = request, b = m?.binding, a = m?.approved;
  const named = s => account(s) && (localTestOnly || s.endsWith('.testnet') || /^[a-f0-9]{64}$/.test(s));
  demand(m && typeof m.manifestId === 'string' && m.ownerId === ownerId && b?.ownerId === ownerId && b.networkId === networkId &&
    named(ownerId) && named(b.mandateId) && hash(b.codeHash));
  const t = ownerTerms(m);
  demand(named(t.agent) && new Set([ownerId,t.agent,b.mandateId]).size === 3 &&
    Array.isArray(t.allowlist) && t.allowlist.length >= 1 && t.allowlist.length <= 4 && new Set(t.allowlist).size === t.allowlist.length &&
    t.allowlist.every(v => named(v) && ![ownerId,t.agent,b.mandateId].includes(v)) &&
    decimal(t.cap) && BigInt(t.cap) <= 100n * 10n ** 24n && decimal(t.deadline_ns,64));
  if(m.creation !== undefined) {
    demand(equal(Object.keys(m.creation).sort(),['factory','factoryCodeHash','job_label','operating_float','create_gas'].sort()) &&
      named(t.factory) && t.factory.length <= 30 && hash(t.factoryCodeHash) &&
      typeof t.job_label === 'string' && /^[a-z0-9_-]{1,32}$/.test(t.job_label) &&
      b.mandateId === 'j' + createHash('sha256').update(`${ownerId}:${t.job_label}`).digest('hex').slice(0,32) + '.' + t.factory &&
      decimal(t.operating_float) && BigInt(t.cap) + BigInt(t.operating_float) < 2n ** 128n &&
      decimal(t.create_gas,64) && BigInt(t.create_gas) <= 300000000000000n && BigInt(t.create_gas) >= 200000000000000n);
  } else demand(request.action!=='create');
  try { approvedSources(a); } catch { demand(false); }
  demand(equal(a.job, job.scope) && job.scope.networkId === networkId && job.scope.mandateId === b.mandateId);
}

const demand = (v, code = 'OWNER_BINDING_INVALID') => { if (!v) throw Object.assign(new Error(code), { code }); };
const opId = (jobId, action) => createHash('sha256').update(JSON.stringify(['haldir-owner-v1', jobId, action])).digest('hex');
function unsigned({ manifest: m, ownerId, action }) {
  const t = ownerTerms(m);
  return action === 'create' ? { network: m.binding.networkId, signerId: ownerId, receiverId: t.factory, methodName: 'create_job',
    args: { job_label: t.job_label, agent: t.agent, allowlist: [...t.allowlist], cap: t.cap, deadline_ns: t.deadline_ns, operating_float: t.operating_float },
    gas: t.create_gas, deposit: String(BigInt(t.cap) + BigInt(t.operating_float)) } :
    { network: m.binding.networkId, signerId: ownerId, receiverId: m.binding.mandateId, methodName: action, args: {}, gas: t[`${action}_gas`], deposit: '0' };
}

const variant = (v,k) => !!v && typeof v === 'object' && Object.keys(v).length === 1 && Object.hasOwn(v,k);
function decode(s) {
  demand(typeof s === 'string' && s.length <= 16384 && Buffer.from(s,'base64').toString('base64') === s);
  return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(s,'base64'));
}
const json = s => JSON.parse(decode(s));
const successful = s => variant(s,'SuccessValue') && typeof s.SuccessValue === 'string';
function graph(tx, records, expected) {
  demand(tx?.final_execution_status === 'FINAL' && tx.transaction?.hash === expected.transactionHash &&
    tx.transaction.signer_id === expected.ownerId && tx.transaction.receiver_id === expected.call.receiverId &&
    typeof tx.transaction.public_key === 'string' && tx.transaction.actions?.length === 1);
  const action = tx.transaction.actions[0], call = action?.FunctionCall;
  demand(variant(action,'FunctionCall') && call.method_name === expected.call.methodName && call.deposit === expected.call.deposit &&
    (Number.isSafeInteger(call.gas) ? String(call.gas) : call.gas) === expected.call.gas && equal(json(call.args),expected.call.args));
  const rows = new Map(), parents = new Map();
  for (const row of [tx.transaction_outcome,...tx.receipts_outcome]) {
    demand(hash(row?.id) && hash(row.block_hash) && !rows.has(row.id) && account(row.outcome?.executor_id) &&
      Array.isArray(row.outcome.receipt_ids) && (successful(row.outcome.status) || variant(row.outcome.status,'Failure') ||
        (variant(row.outcome.status,'SuccessReceiptId') && row.outcome.receipt_ids.includes(row.outcome.status.SuccessReceiptId))));
    rows.set(row.id,row);
  }
  const origin = tx.transaction_outcome;
  demand(origin?.id === tx.transaction.hash && origin.outcome.executor_id === expected.ownerId && origin.outcome.receipt_ids.length === 1 &&
    equal(origin.outcome.status,{SuccessReceiptId:origin.outcome.receipt_ids[0]}));
  const queue = [origin.id], visited = new Set(queue);
  for(let i=0;i<queue.length;i++) for(const child of rows.get(queue[i]).outcome.receipt_ids) {
    demand(rows.has(child) && !visited.has(child)); parents.set(child,queue[i]); visited.add(child); queue.push(child);
  }
  demand(visited.size === rows.size && records.length === rows.size - 1);
  const byId = new Map();
  for(const r of records) {
    const row = rows.get(r?.receipt_id), a = r?.receipt?.Action;
    demand(row && parents.has(r.receipt_id) && !byId.has(r.receipt_id) && variant(r.receipt,'Action') && Array.isArray(a?.actions) &&
      r.receiver_id === row.outcome.executor_id && a.signer_id === expected.ownerId && a.signer_public_key === tx.transaction.public_key &&
      Array.isArray(a.input_data_ids) && Array.isArray(a.output_data_receivers));
    if(r.predecessor_id === 'system') demand(r.receiver_id === expected.ownerId && a.actions.length === 1 && variant(a.actions[0],'Transfer') &&
      decimal(a.actions[0].Transfer.deposit) && a.input_data_ids.length === 0 && a.output_data_receivers.length === 0 &&
      row.outcome.receipt_ids.length === 0 && equal(row.outcome.status,{SuccessValue:''}));
    else demand(r.predecessor_id === rows.get(parents.get(r.receipt_id)).outcome.executor_id);
    byId.set(r.receipt_id,r);
  }
  const rootId = origin.outcome.receipt_ids[0], root = byId.get(rootId);
  demand(root?.predecessor_id === expected.ownerId && root.receiver_id === expected.call.receiverId &&
    equal(root.receipt.Action.actions,tx.transaction.actions) && root.receipt.Action.input_data_ids.length === 0);
  return {rows,parents,byId,rootId,root};
}
function withdrawProof(tx, g, request) {
  const {rows,parents,byId,rootId} = g, mandateId = request.manifest.binding.mandateId;
  demand(successful(tx.status) && json(tx.status.SuccessValue) === true && [...rows.values()].every(r => !variant(r.outcome.status,'Failure')));
  const transfers = [...byId.values()].filter(r => r.predecessor_id === mandateId && r.receipt.Action.actions.some(a => variant(a,'Transfer')));
  demand([...byId.values()].filter(r=>r.predecessor_id!=='system').length===3 && transfers.length === 1);
  const transfer = transfers[0], a = transfer.receipt.Action;
  demand(parents.get(transfer.receipt_id) === rootId && transfer.receiver_id === request.ownerId && a.actions.length === 1 &&
    variant(a.actions[0],'Transfer') && decimal(a.actions[0].Transfer.deposit) && BigInt(a.actions[0].Transfer.deposit) <= BigInt(ownerTerms(request.manifest).cap) &&
    equal(rows.get(transfer.receipt_id).outcome.status,{SuccessValue:''}) && a.input_data_ids.length === 0);
  const callbackId = rows.get(rootId).outcome.status.SuccessReceiptId, callback = byId.get(callbackId), ca = callback?.receipt.Action, c = ca?.actions?.[0]?.FunctionCall;
  const nonce = c && json(c.args);
  demand(callback && parents.get(callbackId) === rootId && callback.predecessor_id === mandateId && callback.receiver_id === mandateId &&
    ca.actions.length === 1 && variant(ca.actions[0],'FunctionCall') && c.method_name === 'on_refund' && c.deposit === '0' &&
    equal(Object.keys(nonce),['nonce']) && decimal(nonce.nonce,64) && successful(rows.get(callbackId).outcome.status) &&
    json(rows.get(callbackId).outcome.status.SuccessValue) === true && a.output_data_receivers.length === 1 &&
    a.output_data_receivers[0].receiver_id === mandateId && hash(a.output_data_receivers[0].data_id) &&
    equal(ca.input_data_ids,[a.output_data_receivers[0].data_id]));
  return {receiptId:transfer.receipt_id,amountAtomic:a.actions[0].Transfer.deposit};
}
function createProof(tx,g,request) {
  const {rows,parents,byId,rootId}=g, b=request.manifest.binding, t=ownerTerms(request.manifest);
  demand(successful(tx.status) && json(tx.status.SuccessValue) === true && [...rows.values()].every(r => !variant(r.outcome.status,'Failure')));
  const native=[...byId.values()].filter(r=>r.predecessor_id!=='system');
  demand(native.length===3);
  const deployment=native.find(r=>r.predecessor_id===t.factory && r.receiver_id===b.mandateId);
  const a=deployment?.receipt.Action, list=a?.actions;
  demand(deployment && parents.get(deployment.receipt_id)===rootId && list.length===4 && list[0]==='CreateAccount' &&
    variant(list[1],'Transfer') && list[1].Transfer.deposit===t.operating_float && variant(list[2],'DeployContract') &&
    // ReceiptView DeployContract.code is base64 SHA-256, NOT WASM bytes (2.14.0).
    // Actual bytes are independently checked via pinned final view_code below.
    typeof list[2].DeployContract?.code==='string' && Buffer.from(list[2].DeployContract.code,'base64').length===32 &&
    baseEncode(Buffer.from(list[2].DeployContract.code,'base64'))===b.codeHash &&
    variant(list[3],'FunctionCall') && list[3].FunctionCall.method_name==='new_from_factory' && list[3].FunctionCall.deposit===t.cap &&
    equal(json(list[3].FunctionCall.args),{owner:request.ownerId,agent:t.agent,allowlist:t.allowlist,cap:t.cap,deadline_ns:t.deadline_ns}) &&
    equal(rows.get(deployment.receipt_id).outcome.status,{SuccessValue:''}) && a.input_data_ids.length===0);
  const callbackId=rows.get(rootId).outcome.status.SuccessReceiptId, callback=byId.get(callbackId), ca=callback?.receipt.Action, c=ca?.actions?.[0]?.FunctionCall;
  demand(callback && parents.get(callbackId)===rootId && callback.receiver_id===t.factory && callback.predecessor_id===t.factory &&
    ca.actions.length===1 && variant(ca.actions[0],'FunctionCall') && c.method_name==='on_create' && c.deposit==='0' && equal(json(c.args),{job:b.mandateId}) &&
    successful(rows.get(callbackId).outcome.status) && json(rows.get(callbackId).outcome.status.SuccessValue)===true &&
    a.output_data_receivers.length===1 && a.output_data_receivers[0].receiver_id===t.factory && hash(a.output_data_receivers[0].data_id) &&
    equal(ca.input_data_ids,[a.output_data_receivers[0].data_id]));
  return {receiptId:deployment.receipt_id};
}
function stopProof(tx,g,state) {
  demand(equal(tx.status,{SuccessValue:''}) && equal(g.rows.get(g.rootId).outcome.status,{SuccessValue:''}) && state.stopped===true &&
    [...g.byId.values()].filter(r=>r.predecessor_id!=='system').length===1);
  return {receiptId:g.rootId};
}
function deadline(timeoutMs, signal) {
  const controller = new AbortController(), until = performance.now()+timeoutMs;
  const timer = setTimeout(() => controller.abort(new Error('OWNER_READ_TIMEOUT')),timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  if(signal?.aborted) onAbort(); else signal?.addEventListener('abort',onAbort,{once:true});
  const expired = new Promise((_,reject) => {
    if(controller.signal.aborted) reject(controller.signal.reason);
    else controller.signal.addEventListener('abort',() => reject(controller.signal.reason),{once:true});
  });
  expired.catch(() => {});
  return {signal:controller.signal,check(){demand(performance.now()<until && !controller.signal.aborted,'OWNER_READ_TIMEOUT');},
    async read(fn){this.check(); const value = await Promise.race([Promise.resolve().then(fn),expired]); this.check(); return value;},
    close(){clearTimeout(timer);signal?.removeEventListener('abort',onAbort);} };
}

// Retain the installed SDK read parameter mapping, replace only its transport.
// Default SDK fetch redirects/retries and omits the shared cancellation boundary.
class OwnerReader extends JsonRpcProvider {
  constructor(url,clock,maxResponseBytes) { super({url},{retries:1}); this.clock=clock; this.maxResponseBytes=maxResponseBytes; this.sequence=0; }
  async sendJsonRpc(method,params) {
    demand(['status','EXPERIMENTAL_tx_status','EXPERIMENTAL_receipt','block','query'].includes(method),'READ_ONLY_RPC');
    const id=String(++this.sequence);
    // Cancel even a response arriving on/after the monotonic deadline. The
    // outer clock can reject before assigning the returned Response locally.
    const pending=fetch(this.connection.url,{method:'POST',redirect:'error',signal:this.clock.signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
    let response;
    try {response=await this.clock.read(()=>pending);}
    catch(error) {pending.then(r=>r.body?.cancel()).catch(()=>{});throw error;}
    const size=response.headers.get('content-length');
    if(!response.ok || response.redirected || !response.body ||
      !(size===null || (/^[0-9]+$/.test(size) && Number(size)<=this.maxResponseBytes))) {
      if(response.body) await this.clock.read(()=>response.body.cancel());
      demand(false,'RPC_UNAVAILABLE');
    }
    const reader=response.body.getReader(), chunks=[]; let total=0;
    try {
      for(;;) {
        const {value,done}=await this.clock.read(()=>reader.read());
        if(done) break;
        total+=value.byteLength; demand(total<=this.maxResponseBytes,'RPC_RESPONSE_LIMIT'); chunks.push(Buffer.from(value));
      }
    } catch(error) { reader.cancel().catch(()=>{}); throw error; }
    finally {reader.releaseLock();}
    const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,total)));
    demand(payload?.jsonrpc==='2.0' && payload.id===id && !Object.hasOwn(payload,'error') && Object.hasOwn(payload,'result'),'RPC_UNAVAILABLE');
    return payload.result;
  }
}

/** Trusted persisted snapshots only; no signing, mutation or broadcast port. */
export function createNearOwnerOperations({ repository, rpcUrl, allowedRpcUrls, timeoutMs = 10000, maxReceipts = 64,
  maxResponseBytes = 4194304, localTestOnly = false, provider: injected, networkId = 'testnet' } = {}) {
  let url; try { url = new URL(rpcUrl); } catch { /* reject invalid config */ }
  demand(typeof repository?.runTransaction === 'function' && typeof localTestOnly === 'boolean' && url &&
    !url.username && !url.password && !url.search && !url.hash &&
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000 &&
    Number.isSafeInteger(maxReceipts) && maxReceipts >= 1 && maxReceipts <= 256 &&
    Number.isSafeInteger(maxResponseBytes) && maxResponseBytes >= 1024 && maxResponseBytes <= 16777216 &&
    (localTestOnly ? injected && typeof networkId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(networkId) &&
      !['testnet','mainnet'].includes(networkId) && url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname) :
      !injected && networkId === 'testnet' && url.protocol === 'https:' && Array.isArray(allowedRpcUrls) && allowedRpcUrls.includes(rpcUrl)),
    'RPC_CONFIGURATION_INVALID');
  async function bound(input) {
    const { signal, ...rest } = input;
    signal?.throwIfAborted();
    const request = structuredClone(rest);
    const { job, manifest, ownerId, action, operationId } = request;
    demand(['create','stop','withdraw'].includes(action) && job?.jobId && operationId === opId(job.jobId, action));
    await repository.runTransaction(async tx => {
      const stored = await tx.get('jobs', job.jobId), row = await tx.get('ownerOperations', operationId);
      demand(stored?.ownerId === ownerId && equal(stored.publicManifest, manifest) && equal(stored.scope, job.scope) &&
        job.ownerId === ownerId && equal(job.publicManifest, manifest) && row?.operationId === operationId &&
        row.jobId === job.jobId && row.ownerId === ownerId && row.action === action);
      if (Object.hasOwn(request,'transactionHash')) demand(row.transactionHash === request.transactionHash && request.signerId === ownerId &&
        equal(row.request,unsigned(request)));
    });
    terms(request, networkId, localTestOnly);
    signal?.throwIfAborted();
    return request;
  }
  async function reconcile(input) {
    const clock = deadline(timeoutMs,input?.signal);
    const observation = {networkId,ownerId:input?.ownerId,mandateId:input?.manifest?.binding?.mandateId,action:input?.action,
      transactionHash:input?.transactionHash,signerId:input?.signerId,finality:'unknown',status:'UNKNOWN'};
    try {
      const request = await clock.read(() => bound(input)), call = unsigned(request);
      demand(hash(request.transactionHash) && request.signerId === request.ownerId);
      const p = injected ?? new OwnerReader(rpcUrl,clock,maxResponseBytes);
      const status = await clock.read(() => p.viewNodeStatus());
      demand(status?.chain_id === networkId && status.sync_info?.syncing === false);
      const tx = await clock.read(() => p.viewTransactionStatusWithReceipts({txHash:request.transactionHash,accountId:request.ownerId,waitUntil:'FINAL'}));
      demand(Array.isArray(tx?.receipts_outcome) && tx.receipts_outcome.length <= maxReceipts);
      const receipts = [];
      for(const row of tx.receipts_outcome) receipts.push(await clock.read(() => p.viewTransactionReceipt(row.id)));
      const g = graph(tx,receipts,{...request,call});
      const head = (await clock.read(() => p.viewBlock({finality:'final'})))?.header;
      demand(hash(head?.hash) && Number.isSafeInteger(head.height));
      for(const blockId of new Set([...g.rows.values()].map(r => r.block_hash))) {
        const block = (await clock.read(() => p.viewBlock({blockId})))?.header;
        demand(block?.hash === blockId && Number.isSafeInteger(block.height) && block.height <= head.height);
      }
      const query = async params => {
        const value = await clock.read(() => p.query({...params,block_id:head.hash}));
        demand(value?.block_hash === head.hash && value.block_height === head.height); return value;
      };
      const b = request.manifest.binding, t = ownerTerms(request.manifest);
      const pinned = async (accountId,codeHash) => {
        const code=await query({request_type:'view_code',account_id:accountId});
        const keys=await query({request_type:'view_access_key_list',account_id:accountId});
        demand(code.hash===codeHash && typeof code.code_base64==='string' &&
          baseEncode(createHash('sha256').update(Buffer.from(code.code_base64,'base64')).digest())===codeHash && equal(keys.keys,[]) && keys.last_key == null);
      };
      await pinned(call.receiverId,request.action==='create'?t.factoryCodeHash:b.codeHash);
      // Only an exact root invocation failure with no dispatched non-system
      // descendants establishes FAILED. Transfer/callback ambiguity is UNKNOWN.
      if(variant(tx.status,'Failure') && equal(tx.status,g.rows.get(g.rootId).outcome.status) &&
        [...g.byId.values()].filter(r=>r.predecessor_id!=='system').length===1) {
        await clock.read(()=>bound(input)); clock.check();
        return {...observation,finality:'final',status:'FAILED',receiptId:g.rootId};
      }
      if(request.action==='create') await pinned(b.mandateId,b.codeHash);
      const view = await query({request_type:'call_function',account_id:b.mandateId,method_name:'get_status',args_base64:'e30='});
      demand(Array.isArray(view.result) && view.result.length <= 65536 && view.result.every(v => Number.isInteger(v) && v>=0 && v<=255));
      const state = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(view.result)));
      demand(state.owner === request.ownerId && state.agent === t.agent && equal(state.allowlist,t.allowlist) && state.cap === t.cap && state.deadline_ns === t.deadline_ns);
      let proof;
      if(request.action==='create') {
        const entryView=await query({request_type:'call_function',account_id:t.factory,method_name:'get_entry',
          args_base64:Buffer.from(JSON.stringify({owner:request.ownerId,job_label:t.job_label})).toString('base64')});
        demand(Array.isArray(entryView.result) && entryView.result.length<=4096);
        const entry=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(entryView.result)));
        demand(equal(entry,{job:b.mandateId,owner:request.ownerId,amount:call.deposit,state:'ready'}));
        proof=createProof(tx,g,request);
      } else if(request.action==='stop') proof=stopProof(tx,g,state);
      else proof=withdrawProof(tx,g,request);
      await clock.read(() => bound(input)); clock.check();
      return {...observation,finality:'final',status:'CONFIRMED',...proof};
    } catch { return observation; }
    finally {clock.close();}
  }
  return Object.freeze({ async prepare(input) {
    const clock = deadline(timeoutMs,input?.signal);
    try {const request = await clock.read(() => bound(input)); clock.check(); return unsigned(request);} finally {clock.close();}
  }, reconcile });
}
