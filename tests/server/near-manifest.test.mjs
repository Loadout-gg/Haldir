import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { baseEncode } from 'near-api-js';
import { createNearManifestProvider } from '../../src/server/near-manifest.mjs';
import { validatePublicManifest, createPublicOrders, openLocalRepository } from '../../src/server/orders.mjs';

const deployed = JSON.parse(await readFile(new URL('../../deployment/haldir-testnet/manifest.synthetic-fixture.json', import.meta.url)));
const time = Date.parse('2026-11-13T10:00:00Z'), blockHash = baseEncode(new Uint8Array(32).fill(7));
const url = 'https://closed-manifest.invalid';
function terms(creation = true) {
  const s = deployed.spec, b = deployed.runtime_binding;
  return { manifestId: 'approved', ownerId: b.ownerId,
    approved: { job: { networkId: 'testnet', mandateId: b.mandateId, purpose: 'Fictional research', output: 'Report',
      budgetAtomic: s.cap, vendorIds: s.allowlist, expiresAt: '2026-11-13T18:00:00Z' },
    quote: { networkId: 'testnet', mandateId: b.mandateId, vendorId: s.allowlist[0], amountAtomic: '8', orderId: 'quote-1', content: 'Fictional sample' } },
    binding: structuredClone(b), rpcUrl: url, allowedRpcUrls: [url],
    ...(creation ? { creation: { factory: s.factory, job_label: s.job_label, operating_float: s.operating_float,
      create_gas: s.create_gas, factoryCodeHash: deployed.artifacts.factory.code_hash } } : {}) };
}
function fixture(options = {}) {
  const m = terms(options.creation !== false), calls = [], storeCalls = [];
  const evidence = { block_hash: blockHash, block_height: 123 };
  const rich = '20000000000000000000000000';
  const state = { owner: m.ownerId, agent: m.binding.signerId, allowlist: m.approved.job.vendorIds, cap: m.approved.job.budgetAtomic,
    deadline_ns: String(BigInt(Date.parse(m.approved.job.expiresAt))*1000000n), stopped: false, expired: false,
    spent: '0', reserved: '0', refunded: '0', free: m.approved.job.budgetAtomic, orders: [], in_flight: null };
  const transport = async (endpoint, init) => {
    assert.equal(endpoint, url); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, false);
    const req = JSON.parse(init.body); calls.push(req);
    let result;
    if (req.method === 'status') { assert.deepEqual(req.params, []); result = { chain_id: 'testnet', sync_info: { syncing: false } }; }
    else if (req.method === 'block') { assert.deepEqual(req.params, { finality: 'final' }); result = { header: { hash: blockHash, height: 123, timestamp_nanosec: String(BigInt(time - 1000)*1000000n) } }; }
    else if (req.method === 'EXPERIMENTAL_protocol_config') { assert.deepEqual(req.params, { block_id: blockHash }); result = deployed.protocol.protocol_config; }
    else if (req.method === 'gas_price') { assert.deepEqual(req.params, [blockHash]); result = { gas_price: deployed.protocol.gas_price }; }
    else {
      assert.equal(req.method, 'query'); const p = req.params;
      assert.equal(p.block_id, blockHash); assert.equal(p.finality, undefined);
      if (p.request_type === 'view_account') {
        if (p.account_id === m.binding.mandateId && !options.child) {
          const error = { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: p.account_id, block_hash: blockHash, block_height: 123 } } };
          const changed = options.mutateError?.(error, req) ?? error;
          return Response.json({ jsonrpc: '2.0', id: req.id, error: changed });
        }
        result = { ...evidence, amount: rich, locked: '0', storage_usage: 1024,
          code_hash: p.account_id === m.binding.mandateId ? m.binding.codeHash : p.account_id === deployed.spec.factory ? deployed.artifacts.factory.code_hash : '11111111111111111111111111111111' };
      } else if (p.request_type === 'view_access_key_list') result = { ...evidence, keys: p.account_id === m.binding.signerId ? [{ public_key: m.binding.publicKey,
        access_key: { nonce: 1, permission: { FunctionCall: { receiver_id: m.binding.mandateId, method_names: ['pay'], allowance: m.binding.maxAllowanceAtomic } } } }] : [] };
      else if (p.request_type === 'view_state') {
        assert.equal(p.account_id, deployed.spec.factory); assert.equal(p.prefix_base64, Buffer.from('STATE').toString('base64'));
        const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
        const str = s => Buffer.concat([u32(Buffer.byteLength(s)),Buffer.from(s)]);
        const capFloat = BigInt(m.approved.job.budgetAtomic) + BigInt(m.creation.operating_float);
        const amount = Buffer.alloc(16); amount.writeBigUInt64LE(capFloat & ((1n<<64n)-1n)); amount.writeBigUInt64LE(capFloat>>64n,8);
        const bytes = options.child ? Buffer.concat([u32(1),str(m.binding.mandateId),str(m.ownerId),amount,str('ready'),u32(4)]) : Buffer.concat([u32(0),u32(4)]);
        result = { ...evidence, values: [{ key: Buffer.from('STATE').toString('base64'), value: bytes.toString('base64') }], proof: [] };
      } else {
        assert.equal(p.request_type, 'call_function');
        const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString());
        const output = p.method_name === 'get_status' ? state : p.method_name === 'job_id' ? m.binding.mandateId : p.method_name === 'get_entry' ?
          (options.child ? { job: m.binding.mandateId, owner: m.ownerId, amount: String(BigInt(m.approved.job.budgetAtomic)+BigInt(m.creation.operating_float)), state: 'ready' } : null) : assert.fail('unexpected ABI method');
        assert.deepEqual(args, p.method_name === 'get_status' ? {} : { owner: m.ownerId, job_label: m.creation.job_label });
        result = { ...evidence, result: [...Buffer.from(JSON.stringify(output))], logs: [] };
      }
    }
    result = options.mutate?.(result, req) ?? result;
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  };
  const trustedApprovalStore = { get: async input => { storeCalls.push(input); return structuredClone(m); } };
  const provider = () => createNearManifestProvider({ trustedApprovalStore, rpcUrl: url, allowedRpcUrls: [url], transport,
    now: () => time, timeoutMs: 1000, ...options.config });
  return { m, calls, storeCalls, provider, transport };
}
test('TS1 manifest admits exactly two remaining order slots with combined free principal via installed SDK transport',async()=>{
  const f=fixture({child:true,creation:false,mutate:(r,q)=>{
    if(q.params?.method_name==='get_status') {
      const s=JSON.parse(Buffer.from(r.result).toString());s.allowlist=f.m.approved.job.vendorIds;s.orders=Array.from({length:14},(_,i)=>({order_id:`existing-${i}`}));
      return {...r,result:[...Buffer.from(JSON.stringify(s))]};
    }return r;
  }});
  const q=f.m.approved.quote,second={...q,vendorId:'second.testnet',orderId:'quote-2',content:'Second fictional sample',amountAtomic:'9'};
  f.m.approved={schemaVersion:'haldir.approved.two-source.v1',job:{...f.m.approved.job,vendorIds:[q.vendorId,second.vendorId]},sources:[{sourceId:'company-records',quote:q},{sourceId:'background-research',quote:second}]};
  assert.equal((await f.provider()(request)).chainEvidence.deployment,'MANDATE_READY');
});

