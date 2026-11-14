import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { baseEncode } from 'near-api-js';
import { createNearOwnerOperations } from '../../src/server/near-owner-operations.mjs';
import { approvedSources } from '../../src/shared/job-contract.mjs';

const digest = s => baseEncode(createHash('sha256').update(s).digest());
const opId = (jobId, action) => createHash('sha256').update(JSON.stringify(['haldir-owner-v1', jobId, action])).digest('hex');
const RPC = 'https://rpc.testnet.near.org';
const terms = m => ({...m.creation,agent:m.binding.signerId,allowlist:m.approved.job.vendorIds,cap:m.approved.job.budgetAtomic,
  deadline_ns:String(BigInt(Date.parse(m.approved.job.expiresAt))*1000000n),stop_gas:'100000000000000',withdraw_gas:'100000000000000'});
function fixture(action = 'create') {
  const ownerId = 'owner.testnet', factory = 'factory.testnet', label = 'job';
  const mandateId = 'j' + createHash('sha256').update(`${ownerId}:${label}`).digest('hex').slice(0,32) + '.' + factory;
  const scope = { networkId: 'testnet', mandateId, purpose: 'Fictional supplier', output: 'Report', budgetAtomic: '100', vendorIds: ['vendor.testnet'], expiresAt: '2026-11-14T10:00:00Z' };
  const manifest = { manifestId: 'manifest-1', ownerId, binding: { networkId: 'testnet', ownerId, mandateId,
    signerId: 'agent.testnet', codeHash: digest('code') }, approved: { job: scope, quote: { networkId: 'testnet', mandateId, vendorId: 'vendor.testnet', amountAtomic: '10', orderId: 'order1', content: 'Fictional records' } },
    creation: { factory, factoryCodeHash: digest('factory'), job_label: label, operating_float: '50', create_gas: '300000000000000' } };
  const job = { jobId: 'job-1', ownerId, scope, publicManifest: manifest };
  const operationId = opId(job.jobId, action);
  const row = { operationId, jobId: job.jobId, ownerId, action, transactionHash: null, request: null, status: 'PREPARING' };
  const data = { jobs: { [job.jobId]: job }, ownerOperations: { [operationId]: row } };
  const repository = { async runTransaction(fn) { return fn({ async get(c,k) { return structuredClone(data[c]?.[k] ?? null); } }); } };
  return { data, job, manifest, row, repository, input: { job, manifest, ownerId, operationId, action },
    options: { repository, rpcUrl: RPC, allowedRpcUrls: [RPC] } };
}

