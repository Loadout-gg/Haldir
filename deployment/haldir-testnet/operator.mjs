import { open, readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { createTransaction, baseDecode, baseEncode } from 'near-api-js';
import { compileManifest, manifestHash, sdkActions, digest } from './manifest.mjs';
import { RPC, ReadOnlyProvider, snapshot, query, maybeAccount } from './readonly.mjs';
const requireValue = (v,c) => { if(!v) throw new Error(c); };
const ROOT = resolve(new URL('../..',import.meta.url).pathname);
export function authorize(manifest, approval, step, now=Date.now()) {
  requireValue(approval?.public_writes === true && typeof approval.manifest_sha256 === 'string', 'APPROVAL_REQUIRED');
  requireValue(equal(Object.keys(approval).sort(),['allowed_steps','expires_at','manifest_sha256','max_total_outlay','public_writes']) &&
    approval.manifest_sha256 === manifestHash(manifest) && approval.max_total_outlay === manifest.spec.max_total_outlay &&
    Array.isArray(approval.allowed_steps) && approval.allowed_steps.includes(step) &&
    approval.allowed_steps.every(k=>['factory_create','factory_finalize','agent_create'].includes(k)) &&
    Number.isFinite(Date.parse(approval.expires_at)) && Date.parse(approval.expires_at)>now && Date.parse(approval.expires_at)<=now+8*3600*1000,
    'APPROVAL_MISMATCH');
}
async function keyList(p,id) {
  const r=await query(p,id,'view_access_key_list');
  requireValue(Array.isArray(r.keys) && r.last_key == null && typeof r.block_hash === 'string','INCOMPLETE_KEYS'); return r.keys;
}
async function exactKeys(p,id,expected) {
  const k=await keyList(p,id);
  requireValue(k.length === expected.length && k.every((a,i)=>a.public_key === expected[i].public_key && equal(a.access_key.permission,expected[i].permission)), 'KEYSET_MISMATCH'); return k;
}
const fullKey = m => [{public_key:m.spec.bootstrap_public_key,permission:'FullAccess'}];
const agentKey = m => [{public_key:m.spec.agent_public_key,permission:{FunctionCall:{receiver_id:m.mandate,method_names:['pay'],allowance:m.spec.allowance}}}];
async function assertFactory(p,m) {
  const a=await query(p,m.spec.factory,'view_account');
  requireValue(a.code_hash === m.artifacts.factory.code_hash,'FACTORY_CODE');
  await exactKeys(p,m.spec.factory,[]);
  requireValue(BigInt(a.amount) >= BigInt(m.budget.factory_minimum_storage),'FACTORY_SOLVENCY');
  return a;
}
export async function inspect(m,p,{childRequired=false}={}) {
  const result={factory:await assertFactory(p,m),agent:await query(p,m.spec.agent,'view_account')};
  result.agentKeys=await exactKeys(p,m.spec.agent,agentKey(m));
  requireValue(BigInt(result.agent.amount) >= BigInt(result.agent.storage_usage)*BigInt(m.protocol.storage_amount_per_byte)+BigInt(m.spec.allowance),'AGENT_SOLVENCY');
  result.child=await maybeAccount(p,m.mandate);
  if(!result.child) { requireValue(!childRequired,'CHILD_NOT_CREATED'); return result; }
  requireValue(result.child.code_hash===m.artifacts.mandate.code_hash,'CHILD_CODE');
  result.childKeys=await exactKeys(p,m.mandate,[]);
  const view=async(id,method,args)=>{const r=await query(p,id,'call_function',{method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});return JSON.parse(Buffer.from(r.result).toString());};
  result.entry=await view(m.spec.factory,'get_entry',{owner:m.spec.owner,job_label:m.spec.job_label});
  requireValue(equal(result.entry,{job:m.mandate,owner:m.spec.owner,amount:String(BigInt(m.spec.cap)+BigInt(m.spec.operating_float)),state:'ready'}),'ENTRY_NOT_READY');
  result.status=await view(m.mandate,'get_status',{});
  const s=result.status;
  requireValue(s.owner===m.spec.owner && s.agent===m.spec.agent && equal(s.allowlist,m.spec.allowlist) && s.cap===m.spec.cap && s.deadline_ns===m.spec.deadline_ns,'CHILD_SCOPE');
  requireValue(s.spent==='0' && s.refunded==='0' && s.reserved==='0' && s.free===m.spec.cap && s.stopped===false && s.expired===false && s.orders.length===0 && s.in_flight===null,'NOT_FRESH_MANDATE');
  requireValue(BigInt(result.child.amount)-BigInt(s.free)>=BigInt(m.budget.child_minimum_float),'CHILD_SOLVENCY');
  return result;
}
export async function executeStep({manifest:m,approval,step:kind,signer,bytes,journalPath,provider,
  localTestOnly=false,localChain=null}) {
  authorize(m,approval,kind); // Gate BEFORE reading signer, vault, SDK signing or network.
  requireValue(equal(compileManifest(m.spec,m.protocol,bytes),m),'MANIFEST_TAMPER');
  const step=m.steps.find(s=>s.kind===kind); requireValue(step,'STEP_DENIED');
  requireValue(localTestOnly===false || (localTestOnly===true && typeof localChain==='string'),'LOCAL_FLAG');
  const p=provider??new ReadOnlyProvider();
  requireValue(localTestOnly ? new URL(p.connection.url).hostname==='127.0.0.1' && new URL(p.connection.url).protocol==='http:' : p.connection.url===RPC && !provider,'RPC_CONFIGURATION');
  const end=performance.now()+60000, fence=()=>requireValue(performance.now()<end && Date.parse(approval.expires_at)>Date.now(),'DEADLINE');
  const live=await snapshot(p,localTestOnly?localChain:null); fence();
  requireValue(live.storage_amount_per_byte===m.protocol.storage_amount_per_byte && live.account_overhead===100 && live.record_overhead===40 && live.protocol_version===m.protocol.protocol_version && live.account_creation_charge===m.protocol.account_creation_charge && BigInt(live.min_gas_purchase_price)<=BigInt(m.budget.max_gas_price) && BigInt(live.gas_price)<=BigInt(m.budget.max_gas_price),'PROTOCOL_DRIFT');
  requireValue(BigInt(m.spec.deadline_ns)>BigInt(live.timestamp_nanosec) && BigInt(m.spec.deadline_ns)-BigInt(live.timestamp_nanosec)<=7n*24n*3600n*1_000_000_000n,'JOB_EXPIRED');
  // Existence/readback gates make an interrupted create never implicitly replaceable.
  if(kind==='factory_create') {
    requireValue(await maybeAccount(p,m.spec.factory)===null && await maybeAccount(p,m.spec.agent)===null && await maybeAccount(p,m.mandate)===null,'TARGET_EXISTS');
    const owner=await maybeAccount(p,m.spec.owner); requireValue(owner!==null,'OWNER_MISSING');
    requireValue(BigInt(owner.amount)-BigInt(owner.storage_usage)*BigInt(live.storage_amount_per_byte)>=BigInt(m.spec.cap)+BigInt(m.spec.operating_float)+BigInt(m.spec.owner_gas_reserve),'OWNER_BALANCE');
    for(const a of m.spec.allowlist) requireValue(await maybeAccount(p,a)!==null,'VENDOR_MISSING');
  } else if(kind==='factory_finalize') {
    const a=await query(p,m.spec.factory,'view_account');
    requireValue(a.code_hash==='11111111111111111111111111111111','FACTORY_NOT_EMPTY');
  } else {
    await assertFactory(p,m); requireValue(await maybeAccount(p,m.spec.agent)===null,'AGENT_EXISTS');
  }
  const k=(await exactKeys(p,step.signer_id,fullKey(m)))[0];
  const a=await query(p,step.signer_id,'view_account');
  const outgoing=step.actions.reduce((n,a)=>n+(a.type==='Transfer'?BigInt(a.amount):a.type==='FunctionCall'?BigInt(a.deposit):0n),0n);
  const reserve=BigInt(kind==='factory_finalize'?m.spec.factory_gas_reserve:m.spec.provisioner_gas_reserve);
  const sourceNeed=kind==='factory_create'?BigInt(m.spec.factory_funding)+BigInt(m.spec.agent_funding)+reserve:outgoing+reserve;
  requireValue(BigInt(a.amount)-BigInt(a.storage_usage)*BigInt(live.storage_amount_per_byte)>=sourceNeed,'BOOTSTRAP_BALANCE');
  const parent=await realpath(dirname(resolve(journalPath))), journal=resolve(parent,resolve(journalPath).split(sep).at(-1));
  requireValue(!journal.startsWith(ROOT+sep) && parent!==ROOT,'JOURNAL_OUTSIDE_REPOSITORY');
  // O_EXCL reservation and fsync precede ANY signer I/O. Existing file is lookup-only.
  const f=await open(journal,'wx',0o600);
  const record={manifest_sha256:manifestHash(m),step:kind,signer_id:step.signer_id,receiver_id:step.receiver_id,phase:'RESERVED',chain_id:live.chain_id,rpc:p.connection.url};
  const persist=async()=>{await f.truncate(0);await f.write(Buffer.from(JSON.stringify(record)),0,Buffer.byteLength(JSON.stringify(record)),0);await f.sync();};
  try {
    await persist(); fence();
    requireValue((await signer.getPublicKey()).toString()===m.spec.bootstrap_public_key,'SIGNER_BINDING');
    const nonce=k.access_key.nonce;
    requireValue((typeof nonce==='number' && Number.isSafeInteger(nonce) && nonce>=0) || (typeof nonce==='string' && /^(0|[1-9][0-9]*)$/.test(nonce)),'NONCE');
    const next=BigInt(nonce)+1n; requireValue(next>0n && next<(1n<<64n),'NONCE');
    const tx=createTransaction(step.signer_id,await signer.getPublicKey(),step.receiver_id,next,sdkActions(step,bytes),baseDecode(live.block_hash));
    const signed=await signer.signTransaction(tx); fence();
    const txHash=createHash('sha256').update(tx.encode()).digest();
    requireValue(equal(signed.signedTransaction.transaction.encode(),tx.encode()) && baseEncode(signed.txHash)===baseEncode(txHash) && tx.publicKey.verify(txHash,signed.signedTransaction.signature.data),'SIGNATURE');
    record.transaction_hash=baseEncode(txHash); record.signed_transaction=Buffer.from(signed.signedTransaction.encode()).toString('base64'); record.phase='BROADCAST_INTENT';
    await persist(); fence();
    // One raw HTTP dispatch. No Account nonce refresh, SDK or transport retry.
    const r=await fetch(p.connection.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:'provision-once',method:'send_tx',params:{signed_tx_base64:record.signed_transaction,wait_until:'FINAL'}})});
    requireValue(r.ok,'BROADCAST_UNCERTAIN'); const body=await r.json();
    requireValue(body.id==='provision-once' && !body.error && body.result?.status && Object.hasOwn(body.result.status,'SuccessValue') && body.result.receipts_outcome.every(x=>!Object.hasOwn(x.outcome.status,'Failure')),'EXECUTION_NOT_VERIFIED');
    if(kind==='factory_create') {
      const v=await query(p,m.spec.factory,'view_account'); requireValue(v.code_hash==='11111111111111111111111111111111' && v.amount===m.spec.factory_funding,'FACTORY_CREATE_READBACK'); await exactKeys(p,m.spec.factory,fullKey(m));
    } else if(kind==='factory_finalize') {
      await assertFactory(p,m);
      const state=await query(p,m.spec.factory,'view_state',{prefix_base64:Buffer.from('STATE').toString('base64')});
      requireValue(state.values.length===1,'FACTORY_STATE'); const b=Buffer.from(state.values[0].value,'base64');
      requireValue(b.length===8 && b.readUInt32LE(0)===0 && b.readUInt32LE(4)===m.spec.max_jobs,'FACTORY_INITIALIZER');
    } else await inspect(m,p);
    fence(); record.phase='VERIFIED'; delete record.signed_transaction; await persist();
    return {status:'VERIFIED',transaction_hash:record.transaction_hash,step:kind,chain_id:live.chain_id};
  } finally {await f.close();}
}