for(const mode of ['only-one-slot','second-order-already-present','free-covers-each-not-sum'])test(`TS1 manifest rejects ${mode} at exact state guard`,async()=>{
 let exercised=false;
 const f=fixture({child:true,creation:false,mutate:(r,q)=>{
   if(q.params?.method_name!=='get_status')return r;exercised=true;
   const s=JSON.parse(Buffer.from(r.result).toString());s.allowlist=f.m.approved.job.vendorIds;
   if(mode==='only-one-slot')s.orders=Array.from({length:15},(_,i)=>({order_id:`existing-${i}`}));
   if(mode==='second-order-already-present')s.orders=[{order_id:'quote-2'}];
   if(mode==='free-covers-each-not-sum'){s.free='16';s.spent=String(BigInt(s.cap)-16n);}
   return {...r,result:[...Buffer.from(JSON.stringify(s))]};
 }});
 const q=f.m.approved.quote,second={...q,vendorId:'second.testnet',orderId:'quote-2',content:'Second fictional sample',amountAtomic:'9'};
 f.m.approved={schemaVersion:'haldir.approved.two-source.v1',job:{...f.m.approved.job,vendorIds:[q.vendorId,second.vendorId]},sources:[{sourceId:'company-records',quote:q},{sourceId:'background-research',quote:second}]};
 await assert.rejects(f.provider()(request),{code:'MANIFEST_UNAVAILABLE'});assert.equal(exercised,true);
});