test('prepare rejects inconsistent persisted approval, replay identity, arbitrary actions and malformed immutable terms', async () => {
  for (const mutate of [
    f => { f.input.ownerId = 'other.testnet'; },
    f => { f.input.operationId = opId('foreign-job', 'create'); },
    f => { f.input.action = 'claim_creation_refund'; },
    f => { f.manifest.creation.operating_float = '0'; },
    f => { f.manifest.creation.create_gas = '01'; },
    f => { f.manifest.approved.quote.vendorId = 'other.testnet'; },
    f => { f.manifest.binding.signerId = f.input.ownerId; },
    f => { f.manifest.creation.privateKey = 'forbidden'; },
    f => { f.manifest.binding.ownerId = 'other.testnet'; },
    f => { f.manifest.binding.networkId = 'mainnet'; },
    f => { f.manifest.binding.mandateId = 'wrong.testnet'; },
    f => { f.job.scope.budgetAtomic = '1'; },
    f => { f.manifest.approved.job.expiresAt = 'invalid'; },
    f => { f.data.ownerOperations[f.row.operationId].jobId = 'foreign'; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(createNearOwnerOperations(f.options).prepare(f.input), { code: 'OWNER_BINDING_INVALID' });
  }
});

test('public configuration denies injection, insecure/unapproved RPC and non-testnet network', () => {
  for (const delta of [{rpcUrl:'http://rpc.testnet.near.org'}, {allowedRpcUrls:[]}, {provider:{}}, {networkId:'mainnet'},
    {rpcUrl:'https://user:password@rpc.testnet.near.org'}, {timeoutMs:0}, {maxReceipts:257}, {localTestOnly:'true'},
    {localTestOnly:true,provider:{},networkId:'testnet'}, {localTestOnly:true,provider:{},networkId:'sandbox',rpcUrl:'http://localhost:1234'}]) {
    assert.throws(() => createNearOwnerOperations({...fixture().options,...delta}), {code:'RPC_CONFIGURATION_INVALID'});
  }
});

function evidenceFixture() {
  const f = fixture('withdraw'), m = f.manifest, t = terms(m);
  m.binding.networkId = f.job.scope.networkId = m.approved.quote.networkId = 'sandbox-fixture';
  const txid = digest('withdraw'), root = digest('root'), transfer = digest('transfer'), callback = digest('callback'), refund = digest('refund');
  const block = digest('block'), publicKey = 'ed25519:11111111111111111111111111111111';
  const call = { FunctionCall: {method_name:'withdraw',args:'e30=',gas:t.withdraw_gas,deposit:'0'} };
  const row = (id,executor_id,receipt_ids,status) => ({id,block_hash:block,outcome:{executor_id,receipt_ids,status}});
  const record = (id,predecessor_id,receiver_id,actions,input_data_ids=[],output_data_receivers=[]) => ({receipt_id:id,predecessor_id,receiver_id,
    receipt:{Action:{signer_id:f.input.ownerId,signer_public_key:publicKey,actions,input_data_ids,output_data_receivers}}});
  const tx = { final_execution_status:'FINAL',status:{SuccessValue:Buffer.from('true').toString('base64')},
    transaction:{hash:txid,signer_id:f.input.ownerId,public_key:publicKey,receiver_id:m.binding.mandateId,actions:[call]},
    transaction_outcome:row(txid,f.input.ownerId,[root],{SuccessReceiptId:root}), receipts_outcome:[
      row(root,m.binding.mandateId,[transfer,callback,refund],{SuccessReceiptId:callback}), row(transfer,f.input.ownerId,[],{SuccessValue:''}),
      row(callback,m.binding.mandateId,[],{SuccessValue:Buffer.from('true').toString('base64')}),row(refund,f.input.ownerId,[],{SuccessValue:''})] };
  const records = [record(root,f.input.ownerId,m.binding.mandateId,[call]),record(transfer,m.binding.mandateId,f.input.ownerId,[{Transfer:{deposit:'80'}}],[],[{receiver_id:m.binding.mandateId,data_id:digest('data')}]),
    record(callback,m.binding.mandateId,m.binding.mandateId,[{FunctionCall:{method_name:'on_refund',args:Buffer.from('{"nonce":"1"}').toString('base64'),gas:'20000000000000',deposit:'0'}}],[digest('data')]),
    record(refund,'system',f.input.ownerId,[{Transfer:{deposit:'2'}}])];
  f.row.transactionHash = txid;
  f.row.status = 'SUBMITTED';
  f.row.request = {network:'sandbox-fixture',signerId:f.input.ownerId,receiverId:m.binding.mandateId,methodName:'withdraw',args:{},gas:t.withdraw_gas,deposit:'0'};
  f.input.transactionHash = txid; f.input.signerId = f.input.ownerId;
  const state = {owner:f.input.ownerId,agent:t.agent,allowlist:t.allowlist,cap:t.cap,deadline_ns:t.deadline_ns,stopped:true,refunded:'80',free:'0',reserved:'0',in_flight:null};
  let reads = 0;
  const provider = {
    async viewNodeStatus() { reads++; return {chain_id:'sandbox-fixture',sync_info:{syncing:false}}; },
    async viewTransactionStatusWithReceipts(params) { assert.equal(params.waitUntil,'FINAL'); return structuredClone(tx); },
    async viewTransactionReceipt(id) { return structuredClone(records.find(r => r.receipt_id === id)); },
    async viewBlock() { return {header:{hash:block,height:100}}; },
    async query(params) {
      assert.equal(params.block_id,block);
      const common = {block_hash:block,block_height:100};
      if(params.request_type === 'view_code') return {...common,hash:m.binding.codeHash,code_base64:Buffer.from('code').toString('base64')};
      if(params.request_type === 'view_access_key_list') return {...common,keys:[]};
      if(params.request_type === 'call_function') return {...common,result:[...Buffer.from(JSON.stringify(state))]};
      throw new Error('unexpected fixture query');
    }
  };
  return {...f,tx,records,state,provider,ids:{txid,root,transfer,callback,refund,block},get reads(){return reads;},
    options:{...f.options,localTestOnly:true,networkId:'sandbox-fixture',rpcUrl:'http://127.0.0.1:12345',provider}};
}

test('reconcile confirms only the actual causal native withdraw and exact API observation fields', async () => {
  const f = evidenceFixture();
  const result = await createNearOwnerOperations(f.options).reconcile(f.input);
  assert.deepEqual(result,{networkId:'sandbox-fixture',ownerId:f.input.ownerId,mandateId:f.manifest.binding.mandateId,
    action:'withdraw',transactionHash:f.ids.txid,signerId:f.input.ownerId,finality:'final',status:'CONFIRMED',receiptId:f.ids.transfer,amountAtomic:'80'});
});

for (const [name,mutate] of [
  ['stored hash replay', f => { f.row.transactionHash = digest('another-withdraw'); }],
  ['stored request scope', f => { f.row.request.deposit = '1'; }],
  ['wrong owner', f => { f.tx.transaction.signer_id = 'other.testnet'; }],
  ['wrong receiver', f => { f.tx.transaction.receiver_id = 'other.testnet'; }],
  ['wrong args', f => { f.tx.transaction.actions[0].FunctionCall.args = Buffer.from('{"owner":"other.testnet"}').toString('base64'); }],
  ['wrong deposit', f => { f.tx.transaction.actions[0].FunctionCall.deposit = '1'; }],
  ['wrong gas', f => { f.tx.transaction.actions[0].FunctionCall.gas = '1'; }],
  ['wrong hash', f => { f.tx.transaction.hash = digest('another'); }],
  ['nonfinal', f => { f.tx.final_execution_status = 'EXECUTED'; }],
  ['mainnet', f => { f.provider.viewNodeStatus = async () => ({chain_id:'mainnet'}); }],
  ['top success only', f => { f.tx.receipts_outcome = []; f.records.length = 0; }],
  ['missing receipt', f => { f.records.splice(1,1); }],
  ['missing outcome', f => { f.tx.receipts_outcome.splice(1,1); }],
  ['pruned', f => { f.provider.viewTransactionReceipt = async () => {throw Error('pruned');}; }],
  ['unrelated gas refund only', f => { f.records[1].predecessor_id = 'system'; f.records[1].receipt.Action.output_data_receivers = []; }],
  ['wrong fixed return owner', f => { f.records[1].receiver_id = f.tx.receipts_outcome[1].outcome.executor_id = 'other.testnet'; }],
  ['failed transfer', f => { f.tx.receipts_outcome[1].outcome.status = {Failure:{ActionError:{}}}; }],
  ['false callback', f => { f.tx.receipts_outcome[2].outcome.status = {SuccessValue:Buffer.from('false').toString('base64')}; }],
  ['detached callback dependency', f => { f.records[2].receipt.Action.input_data_ids = [digest('wrong-data')]; }],
  ['callback nonce injection', f => { f.records[2].receipt.Action.actions[0].FunctionCall.args = Buffer.from('{"nonce":"1","owner":"other.testnet"}').toString('base64'); }],
  ['mutable code', f => { const q=f.provider.query; f.provider.query=async p => p.request_type==='view_code'?{...(await q(p)),hash:digest('evil')}:q(p); }],
  ['residual full access key', f => { const q=f.provider.query; f.provider.query=async p => p.request_type==='view_access_key_list'?{...(await q(p)),keys:[{access_key:{permission:'FullAccess'}}]}:q(p); }],
  ['truncated keyless query', f => { const q=f.provider.query; f.provider.query=async p => p.request_type==='view_access_key_list'?{...(await q(p)),last_key:'more'}:q(p); }],
  ['unknown sync state', f => { f.provider.viewNodeStatus=async()=>({chain_id:'sandbox-fixture'}); }],
  ['wrong state owner', f => { f.state.owner = 'other.testnet'; }],
  ['unrelated outcome', f => { f.tx.receipts_outcome.push({...structuredClone(f.tx.receipts_outcome[1]),id:digest('extra')}); }],
  ['unexpected non-system child call', f => {
    const id=digest('unexpected-child'); f.tx.receipts_outcome[0].outcome.receipt_ids.push(id);
    f.tx.receipts_outcome.push({id,block_hash:f.ids.block,outcome:{executor_id:f.manifest.binding.mandateId,receipt_ids:[],status:{SuccessValue:''}}});
    const r=structuredClone(f.records[2]); r.receipt_id=id; r.receipt.Action.input_data_ids=[];
    r.receipt.Action.actions=[{FunctionCall:{method_name:'stop',args:'e30=',gas:'100000000000000',deposit:'0'}}]; f.records.push(r);
  }],
  ['wrong code bytes', f => { const q=f.provider.query; f.provider.query=async p => p.request_type==='view_code'?{...(await q(p)),code_base64:Buffer.from('evil').toString('base64')}:q(p); }],
]) test(`withdraw UNKNOWN: ${name}`,async () => {
  const f = evidenceFixture(); mutate(f);
  const result = await createNearOwnerOperations(f.options).reconcile(f.input);
  assert.equal(result.status,'UNKNOWN'); assert.equal(result.amountAtomic,undefined); assert.equal(result.receiptId,undefined);
});

test('aborted and deadline-expired providers return UNKNOWN without late acceptance',async () => {
  const f=evidenceFixture(), ac=new AbortController(); ac.abort();
  assert.equal((await createNearOwnerOperations(f.options).reconcile({...f.input,signal:ac.signal})).status,'UNKNOWN');
  f.provider.viewNodeStatus=async () => new Promise(resolve=>setTimeout(()=>resolve({chain_id:'sandbox-fixture'}),30));
  assert.equal((await createNearOwnerOperations({...f.options,timeoutMs:5}).reconcile(f.input)).status,'UNKNOWN');
});

// A coherent persisted operation: request/hash/action all agree before terms()
// and only the RPC boundary is synthetic. No owner-success adapter is replaced.
function ownerEvidence(action, two = true) {
  const f = evidenceFixture(), m = f.manifest;
  if (two) {
    const first = m.approved.quote, second = {...first,vendorId:'second.testnet',orderId:'order2',content:'Fictional background',amountAtomic:'20'};
    f.job.scope.vendorIds = [first.vendorId,second.vendorId];
    m.approved = {schemaVersion:'haldir.approved.two-source.v1',job:f.job.scope,
      sources:[{sourceId:'company-records',quote:first},{sourceId:'background-research',quote:second}]};
  }
  assert.equal(approvedSources(m.approved).length,two?2:1);
  const t = terms(m), oldId = f.row.operationId;
  f.input.action = f.row.action = action;
  f.input.operationId = f.row.operationId = opId(f.job.jobId,action);
  delete f.data.ownerOperations[oldId]; f.data.ownerOperations[f.row.operationId] = f.row;
  const request = action === 'create' ? {network:'sandbox-fixture',signerId:f.input.ownerId,receiverId:t.factory,methodName:'create_job',
    args:{job_label:t.job_label,agent:t.agent,allowlist:t.allowlist,cap:t.cap,deadline_ns:t.deadline_ns,operating_float:t.operating_float},gas:t.create_gas,deposit:'150'} :
    {network:'sandbox-fixture',signerId:f.input.ownerId,receiverId:m.binding.mandateId,methodName:action,args:{},gas:t[`${action}_gas`],deposit:'0'};
  f.row.request = request;
  const call = {FunctionCall:{method_name:request.methodName,args:Buffer.from(JSON.stringify(request.args)).toString('base64'),gas:request.gas,deposit:request.deposit}};
  f.tx.transaction.receiver_id = request.receiverId; f.tx.transaction.actions = [call];
  f.records[0].receiver_id = request.receiverId; f.records[0].receipt.Action.actions = [call];
  f.tx.receipts_outcome[0].outcome.executor_id = request.receiverId;
  f.state.allowlist = t.allowlist;
  if (action === 'stop') {
    f.tx.status = {SuccessValue:''}; f.tx.receipts_outcome[0].outcome.status = {SuccessValue:''};
    f.tx.receipts_outcome[0].outcome.receipt_ids = [f.ids.refund];
    f.tx.receipts_outcome = f.tx.receipts_outcome.filter(r=>[f.ids.root,f.ids.refund].includes(r.id));
    f.records.splice(1,2);
  } else if (action === 'create') {
    m.chainEvidence = {deployment:'FACTORY_READY'};
    f.state.stopped = false;
    const deploy = f.records[1], callback = f.records[2];
    deploy.predecessor_id = t.factory; deploy.receiver_id = m.binding.mandateId;
    deploy.receipt.Action.actions = ['CreateAccount',{Transfer:{deposit:t.operating_float}},{DeployContract:{code:createHash('sha256').update('code').digest('base64')}},
      {FunctionCall:{method_name:'new_from_factory',args:Buffer.from(JSON.stringify({owner:f.input.ownerId,agent:t.agent,allowlist:t.allowlist,cap:t.cap,deadline_ns:t.deadline_ns})).toString('base64'),gas:'100000000000000',deposit:t.cap}}];
    deploy.receipt.Action.output_data_receivers[0].receiver_id = t.factory;
    f.tx.receipts_outcome[1].outcome.executor_id = m.binding.mandateId;
    callback.predecessor_id = callback.receiver_id = t.factory;
    callback.receipt.Action.actions = [{FunctionCall:{method_name:'on_create',args:Buffer.from(JSON.stringify({job:m.binding.mandateId})).toString('base64'),gas:'20000000000000',deposit:'0'}}];
    f.tx.receipts_outcome[2].outcome.executor_id = t.factory;
  }
  const query = f.provider.query;
  f.provider.query = async p => {
    if(action==='create' && p.account_id===t.factory && p.request_type==='view_code')
      return {block_hash:f.ids.block,block_height:100,hash:m.creation.factoryCodeHash,code_base64:Buffer.from('factory').toString('base64')};
    if(action==='create' && p.method_name==='get_entry')
      return {block_hash:f.ids.block,block_height:100,result:[...Buffer.from(JSON.stringify({job:m.binding.mandateId,owner:f.input.ownerId,amount:'150',state:'ready'}))]};
    return query(p);
  };
  return {...f,expectedRequest:request};
}

for (const action of ['create','stop','withdraw']) {
  test(`TS1 concrete prepare ${action} accepts the exact shared two-source contract`,async()=>{
    const f=ownerEvidence(action), {transactionHash,signerId,...input}=f.input;
    assert.deepEqual(Object.keys(f.manifest.approved).sort(),['job','schemaVersion','sources']);
    assert.deepEqual(await createNearOwnerOperations(f.options).prepare(input),f.expectedRequest);
  });
  test(`TS1 concrete reconcile ${action} reaches causal proof with coherent persisted request and hash`,async()=>{
    const f=ownerEvidence(action);
    assert.equal(f.row.transactionHash,f.input.transactionHash);
    assert.deepEqual(f.row.request,f.expectedRequest);
    const observation=await createNearOwnerOperations(f.options).reconcile(f.input);
    assert.equal(observation.status,'CONFIRMED'); assert.equal(observation.finality,'final');
    assert.equal(observation.transactionHash,f.row.transactionHash);
    assert.equal(observation.receiptId,action==='stop'?f.ids.root:f.ids.transfer);
    assert.equal(observation.amountAtomic,action==='withdraw'?'80':undefined);
  });
}

for (const action of ['create','stop','withdraw']) {
  test(`legacy concrete reconcile ${action} retains causal confirmation`,async()=>{
    const f=ownerEvidence(action,false);
    assert.equal((await createNearOwnerOperations(f.options).reconcile(f.input)).status,'CONFIRMED');
  });
  for (const [name,mutate] of [
    ['second-source wrong mandate',f=>{f.manifest.approved.sources[1].quote.mandateId='foreign.testnet';}],
    ['second-source wrong network',f=>{f.manifest.approved.sources[1].quote.networkId='mainnet';}],
    ['second-source wrong vendor',f=>{f.manifest.approved.sources[1].quote.vendorId='foreign.testnet';}],
    ['second-source amount cap overflow',f=>{f.manifest.approved.sources[1].quote.amountAtomic='101';}],
    ['combined amount cap overflow',f=>{f.manifest.approved.sources[1].quote.amountAtomic='95';}],
    ['second-source duplicate order',f=>{f.manifest.approved.sources[1].quote.orderId='order1';}],
    ['second-source duplicate content',f=>{f.manifest.approved.sources[1].quote.content=f.manifest.approved.sources[0].quote.content;}],
    ['extra legacy quote alias',f=>{f.manifest.approved.quote=f.manifest.approved.sources[0].quote;}],
    ['wrong owner binding',f=>{f.manifest.binding.ownerId='foreign.testnet';}],
    ['wrong mandate binding',f=>{f.manifest.binding.mandateId='foreign.testnet';}],
    ['wrong job identity',f=>{f.row.jobId='foreign';}],
    ['wrong operation replay',f=>{f.input.operationId=opId('foreign',action);}],
    ['wrong deadline',f=>{f.manifest.approved.job.expiresAt='invalid';}],
  ]) test(`TS1 ${action} rejects ${name} before external evidence`,async()=>{
    const f=ownerEvidence(action);mutate(f);let reads=0;
    f.provider.viewNodeStatus=async()=>{reads++;throw Error('unexpected evidence read');};
    const {transactionHash,signerId,...input}=f.input;
    await assert.rejects(createNearOwnerOperations(f.options).prepare(input),{code:'OWNER_BINDING_INVALID'});
    const result=await createNearOwnerOperations(f.options).reconcile(f.input);
    assert.equal(result.status,'UNKNOWN');assert.equal(result.receiptId,undefined);assert.equal(result.amountAtomic,undefined);assert.equal(reads,0);
  });
  for (const [name,mutate] of [
    ['missing root receipt',f=>{f.records.splice(0,1);}],
    ['wrong root predecessor',f=>{f.records[0].predecessor_id='foreign.testnet';}],
    ['wrong receipt action',f=>{f.records[0].receipt.Action.actions[0].FunctionCall.method_name='other';}],
    ['wrong stored transaction hash',f=>{f.row.transactionHash=digest('other');}],
    ['wrong persisted request',f=>{f.row.request=structuredClone(f.row.request);f.row.request.deposit='1';}],
    ['wrong authoritative cap',f=>{f.state.cap='101';}],
    ['wrong authoritative owner',f=>{f.state.owner='foreign.testnet';}],
    ['wrong authoritative deadline',f=>{f.state.deadline_ns='1';}],
    ['nonfinal transaction',f=>{f.tx.final_execution_status='EXECUTED';}],
  ]) test(`TS1 ${action} UNKNOWN retains uncertainty: ${name}`,async()=>{
    const f=ownerEvidence(action);mutate(f);
    const result=await createNearOwnerOperations(f.options).reconcile(f.input);
    assert.equal(result.status,'UNKNOWN');assert.equal(result.receiptId,undefined);assert.equal(result.amountAtomic,undefined);
  });
}

function publicFixture(f=evidenceFixture()) {
  f.manifest.binding.networkId=f.job.scope.networkId='testnet'; f.row.request.network='testnet';
  for(const {quote} of f.manifest.approved.sources??[{quote:f.manifest.approved.quote}])quote.networkId='testnet';
  let attempts=0;
  const transport=async (url,init) => {
    attempts++; assert.equal(url,RPC); assert.equal(init.redirect,'error'); assert.ok(init.signal instanceof AbortSignal);
    const {id,method,params}=JSON.parse(init.body); let result;
    if(method==='status') result={chain_id:'testnet',sync_info:{syncing:false}};
    else if(method==='EXPERIMENTAL_tx_status') {assert.equal(params.wait_until,'FINAL'); assert.equal(params.tx_hash,f.ids.txid); result=f.tx;}
    else if(method==='EXPERIMENTAL_receipt') result=f.records.find(r=>r.receipt_id===params.receipt_id);
    else if(method==='block') result=await f.provider.viewBlock(params);
    else if(method==='query') result=await f.provider.query(params);
    else throw Error('unexpected or mutating RPC');
    return new Response(JSON.stringify({jsonrpc:'2.0',id,result}),{headers:{'Content-Type':'application/json'}});
  };
  return {...f,options:{...fixture().options,repository:f.repository},transport,get attempts(){return attempts;}};
}

test('public SDK reader verifies testnet on each call with bounded no-redirect HTTPS transport',async () => {
  const f=publicFixture(), before=globalThis.fetch;
  globalThis.fetch=f.transport;
  try {
    const p=createNearOwnerOperations(f.options);
    assert.equal((await p.reconcile(f.input)).status,'CONFIRMED');
    assert.equal((await p.reconcile(f.input)).status,'CONFIRMED');
    assert.ok(f.attempts>=20);
  } finally {globalThis.fetch=before;}
});

for(const action of ['create','stop','withdraw'])test(`TS1 public SDK ${action} proves only the synthetic causal receipt`,async()=>{
  const f=publicFixture(ownerEvidence(action)),before=globalThis.fetch;
  globalThis.fetch=f.transport;
  try {
    const p=createNearOwnerOperations(f.options), {transactionHash,signerId,...input}=f.input;
    assert.deepEqual(await p.prepare(input),f.row.request);
    const result=await p.reconcile(f.input);
    assert.deepEqual(result,{networkId:'testnet',ownerId:f.input.ownerId,mandateId:f.manifest.binding.mandateId,action,
      transactionHash:f.ids.txid,signerId:f.input.ownerId,finality:'final',status:'CONFIRMED',receiptId:action==='stop'?f.ids.root:f.ids.transfer,
      ...(action==='withdraw'?{amountAtomic:'80'}:{})});
    assert.ok(f.attempts>=7);
  } finally {globalThis.fetch=before;}
});

for(const action of ['create','withdraw'])test(`TS1 ${action} detached callback stays UNKNOWN without returned-money assertion`,async()=>{
  const f=ownerEvidence(action);f.records[2].receipt.Action.input_data_ids=[digest('unrelated')];
  const result=await createNearOwnerOperations(f.options).reconcile(f.input);
  assert.equal(result.status,'UNKNOWN');assert.equal(result.receiptId,undefined);assert.equal(result.amountAtomic,undefined);
});

test('public transport cancels rejected response bodies rather than leaving reads alive',async () => {
  const before=globalThis.fetch;
  try {
    for(const headers of [{status:503}, {status:200,headers:{'Content-Length':'999999999'}}]) {
      let cancelled=false;
      globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),headers);
      const f=publicFixture();
      assert.equal((await createNearOwnerOperations(f.options).reconcile(f.input)).status,'UNKNOWN');
      assert.equal(cancelled,true);
    }
  } finally {globalThis.fetch=before;}
});

