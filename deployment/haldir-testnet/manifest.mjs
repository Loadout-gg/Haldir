import { createHash } from 'node:crypto';
import { PublicKey, baseEncode, actions } from 'near-api-js';
import { prepareCreateJob } from '../../qualification/native-wallet/request.mjs';

export const PINS = Object.freeze({
  mandate: 'bad53857b2e2f45d2b6947c3c14f4e1d595918cc1d70d7f034549e20169ea12f',
  factory: 'e885636accc7e7e159f91bfb4617d937c71f52255bb398f916fff988d58eb642',
});
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const manifestHash = m => digest(canonical(m));
const check = (v, c) => { if (!v) throw new Error(c); };
const id = s => typeof s === 'string' && s.length >= 2 && s.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(s);
const dec = (v, c, max = (1n << 128n) - 1n) => {
  check(typeof v === 'string' && /^[1-9][0-9]{0,38}$/.test(v) && BigInt(v) <= max, c); return BigInt(v);
};
export function compileManifest(input, protocol, bytes) {
  const s = structuredClone(input), p = structuredClone(protocol);
  const fields = ['network','rpc','provisioner','factory','agent','owner','allowlist','job_label','bootstrap_public_key','agent_public_key','cap','operating_float','agent_funding','allowance','factory_funding','factory_gas_reserve','provisioner_gas_reserve','owner_gas_reserve','max_total_outlay','max_jobs','deadline_ns','create_gas'];
  check(s && Object.keys(s).length === fields.length && fields.every(k => Object.hasOwn(s,k)), 'EXACT_SPEC_FIELDS_REQUIRED');
  check(s.network === 'testnet' && s.rpc === 'https://rpc.testnet.near.org' && p.chain_id === s.network && p.rpc === s.rpc, 'NETWORK');
  check([s.provisioner,s.factory,s.agent,s.owner,...(s.allowlist ?? [])].every(id) &&
    [s.provisioner,s.factory,s.agent].every(a => a.endsWith('.testnet')) && s.factory.length <= 30, 'ACCOUNT');
  check(s.factory.slice(s.factory.indexOf('.') + 1) === s.provisioner && s.agent.slice(s.agent.indexOf('.') + 1) === s.provisioner, 'DIRECT_CHILDREN_REQUIRED');
  check(new Set([s.owner,s.provisioner,s.factory,s.agent,...s.allowlist]).size === 4 + s.allowlist.length, 'ROLE_SEPARATION');
  check(Number.isInteger(s.max_jobs) && s.max_jobs >= 1 && s.max_jobs <= 256, 'CAPACITY');
  for (const k of ['bootstrap_public_key','agent_public_key']) check(PublicKey.fromString(s[k]).toString() === s[k] && s[k].startsWith('ed25519:'), 'PUBLIC_KEY');
  check(s.bootstrap_public_key !== s.agent_public_key, 'DISTINCT_KEYS');
  for (const k of ['cap','operating_float','agent_funding','allowance','factory_funding','factory_gas_reserve','provisioner_gas_reserve','owner_gas_reserve','max_total_outlay']) dec(s[k],k);
  const now = dec(p.timestamp_nanosec,'PROTOCOL_TIME',(1n<<64n)-1n), deadline = dec(s.deadline_ns,'DEADLINE',(1n<<64n)-1n);
  check(deadline > now && deadline - now <= 7n*24n*3600n*1_000_000_000n, 'DEADLINE');
  check(deadline % 1_000_000n === 0n, 'RUNTIME_DEADLINE_ALIGNMENT');
  check(p.storage_amount_per_byte === '10000000000000000000' && p.account_overhead === 100 && p.record_overhead === 40, 'UNQUALIFIED_STORAGE_PROTOCOL');
  const price = BigInt(p.storage_amount_per_byte), observedGas = dec(p.gas_price,'GAS_PRICE');
  const floorGas = dec(p.min_gas_purchase_price,'GAS_PURCHASE_FLOOR');
  const gasPrice = observedGas > floorGas ? observedGas : floorGas;
  const creationCharge = dec(p.account_creation_charge,'CREATION_CHARGE');
  const artifact = name => {
    const b = bytes[name]; check(b && digest(b) === PINS[name], 'ARTIFACT_HASH');
    return { sha256: digest(b), code_hash: baseEncode(createHash('sha256').update(b).digest()), bytes: b.length };
  };
  const artifacts = { mandate: artifact('mandate'), factory: artifact('factory') };
  check(Buffer.from(bytes.factory).includes(Buffer.from(bytes.mandate)), 'EMBEDDED_MANDATE');
  const mandate = 'j' + digest(`${s.owner}:${s.job_label}`).slice(0,32) + '.' + s.factory;
  // This independently qualified Borsh layout is bound to PINS; never reuse for new code.
  const str = a => 4 + Buffer.byteLength(a);
  const stateBytes = str(s.owner) + str(s.agent) + 4 + s.allowlist.reduce((n,a)=>n+str(a),0) + 16+8+16+16+1+4+1+8;
  const growth = 16*(89+Math.max(...s.allowlist.map(a=>Buffer.byteLength(a))))+85;
  const childMax = artifacts.mandate.bytes + 100 + 45 + stateBytes + growth;
  // Every factory slot can contain a 64-byte owner, 64-byte child and 'refunding'.
  const factoryMax = artifacts.factory.bytes + 100 + 45 + 8 + s.max_jobs*165;
  // Deliberately conservative upper bound for ONE ed25519 FunctionCall access key.
  const agentStorageUpper = 1024;
  check(BigInt(s.operating_float) >= BigInt(childMax)*price, 'CHILD_STORAGE');
  check(BigInt(s.factory_funding) >= BigInt(factoryMax)*price + BigInt(s.factory_gas_reserve), 'FACTORY_STORAGE');
  check(BigInt(s.agent_funding) >= BigInt(agentStorageUpper)*price + BigInt(s.allowance), 'AGENT_STORAGE_ALLOWANCE');
  // Reserve gas at 2x observed price, 300Tgas per transaction, two provisioner txs.
  const gasEnvelope = 300_000_000_000_000n * gasPrice * 2n;
  const txReserve = gasEnvelope + creationCharge;
  check(BigInt(s.factory_gas_reserve) >= txReserve && BigInt(s.provisioner_gas_reserve) >= txReserve*2n && BigInt(s.owner_gas_reserve) >= txReserve*3n, 'GAS_RESERVES');
  const allowance = BigInt(s.allowance);
  check(allowance >= gasEnvelope, 'ALLOWANCE_TOO_SMALL');
  check(allowance <= BigInt(s.agent_funding) - BigInt(agentStorageUpper)*price, 'FINITE_ALLOWANCE');
  const ownerManifest = { network: s.network, factory: s.factory, owner: s.owner, agent: s.agent,
    mandate, job_label: s.job_label, allowlist: s.allowlist, cap: s.cap, operating_float: s.operating_float,
    create_gas: s.create_gas, deadline_ns: s.deadline_ns };
  prepareCreateJob(ownerManifest);
  const total = BigInt(s.factory_funding)+BigInt(s.agent_funding)+BigInt(s.cap)+BigInt(s.operating_float)+BigInt(s.provisioner_gas_reserve)+BigInt(s.owner_gas_reserve);
  check(total <= BigInt(s.max_total_outlay), 'TOTAL_CAP');
  const call = (method,args,gas,deposit='0') => ({ type:'FunctionCall',method,args,gas,deposit });
  const steps = [
    { kind:'factory_create', signer_id:s.provisioner, receiver_id:s.factory, actions:[{type:'CreateAccount'},{type:'Transfer',amount:s.factory_funding},{type:'FullAccess',public_key:s.bootstrap_public_key}] },
    { kind:'factory_finalize', signer_id:s.factory, receiver_id:s.factory, actions:[{type:'DeployContract',artifact:'factory',sha256:artifacts.factory.sha256},call('new',{max_jobs:s.max_jobs},'100000000000000'),{type:'DeleteKey',public_key:s.bootstrap_public_key}] },
    { kind:'agent_create', signer_id:s.provisioner, receiver_id:s.agent, actions:[{type:'CreateAccount'},{type:'Transfer',amount:s.agent_funding},{type:'FunctionCallKey',public_key:s.agent_public_key,permission:{receiver_id:mandate,method_names:['pay'],allowance:s.allowance}}] },
  ];
  const owner_create = { signer_id:s.owner, receiver_id:s.factory, actions:[call('create_job',{
    job_label:s.job_label,agent:s.agent,allowlist:s.allowlist,cap:s.cap,deadline_ns:s.deadline_ns,operating_float:s.operating_float,
  },s.create_gas,String(BigInt(s.cap)+BigInt(s.operating_float)))] };
  return { schema:'haldir-testnet-provisioning-v1', spec:s, protocol:p, artifacts, mandate,
    budget:{ total_outlay:String(total), max_gas_price:String(gasPrice*2n), child_max_storage_bytes:childMax,
      child_minimum_float:String(BigInt(childMax)*price), factory_max_storage_bytes:factoryMax,
      factory_minimum_storage:String(BigInt(factoryMax)*price), agent_storage_upper_bytes:agentStorageUpper,
      note:'Allowance is included in agent funding, not extra principal. Gas reserves are operational buffers, not protocol spending limits. Operating float/factory stake are stranded by immutable ABI.' },
    steps, owner_create, owner_manifest:ownerManifest, job_expires_at:new Date(Number(deadline/1_000_000n)).toISOString(),
    runtime_binding:{ ownerId:s.owner, signerId:s.agent, mandateId:mandate, networkId:'testnet',
      publicKey:s.agent_public_key, maxAllowanceAtomic:s.allowance, codeHash:artifacts.mandate.code_hash },
    owner_stop:{signer_id:s.owner,receiver_id:mandate,actions:[call('stop',{},'100000000000000')]},
    owner_withdraw:{signer_id:s.owner,receiver_id:mandate,actions:[call('withdraw',{},'100000000000000')]},
  };
}
export function sdkActions(step, bytes) {
  return step.actions.map(a => {
    switch(a.type) {
      case 'CreateAccount': return actions.createAccount();
      case 'Transfer': return actions.transfer(BigInt(a.amount));
      case 'FullAccess': return actions.addFullAccessKey(PublicKey.fromString(a.public_key));
      case 'DeployContract': check(digest(bytes[a.artifact]) === a.sha256,'ARTIFACT_HASH'); return actions.deployContract(bytes[a.artifact]);
      case 'FunctionCall': return actions.functionCall(a.method,a.args,BigInt(a.gas),BigInt(a.deposit));
      case 'DeleteKey': return actions.deleteKey(PublicKey.fromString(a.public_key));
      case 'FunctionCallKey': return actions.addFunctionCallAccessKey(PublicKey.fromString(a.public_key),a.permission.receiver_id,a.permission.method_names,BigInt(a.permission.allowance));
      default: throw new Error('ACTION_DENIED');
    }
  });
}