const request = { ownerId: deployed.spec.owner, approvalId: 'approved' };
// No ambient fetch fallback: every fixture request stays on the explicitly
// synthetic HTTPS origin, and any forbidden attempt fails even if caught.
test.beforeEach(t => {
  let forbidden = 0;
  t.mock.method(globalThis, 'fetch', async () => { forbidden++; throw new Error('FORBIDDEN_NETWORK'); });
  t.after(() => assert.equal(forbidden, 0));
});

test('official UNKNOWN_ACCOUNT requested_account_id and actual SDK closed transport qualify FACTORY_READY, not a deployed child', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const m = await f.provider()({ ...request, signal });
  assert.equal(f.storeCalls.length, 1);
  assert.deepEqual({ ...f.storeCalls[0], signal }, { ...request, signal });
  assert.ok(f.storeCalls[0].signal instanceof AbortSignal);
  assert.deepEqual(m, { ...f.m, chainEvidence: { networkId: 'testnet', finality: 'final', blockHash, blockHeight: 123, observedAt: time, deployment: 'FACTORY_READY' } });
  assert.equal(validatePublicManifest(m, request.ownerId, time), m);
  assert.equal(f.calls.filter(r => r.method === 'block').length, 1);
  assert.ok(f.calls.some(r => r.params?.request_type === 'view_account' && r.params.account_id === f.m.binding.mandateId));
  assert.ok(!f.calls.some(r => r.params?.method_name === 'get_status'));
});

for (const creation of [false, true]) test(`existing keyless child lane verifies scope/code/state at the same final block (creation=${creation})`, async () => {
  const f = fixture({ child: true, creation });
  const m = await f.provider()(request);
  assert.deepEqual(m, { ...f.m, chainEvidence: { networkId: 'testnet', finality: 'final', blockHash, blockHeight: 123, observedAt: time, deployment: 'MANDATE_READY' } });
  assert.ok(f.calls.some(r => r.params?.method_name === 'get_status'));
  assert.ok(f.calls.some(r => r.params?.request_type === 'view_access_key_list' && r.params.account_id === f.m.binding.mandateId));
});

test('store receives an abortable total-deadline signal even without caller signal', async () => {
  let storeSignal;
  const f = fixture({ config: { timeoutMs: 10, trustedApprovalStore: { get: async ({signal}) => { storeSignal = signal; return new Promise(() => {}); } } } });
  await assert.rejects(f.provider()(request), { code: 'MANIFEST_UNAVAILABLE' });
  assert.ok(storeSignal instanceof AbortSignal);
  assert.equal(storeSignal.aborted, true);
  assert.equal(f.calls.length, 0);
});

test('final evidence fence rejects a block older than 30 seconds even when total timeout has not fired', async () => {
  let ticks = 0;
  const f = fixture({config: { now: () => time + (++ticks === 1 ? 0 : 29999) }});
  await assert.rejects(f.provider()(request), { code: 'MANIFEST_UNAVAILABLE' });
});

for (const [name, change] of [
  ['request manifest', x => { x.manifest = terms(); }],
  ['request network', x => { x.networkId = 'mainnet'; }],
  ['malformed owner', x => { x.ownerId = 'Owner.testnet'; }],
  ['malformed approval', x => { x.approvalId = 'bad/id'; }],
]) test(`subject refuses ${name} before store or RPC`, async () => {
  const f = fixture(), input = { ...request }; change(input);
  await assert.rejects(f.provider()(input), {code:'MANIFEST_SUBJECT_INVALID'});
  assert.equal(f.calls.length,0); assert.equal(f.storeCalls.length,0);
});