for(const [name,respond] of [
  ['HTTP failure',()=>new Response('{"jsonrpc":"2.0","id":"1","result":{"chain_id":"testnet"}}',{status:500})],
  ['redirect',()=>new Response('',{status:302,headers:{Location:'https://evil.invalid'}})],
  ['wrong RPC id',()=>new Response('{"jsonrpc":"2.0","id":"wrong","result":{"chain_id":"testnet"}}')],
  ['RPC error',()=>new Response('{"jsonrpc":"2.0","id":"1","error":{"message":"pruned"}}')],
  ['wrong chain',()=>new Response('{"jsonrpc":"2.0","id":"1","result":{"chain_id":"mainnet"}}')],
  ['oversize chunked body',()=>new Response('x'.repeat(2048))],
]) test(`public transport UNKNOWN: ${name}`,async()=>{
  const before=globalThis.fetch,f=publicFixture(); let calls=0;
  globalThis.fetch=async()=>{calls++;return respond();};
  try {assert.equal((await createNearOwnerOperations({...f.options,maxResponseBytes:1024}).reconcile(f.input)).status,'UNKNOWN');assert.equal(calls,1);}
  finally{globalThis.fetch=before;}
});

test('public response-body stall expires and cancels its reader',async()=>{
  const before=globalThis.fetch,f=publicFixture(); let cancelled=false,started=false;
  const response=new Response(new ReadableStream({pull(){started=true;},cancel(){cancelled=true;}},{highWaterMark:0}));
  globalThis.fetch=async()=>response;
  try {
    const result=await createNearOwnerOperations({...f.options,timeoutMs:30}).reconcile(f.input);
    assert.equal(result.status,'UNKNOWN');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(started,true);assert.equal(cancelled,true);
  } finally {globalThis.fetch=before;}
});