for (const [name, change] of [
  ['unapproved owner', m => { m.ownerId = 'bob.testnet'; }],
  ['binding owner', m => { m.binding.ownerId = 'bob.testnet'; }],
  ['unknown top field', m => { m.ownerTerms = {}; }],
  ['store-supplied evidence', m => { m.chainEvidence = {}; }],
  ['wrong network', m => { m.binding.networkId = 'mainnet'; }],
  ['unapproved RPC', m => { m.rpcUrl = 'https://mainnet.invalid'; }],
  ['changed RPC allowlist', m => { m.allowedRpcUrls.push('https://other.invalid'); }],
  ['unapproved child code', m => { m.binding.codeHash = blockHash; }],
  ['unapproved factory code', m => { m.creation.factoryCodeHash = blockHash; }],
  ['unknown creation field', m => { m.creation.extra = true; }],
  ['numeric gas', m => { m.creation.create_gas = 300000000000000; }],
  ['noncanonical gas', m => { m.creation.create_gas = '0300000000000000'; }],
  ['gas below ABI bound', m => { m.creation.create_gas = '199999999999999'; }],
  ['numeric float', m => { m.creation.operating_float = 2; }],
  ['overflow cap plus float', m => { m.creation.operating_float = String((1n<<128n)-1n); }],
  ['wrong derived child', m => { m.creation.job_label = 'other'; }],
  ['invalid factory class', m => { m.creation.factory = 'factory.near'; }],
  ['invalid agent key', m => { m.binding.publicKey = 'ed25519:bad'; }],
  ['quote cap mismatch', m => { m.approved.quote.amountAtomic = String(BigInt(m.approved.job.budgetAtomic)+1n); }],
  ['extra approved field', m => { m.approved.job.extra = true; }],
]) test(`trusted store terms reject ${name}`, async () => {
  const f = fixture(); change(f.m);
  await assert.rejects(f.provider()(request), {code:'MANIFEST_UNAVAILABLE'});
});

for (const [name, select, change] of [
  ['mainnet status', q => q.method === 'status', r => {r.chain_id='mainnet';}],
  ['syncing status', q => q.method === 'status', r => {r.sync_info.syncing=true;}],
  ['old final block', q => q.method === 'block', r => {r.header.timestamp_nanosec=String(BigInt(time-30001)*1000000n);}],
  ['future final block', q => q.method === 'block', r => {r.header.timestamp_nanosec=String(BigInt(time+1)*1000000n);}],
  ['invalid final block hash', q => q.method === 'block', r => {r.header.hash='bad';}],
  ['protocol drift', q => q.method === 'EXPERIMENTAL_protocol_config', r => {r.protocol_version++;}],
  ['storage-price drift', q => q.method === 'EXPERIMENTAL_protocol_config', r => {r.runtime_config.storage_amount_per_byte='1';}],
  ['storage-layout drift', q => q.method === 'EXPERIMENTAL_protocol_config', r => {r.runtime_config.transaction_costs.storage_usage_config.num_bytes_account=99;}],
  ['gas purchase floor not funded', q => q.method === 'EXPERIMENTAL_protocol_config', r => {r.runtime_config.min_gas_purchase_price='1000000000000';}],
  ['reported gas not funded', q => q.method === 'gas_price', r => {r.gas_price='1000000000000';}],
  ['cross-block query', q => q.method === 'query', r => {r.block_hash=baseEncode(new Uint8Array(32).fill(8));}],
  ['wrong block height', q => q.method === 'query', r => {r.block_height++;}],
  ['FullAccess agent', q => q.params?.request_type === 'view_access_key_list' && q.params.account_id === deployed.spec.agent, r => {r.keys[0].access_key.permission='FullAccess';}],
  ['extra agent key', q => q.params?.request_type === 'view_access_key_list' && q.params.account_id === deployed.spec.agent, r => {r.keys.push(structuredClone(r.keys[0]));}],
  ['paginated agent keys', q => q.params?.request_type === 'view_access_key_list' && q.params.account_id === deployed.spec.agent, r => {r.last_key='cursor';}],
  ['unlimited agent allowance', q => q.params?.request_type === 'view_access_key_list' && q.params.account_id === deployed.spec.agent, r => {r.keys[0].access_key.permission.FunctionCall.allowance=null;}],
  ['wrong approved allowance', q => q.params?.request_type === 'view_access_key_list' && q.params.account_id === deployed.spec.agent, r => {r.keys[0].access_key.permission.FunctionCall.allowance='1';}],
  ['wrong agent receiver', q => q.params?.request_type === 'view_access_key_list' && q.params.account_id === deployed.spec.agent, r => {r.keys[0].access_key.permission.FunctionCall.receiver_id='other.testnet';}],
  ['all-method key', q => q.params?.request_type === 'view_access_key_list' && q.params.account_id === deployed.spec.agent, r => {r.keys[0].access_key.permission.FunctionCall.method_names=[];}],
  ['extra agent method', q => q.params?.request_type === 'view_access_key_list' && q.params.account_id === deployed.spec.agent, r => {r.keys[0].access_key.permission.FunctionCall.method_names.push('stop');}],
  ['agent underfunded', q => q.params?.request_type === 'view_account' && q.params.account_id === deployed.spec.agent, r => {r.amount='1';}],
  ['factory underfunded', q => q.params?.request_type === 'view_account' && q.params.account_id === deployed.spec.factory, r => {r.amount='1';}],
  ['factory mutable key', q => q.params?.request_type === 'view_access_key_list' && q.params.account_id === deployed.spec.factory, r => {r.keys=[{public_key:deployed.spec.bootstrap_public_key,access_key:{permission:'FullAccess'}}];}],
  ['factory code mismatch', q => q.params?.request_type === 'view_account' && q.params.account_id === deployed.spec.factory, r => {r.code_hash=blockHash;}],
  ['factory capacity zero', q => q.params?.request_type === 'view_state', r => {r.values[0].value=Buffer.alloc(8).toString('base64');}],
  ['factory state truncated', q => q.params?.request_type === 'view_state', r => {r.values[0].value='AAAAAA==';}],
  ['factory state trailing bytes', q => q.params?.request_type === 'view_state', r => {r.values[0].value=Buffer.concat([Buffer.from(r.values[0].value,'base64'),Buffer.from([0])]).toString('base64');}],
  ['factory stale entry', q => q.params?.method_name === 'get_entry', r => {r.result=[...Buffer.from(JSON.stringify({state:'creating'}))];}],
  ['factory derivation ABI mismatch', q => q.params?.method_name === 'job_id', r => {r.result=[...Buffer.from(JSON.stringify('wrong.testnet'))];}],
  ['owner underfunded', q => q.params?.request_type === 'view_account' && q.params.account_id === deployed.spec.owner, r => {r.amount='1';}],
]) test(`factory readiness rejects ${name}`, async () => {
  let exercised = false;
  const f = fixture({mutate: (value, q) => {const r=structuredClone(value); if(select(q)) {exercised=true;change(r);} return r;}});
  await assert.rejects(f.provider()(request), {code:'MANIFEST_UNAVAILABLE'});
  assert.equal(exercised,true,'negative must actually reach its semantic boundary');
});

for (const [name, change] of [
  ['free-text absence', e => {return {message:'account does not exist'};}],
  ['wrong error wrapper', e => {e.name='INTERNAL_ERROR';return e;}],
  ['UNKNOWN_BLOCK', e => {e.cause.name='UNKNOWN_BLOCK';return e;}],
  ['wrong absent account', e => {e.cause.info.requested_account_id='other.testnet';return e;}],
  ['wrong legacy account_id field', e => {e.cause.info.account_id=e.cause.info.requested_account_id;delete e.cause.info.requested_account_id;return e;}],
  ['wrong requested account despite matching legacy field', e => {e.cause.info.account_id=e.cause.info.requested_account_id;e.cause.info.requested_account_id='other.testnet';return e;}],
  ['wrong absent block', e => {e.cause.info.block_hash=baseEncode(new Uint8Array(32).fill(8));return e;}],
  ['wrong absent height', e => {e.cause.info.block_height++;return e;}],
  ['string absent height', e => {e.cause.info.block_height=String(e.cause.info.block_height);return e;}],
  ['unbound absence', e => {delete e.cause.info;return e;}],
]) test(`child absence rejects ${name}`, async () => {
  let exercised=false;
  const f=fixture({mutateError:e=>{exercised=true;return change(e);}});
  await assert.rejects(f.provider()(request),{code:'MANIFEST_UNAVAILABLE'}); assert.equal(exercised,true);
});

test('child view_account network failure is not absence and has no retry or fallback', async () => {
  let attempts=0,exercised=false;
  const f=fixture({config:{transport:async(endpoint,init)=>{
    attempts++;const q=JSON.parse(init.body);
    if(q.method==='query'&&q.params.request_type==='view_account'&&q.params.account_id===f.m.binding.mandateId){
      exercised=true;throw new TypeError('account does not exist: network unavailable');
    }
    return f.transport(endpoint,init);
  }}});
  await assert.rejects(f.provider()(request),{code:'MANIFEST_UNAVAILABLE'});
  assert.equal(exercised,true);assert.equal(attempts,7);assert.equal(f.calls.length,6);
});