test('late HTTP response after UNKNOWN is cancelled and cannot trigger further RPC',async()=>{
  const before=globalThis.fetch,f=publicFixture();let release,cancelled=false,calls=0;
  const pending=new Promise(resolve=>{release=resolve;});
  globalThis.fetch=()=>{calls++;return pending;};
  try {
    assert.equal((await createNearOwnerOperations({...f.options,timeoutMs:5}).reconcile(f.input)).status,'UNKNOWN');
    release(new Response(new ReadableStream({cancel(){cancelled=true;}})));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,1);assert.equal(cancelled,true);
  } finally {globalThis.fetch=before;}
});

test('explicit FINAL root failure is FAILED; failed callback after transfer stays UNKNOWN',async()=>{
  const f=evidenceFixture();
  f.tx.status={Failure:{ActionError:{kind:'FunctionCallError'}}};
  f.tx.receipts_outcome=f.tx.receipts_outcome.filter(r=>[f.ids.root,f.ids.refund].includes(r.id));
  f.tx.receipts_outcome[0].outcome.receipt_ids=[f.ids.refund];
  f.tx.receipts_outcome[0].outcome.status=f.tx.status;
  f.records.splice(1,2);
  const result=await createNearOwnerOperations(f.options).reconcile(f.input);
  assert.equal(result.status,'FAILED'); assert.equal(result.finality,'final'); assert.equal(result.receiptId,f.ids.root); assert.equal(result.amountAtomic,undefined);
});