for (const [name, change] of [
  ['owner', s=>{s.owner='bob.testnet';}], ['agent', s=>{s.agent='other.testnet';}],
  ['cap', s=>{s.cap='1';}], ['allowlist',s=>{s.allowlist=['other.testnet'];}], ['deadline',s=>{s.deadline_ns='1';}],
  ['stopped',s=>{s.stopped=true;}], ['expired',s=>{s.expired=true;}], ['in flight',s=>{s.in_flight={};}],
  ['inconsistent principal',s=>{s.spent='1';}], ['duplicate order',s=>{s.orders=[{order_id:'quote-1'}];}],
]) test(`deployed mandate rejects wrong ${name}`, async () => {
  let exercised=false;
  const f=fixture({child:true,creation:false,mutate:(r,q)=>{
    if(q.params?.method_name!=='get_status')return r; exercised=true;
    const state=JSON.parse(Buffer.from(r.result).toString());change(state);return {...r,result:[...Buffer.from(JSON.stringify(state))]};
  }});
  await assert.rejects(f.provider()(request),{code:'MANIFEST_UNAVAILABLE'});assert.equal(exercised,true);
});

for (const [name, select, change] of [
  ['wrong code',q=>q.params?.request_type==='view_account'&&q.params.account_id===deployed.mandate,r=>{r.code_hash=blockHash;}],
  ['residual key',q=>q.params?.request_type==='view_access_key_list'&&q.params.account_id===deployed.mandate,r=>{r.keys=[{public_key:deployed.spec.bootstrap_public_key}];}],
  ['incomplete key list',q=>q.params?.request_type==='view_access_key_list'&&q.params.account_id===deployed.mandate,r=>{r.last_key='next';}],
  ['insolvent child',q=>q.params?.request_type==='view_account'&&q.params.account_id===deployed.mandate,r=>{r.amount=deployed.spec.cap;}],
]) test(`deployed mandate rejects ${name}`,async()=>{
  let exercised=false;
  const f=fixture({child:true,creation:false,mutate:(r,q)=>{if(select(q)){exercised=true;change(r);}return r;}});
  await assert.rejects(f.provider()(request),{code:'MANIFEST_UNAVAILABLE'});assert.equal(exercised,true);
});

test('deployed lane accepts funded finite remaining allowance below immutable approved ceiling; pre-create still requires exact initial allowance',async()=>{
  const options={child:true,creation:false,mutate:(r,q)=>{
    if(q.params?.request_type==='view_access_key_list'&&q.params.account_id===deployed.spec.agent)
      r.keys[0].access_key.permission.FunctionCall.allowance=deployed.spec.allowance;
    return r;
  }};
  const f=fixture(options); f.m.binding.maxAllowanceAtomic=String(BigInt(deployed.spec.allowance)*2n);
  assert.equal((await f.provider()(request)).chainEvidence.deployment,'MANDATE_READY');
  const pre=fixture({...options,child:false,creation:true});pre.m.binding.maxAllowanceAtomic=f.m.binding.maxAllowanceAtomic;
  await assert.rejects(pre.provider()(request),{code:'MANIFEST_UNAVAILABLE'});
});

test('delivered provisioning manifest millisecond deadline is admitted literally without rounding approved ABI terms',async()=>{
  const f=fixture();f.m.approved.job.expiresAt=deployed.job_expires_at;
  assert.equal(String(BigInt(Date.parse(f.m.approved.job.expiresAt))*1000000n),deployed.spec.deadline_ns);
  const m=await f.provider()(request);
  assert.equal(m.approved.job.expiresAt,deployed.job_expires_at);
  assert.equal(m.chainEvidence.deployment,'FACTORY_READY');
  const repository=openLocalRepository({filename:':memory:',localTestOnly:true});
  try{
    const orders=createPublicOrders({repository,trustedManifestProvider:f.provider(),now:()=>time});
    const job=await orders.createJob({...request,admissionKey:'millisecond'});
    assert.equal(job.scope.expiresAt,deployed.job_expires_at);
    assert.deepEqual((await orders.getJob({ownerId:request.ownerId,jobId:job.jobId})).publicManifest,m);
  }finally{repository.close();}
});

for(const expiresAt of ['2026-11-13T18:00:00.33Z','2026-11-13T18:00:00.3300Z','2026-11-13T18:00:00+00:00','2026-11-31T18:00:00.330Z'])
  test(`extended approval rejects noncanonical deadline ${expiresAt}`,async()=>{
    const m=await fixture().provider()(request);m.approved.job.expiresAt=expiresAt;
    assert.throws(()=>validatePublicManifest(m,request.ownerId,time));
  });

test('legacy public deadline grammar remains unchanged by explicit creation extension',async()=>{
  const m=await fixture({child:true,creation:false}).provider()(request);
  m.approved.job.expiresAt=deployed.job_expires_at;
  assert.throws(()=>validatePublicManifest(m,request.ownerId,time),{code:'INVALID_APPROVAL'});
});

test('unknown child cannot enter legacy already-deployed lane',async()=>{
  const f=fixture({creation:false});await assert.rejects(f.provider()(request),{code:'MANIFEST_UNAVAILABLE'});
});

test('actual observer and public admission persist immutable creation; refreshed deployed evidence does not rewrite stored phase',async()=>{
  const options={},f=fixture(options),provider=f.provider();
  const repository=openLocalRepository({filename:':memory:',localTestOnly:true});
  try{
    const orders=createPublicOrders({repository,trustedManifestProvider:provider,now:()=>time});
    const input={...request,admissionKey:'one'};
    const first=await orders.createJob(input);
    assert.equal(first.publicManifest.chainEvidence.deployment,'FACTORY_READY');
    options.child=true;
    assert.equal((await provider(request)).chainEvidence.deployment,'MANDATE_READY');
    assert.deepEqual(await orders.createJob(input),first);
    assert.deepEqual(await orders.getJob({ownerId:request.ownerId,jobId:first.jobId}),first);
    assert.equal(await repository.runTransaction(tx=>tx.get('nativeOperations',first.quoteId)),null);
    f.m.creation.operating_float=String(BigInt(f.m.creation.operating_float)+1n);
    await assert.rejects(orders.createJob(input),{code:'IDEMPOTENCY_CONFLICT'});
  }finally{repository.close();}
});

for (const [name, corrupt] of [
  ['HTTP error', () => new Response('{}',{status:503})],
  ['redirect status', () => Response.redirect('https://mainnet.invalid')],
  ['redirected response', () => {const r=Response.json({});Object.defineProperty(r,'redirected',{value:true});return r;}],
  ['malformed JSON', () => new Response('{broken')],
  ['wrong RPC id', (r,q) => Response.json({...r,id:q.id+'wrong'})],
  ['RPC error and result', r => Response.json({...r,error:{message:'secret upstream details'}})],
  ['missing RPC result', (r,q) => Response.json({jsonrpc:'2.0',id:q.id})],
  ['oversized body', () => new Response(' '.repeat(262145))],
]) test(`closed transport rejects ${name} without retry or fallback`,async()=>{
  let attempts=0;
  const f=fixture({config:{transport:async(endpoint,init)=>{
    attempts++;const req=JSON.parse(init.body),r=await f.transport(endpoint,init);
    return corrupt(await r.json(),req);
  }}});
  await assert.rejects(f.provider()(request),e=>e.code==='MANIFEST_UNAVAILABLE'&&e.message==='MANIFEST_UNAVAILABLE'&&!e.cause);
  assert.equal(attempts,1);
});

test('RPC total deadline aborts noncooperative transport and performs no next query',async()=>{
  let signal,attempts=0;
  const f=fixture({config:{timeoutMs:10,transport:async(_,init)=>{attempts++;signal=init.signal;return new Promise(()=>{});}}});
  await assert.rejects(f.provider()(request),{code:'MANIFEST_UNAVAILABLE'});
  assert.equal(signal.aborted,true);assert.equal(attempts,1);
});

test('body deadline cancels a stalled response reader',async()=>{
  let cancelled=false;
  const f=fixture({config:{timeoutMs:10,transport:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))}});
  await assert.rejects(f.provider()(request),{code:'MANIFEST_UNAVAILABLE'});
  assert.equal(cancelled,true);
});

test('same-turn caller abort prevents queued approval lookup rather than merely rejecting its result',async()=>{
  const caller=new AbortController(),f=fixture();
  const pending=f.provider()({...request,signal:caller.signal});caller.abort();
  await assert.rejects(pending,{code:'MANIFEST_UNAVAILABLE'});
  assert.equal(f.storeCalls.length,0);assert.equal(f.calls.length,0);
});