test('existing approved mandates can stop/withdraw without optional creation terms; create cannot',async()=>{
  for(const action of ['stop','withdraw']) {
    const f=fixture(action);delete f.manifest.creation;
    const request=await createNearOwnerOperations(f.options).prepare(f.input);
    assert.equal(request.receiverId,f.manifest.binding.mandateId);assert.equal(request.methodName,action);
  }
  const f=evidenceFixture();delete f.manifest.creation;
  assert.equal((await createNearOwnerOperations(f.options).reconcile(f.input)).status,'CONFIRMED');
  const c=fixture();delete c.manifest.creation;
  await assert.rejects(createNearOwnerOperations(c.options).prepare(c.input),{code:'OWNER_BINDING_INVALID'});
});

 test('prepare emits exact JSON create_job unsigned call and nothing signable or secret', async () => {
  const f = fixture(), p = createNearOwnerOperations(f.options), t = terms(f.manifest);
  assert.deepEqual(await p.prepare(f.input), { network: 'testnet', signerId: f.input.ownerId, receiverId: t.factory, methodName: 'create_job',
    args: { job_label: t.job_label, agent: t.agent, allowlist: t.allowlist, cap: t.cap, deadline_ns: t.deadline_ns, operating_float: t.operating_float }, gas: t.create_gas, deposit: '150' });
  for (const action of ['stop','withdraw']) {
    const f = fixture(action);
    assert.deepEqual(await createNearOwnerOperations(f.options).prepare(f.input), { network: 'testnet', signerId: f.input.ownerId,
      receiverId: f.manifest.binding.mandateId, methodName: action, args: {}, gas: '100000000000000', deposit: '0' });
  }
});