test('caller abort settles RPC and blocks subsequent work; already-aborted call never reaches store',async()=>{
  const caller=new AbortController();let transportSignal;
  const f=fixture({config:{transport:async(_,init)=>{transportSignal=init.signal;caller.abort();return new Promise(()=>{});}}});
  await assert.rejects(f.provider()({...request,signal:caller.signal}),{code:'MANIFEST_UNAVAILABLE'});
  assert.equal(transportSignal.aborted,true);
  const before=fixture();await assert.rejects(before.provider()({...request,signal:caller.signal}),{code:'MANIFEST_UNAVAILABLE'});
  assert.equal(before.storeCalls.length,0);assert.equal(before.calls.length,0);
});

for(const [name,config] of [
  ['mainnet URL',{rpcUrl:'https://rpc.mainnet.near.org',allowedRpcUrls:['https://rpc.mainnet.near.org']}],
  ['redirect path',{rpcUrl:url+'/redirect',allowedRpcUrls:[url+'/redirect']}],
  ['HTTP URL',{rpcUrl:'http://closed-manifest.invalid',allowedRpcUrls:['http://closed-manifest.invalid']}],
  ['unallowlisted URL',{allowedRpcUrls:['https://other.invalid']}],
  ['credentials URL',{rpcUrl:'https://user:password@closed-manifest.invalid',allowedRpcUrls:['https://user:password@closed-manifest.invalid']}],
  ['unbounded deadline',{timeoutMs:Infinity}],
])test(`constructor rejects ${name} before store or transport`,()=>{
  const f=fixture({config});assert.throws(f.provider,{code:'MANIFEST_CONFIGURATION_INVALID'});
  assert.equal(f.calls.length,0);assert.equal(f.storeCalls.length,0);
});

test('missing approval never consults RPC',async()=>{
  const f=fixture({config:{trustedApprovalStore:{get:async()=>null}}});
  await assert.rejects(f.provider()(request),{code:'MANIFEST_UNAVAILABLE'});assert.equal(f.calls.length,0);
});

for(const [name,change] of [
  ['unknown manifest key',m=>{m.extra=true;}],
  ['ownerTerms alias',m=>{m.ownerTerms=m.creation;}],
  ['unknown deployment enum',m=>{m.chainEvidence.deployment='DEPLOYED';}],
  ['unknown evidence key',m=>{m.chainEvidence.childDeployed=true;}],
  ['factory-ready without creation',m=>{delete m.creation;}],
  ['unknown creation key',m=>{m.creation.deposit='1';}],
  ['numeric creation gas',m=>{m.creation.create_gas=300000000000000;}],
  ['zero creation float',m=>{m.creation.operating_float='0';}],
  ['invalid factory hash',m=>{m.creation.factoryCodeHash='bad';}],
  ['wrong derived child',m=>{m.creation.job_label='other';}],
])test(`admission retains exact schema rejection for ${name} before repository effects`,async()=>{
  const f=fixture(),m=await f.provider()(request);change(m);
  let transactions=0;
  const orders=createPublicOrders({repository:{runTransaction(){transactions++;throw new Error('unexpected write');}},trustedManifestProvider:async()=>m,now:()=>time});
  await assert.rejects(orders.createJob({...request,admissionKey:'invalid'}),{code:'PUBLIC_MANIFEST_INVALID'});
  assert.equal(transactions,0);
});

test('storage float and creation funding are independent from cap; minimal float fails without inventing account bindings',async()=>{
  const f=fixture();f.m.creation.operating_float='1';
  await assert.rejects(f.provider()(request),{code:'MANIFEST_UNAVAILABLE'});
  const g=fixture();const manifest=await g.provider()(request);
  const requestedAccounts=[...new Set(g.calls.filter(q=>q.method==='query').map(q=>q.params.account_id))].sort();
  assert.deepEqual(requestedAccounts,[manifest.binding.signerId,manifest.binding.mandateId,manifest.creation.factory,manifest.ownerId,...manifest.approved.job.vendorIds].sort());
  assert.deepEqual([...new Set(g.calls.map(q=>q.method))].sort(),['EXPERIMENTAL_protocol_config','block','gas_price','query','status'].sort());
});

