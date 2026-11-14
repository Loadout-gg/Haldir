import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { baseEncode } from 'near-api-js';
import { createPublicOrders, openLocalRepository } from '../../src/server/orders.mjs';
import { createNearMandateStatusReader } from '../../src/server/near-mandate-status.mjs';
const deployment = JSON.parse(await readFile(new URL('../../deployment/haldir-testnet/manifest.synthetic-fixture.json', import.meta.url)));
const time = Date.parse('2026-11-13T10:00:00Z'), blockHash = baseEncode(new Uint8Array(32).fill(7));
const url = 'https://closed-economics.invalid';
async function fixture(t, options = {}) {
  const b = structuredClone(deployment.runtime_binding);
  const job = { networkId:'testnet', mandateId:b.mandateId, purpose:'Fictional research', output:'Report', budgetAtomic:'30', vendorIds:['records.testnet','background.testnet'], expiresAt:'2026-11-13T18:00:00Z' };
  const manifest = { manifestId:'economics',ownerId:b.ownerId,binding:b,rpcUrl:url,allowedRpcUrls:[url],
    approved:{schemaVersion:'haldir.approved.two-source.v1',job,sources:job.vendorIds.map((vendorId,i)=>({sourceId:i?'background-research':'company-records',quote:{networkId:'testnet',mandateId:b.mandateId,vendorId,amountAtomic:i?'9':'8',orderId:'order-'+i,content:'Fictional sample '+i}}))},
    chainEvidence:{networkId:'testnet',finality:'final',blockHash,blockHeight:123,observedAt:time-1000} };
  const repository = openLocalRepository({filename:':memory:',localTestOnly:true}); t.after(()=>repository.close());
  const orders = createPublicOrders({repository,trustedManifestProvider:async()=>structuredClone(manifest),now:()=>time});
  const admitted = await orders.createJob({ownerId:b.ownerId,approvalId:'economics',admissionKey:'economics'});
  const state = {owner:b.ownerId,agent:b.signerId,allowlist:structuredClone(job.vendorIds),cap:'30',deadline_ns:String(BigInt(Date.parse(job.expiresAt))*1000000n),spent:'8',refunded:'2',reserved:'9',free:'11',stopped:false,expired:false,in_flight:'payment:order-1',refund_nonce:'1',orders:[{order_id:'order-0',recipient:job.vendorIds[0],amount:'8',state:'paid'},{order_id:'order-1',recipient:job.vendorIds[1],amount:'9',state:'pending'}]};
  const calls = [], evidence = {block_hash:blockHash,block_height:456};
  const transport = async (endpoint,init)=>{
    assert.equal(endpoint,url); assert.equal(init.method,'POST'); assert.equal(init.redirect,'error'); assert.ok(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted,false);
    const q=JSON.parse(init.body);calls.push(q); let result;
    if(q.method==='status'){assert.deepEqual(q.params,[]);result={chain_id:'testnet',sync_info:{syncing:false}};}
    else if(q.method==='block'){assert.deepEqual(q.params,{finality:'final'});result={header:{hash:blockHash,height:456,timestamp_nanosec:String(BigInt(time-1000)*1000000n)}};}
    else { assert.equal(q.method,'query'); assert.equal(q.params.account_id,b.mandateId);assert.equal(q.params.block_id,blockHash);assert.equal(q.params.finality,undefined);
      if(q.params.request_type==='view_account'){assert.deepEqual(q.params,{request_type:'view_account',account_id:b.mandateId,block_id:blockHash}); result={...evidence,code_hash:b.codeHash};}
      else {assert.deepEqual(q.params,{request_type:'call_function',account_id:b.mandateId,block_id:blockHash,method_name:'get_status',args_base64:'e30='});result={...evidence,result:[...Buffer.from(JSON.stringify(state))],logs:[]};}
    }
    result=options.mutate?.(result,q)??result;
    return Response.json({jsonrpc:'2.0',id:q.id,result});
  };
  const input={ownerId:b.ownerId,jobId:admitted.jobId,manifest,signal:new AbortController().signal};
  const reader=(config={})=>createNearMandateStatusReader({repository,rpcUrl:url,allowedRpcUrls:[url],transport,now:()=>time,timeoutMs:1000,...config});
  return {repository,orders,manifest,admitted,state,calls,transport,input,reader};
}
test.beforeEach(t=>{let forbidden=0;t.mock.method(globalThis,'fetch',async()=>{forbidden++;throw new Error('FORBIDDEN_NETWORK');});t.after(()=>assert.equal(forbidden,0));});
test('admitted TS1 job observes literal reserved principal using real installed SDK at one final block',async t=>{
 const f=await fixture(t), result=await f.reader()(f.input);
 assert.deepEqual(result,{schemaVersion:'haldir.mandate-economics.v1',state:'known',networkId:'testnet',ownerId:f.input.ownerId,mandateId:f.manifest.binding.mandateId,source:{rpcUrl:url,method:'get_status',finality:'final'},observation:{blockHash,blockHeight:456,blockTimestampNs:String(BigInt(time-1000)*1000000n),observedAt:time},amounts:{capAtomic:'30',spentAtomic:'8',reservedAtomic:'9',availableAtomic:'11',refundedAtomic:'2'},reason:null});
 assert.equal(f.calls.length,4); assert.deepEqual(f.calls.map(q=>q.method),['status','block','query','query']);
 assert.deepEqual(await f.orders.getJob({ownerId:f.input.ownerId,jobId:f.input.jobId}),f.admitted);
});

test('old final block is historical stale, not freshened by generated observedAt',async t=>{
 const f=await fixture(t,{mutate:(r,q)=>{if(q.method==='block')r.header.timestamp_nanosec=String(BigInt(time-30001)*1000000n);return r;}});
 const r=await f.reader()(f.input); assert.equal(r.state,'stale');assert.equal(r.reason,'STALE_BLOCK');assert.equal(r.observation.observedAt,time);assert.equal(r.amounts.availableAtomic,'11');
});
test('stopped and expired persisted job with old admitted evidence still observes principal',async t=>{
 const f=await fixture(t); f.state.stopped=true; f.state.expired=true;
 await f.orders; const future=time+9*3600000;
 await f.repository.runTransaction(async tx=>{const j=await tx.get('jobs',f.input.jobId);tx.set('jobs',j.jobId,{...j,state:'LOCAL_STOPPED'});});
 const transport=async(u,i)=>{const q=JSON.parse(i.body),r=await f.transport(u,i);if(q.method!=='block')return r;const p=await r.json();p.result.header.timestamp_nanosec=String(BigInt(future-1000)*1000000n);return Response.json(p);};
 const r=await f.reader({now:()=>future,transport})(f.input);assert.equal(r.state,'known');assert.equal(r.amounts.reservedAtomic,'9');
});
test('exact official UNKNOWN_ACCOUNT absence of bound child at selected block is NOT_DEPLOYED',async t=>{
 const f=await fixture(t);const transport=async(u,i)=>{const q=JSON.parse(i.body);if(q.params.request_type==='view_account')return Response.json({jsonrpc:'2.0',id:q.id,error:{name:'HANDLER_ERROR',cause:{name:'UNKNOWN_ACCOUNT',info:{requested_account_id:f.input.manifest.binding.mandateId,block_hash:blockHash,block_height:456}}}});return f.transport(u,i);};
 const r=await f.reader({transport})(f.input);assert.equal(r.reason,'NOT_DEPLOYED');assert.equal(r.amounts,null);assert.equal(r.observation,null);
});
for(const [name,change] of [
 ['owner',s=>{s.owner='foreign.testnet';}],['agent',s=>{s.agent='foreign.testnet';}],['cap',s=>{s.cap='31';}],['allowlist',s=>{s.allowlist.reverse();}],['deadline',s=>{s.deadline_ns='1';}],
 ['sum',s=>{s.free='12';}],['overflow',s=>{s.free=String(2n**128n);}],['negative',s=>{s.spent='-1';}],['numeric',s=>{s.reserved=9;}],['noncanonical',s=>{s.free='011';}],
 ['missing nonce',s=>{delete s.refund_nonce;}],['nonce overflow',s=>{s.refund_nonce=String(2n**64n);}],['unknown field',s=>{s.version=2;}],['unknown flight',s=>{s.in_flight='withdraw:1';}],['unknown order state',s=>{s.orders[0].state='complete';}],['duplicate order',s=>{s.orders.push(s.orders[0]);}],['missing order fields',s=>{delete s.orders[0].recipient;}]
])test(`authoritative status rejects ${name} and drops all amounts`,async t=>{
 const f=await fixture(t);change(f.state);const r=await f.reader()(f.input);assert.equal(r.state,'unavailable');assert.equal(r.reason,'BINDING_MISMATCH');assert.equal(r.amounts,null);assert.equal(r.observation,null);assert.equal(f.calls.length,4);
});
for(const [name,select,change] of [
 ['wrong chain',q=>q.method==='status',r=>{r.chain_id='mainnet';}],['syncing',q=>q.method==='status',r=>{r.sync_info.syncing=true;}],
 ['bad hash',q=>q.method==='block',r=>{r.header.hash='bad';}],['bad height',q=>q.method==='block',r=>{r.header.height=0;}],['future',q=>q.method==='block',r=>{r.header.timestamp_nanosec=String(BigInt(time+1)*1000000n);}],['u64 timestamp overflow',q=>q.method==='block',r=>{r.header.timestamp_nanosec=String(2n**64n);}],
 ['wrong account code',q=>q.params.request_type==='view_account',r=>{r.code_hash=blockHash;}],['cross-block account',q=>q.params.request_type==='view_account',r=>{r.block_hash=baseEncode(new Uint8Array(32).fill(8));}],['cross-height status',q=>q.params.method_name==='get_status',r=>{r.block_height++;}],['malformed ABI UTF8',q=>q.params.method_name==='get_status',r=>{r.result=[255];}],['malformed ABI JSON',q=>q.params.method_name==='get_status',r=>{r.result=[123];}]
])test(`RPC evidence rejects ${name} without retry`,async t=>{
 let exercised=false;const f=await fixture(t,{mutate:(r,q)=>{if(select(q)){exercised=true;change(r);}return r;}});const r=await f.reader()(f.input);assert.equal(exercised,true);assert.equal(r.state,'unavailable');assert.equal(r.amounts,null);assert.equal(r.observation,null);assert.ok(f.calls.length<=4);
});
for(const mode of ['owner','job','missing manifest','extra input'])test(`request ${mode} rejects before RPC and never discloses foreign metadata`,async t=>{
 const f=await fixture(t), input={...f.input};if(mode==='owner')input.ownerId='foreign.testnet';if(mode==='job')input.jobId='unknown';if(mode==='missing manifest')delete input.manifest;if(mode==='extra input')input.networkId='testnet';
 await assert.rejects(f.reader()(input));assert.equal(f.calls.length,0);
});
for(const mode of ['manifest','second quote','second order','membership','source refs'])test(`persisted ${mode} mismatch rejects before RPC`,async t=>{
 const f=await fixture(t);
 if(mode==='manifest')f.input.manifest={...f.manifest,manifestId:'foreign'};
 else await f.repository.runTransaction(async tx=>{
   if(mode==='membership'){const key=Buffer.from(JSON.stringify(['haldir-local-v1','testnet',f.manifest.binding.mandateId])).toString('base64url');const m=await tx.get('mandates',key);tx.set('mandates',key,{...m,ownerId:'foreign.testnet'});}
   else if(mode==='source refs'){const j=await tx.get('jobs',f.input.jobId);j.sourceRefs.reverse();tx.set('jobs',j.jobId,j);}
   else {const collection=mode==='second quote'?'quotes':'orders',key=f.admitted.sourceRefs[1].quoteId,row=await tx.get(collection,key);row.quote.content='Changed';tx.set(collection,key,row);}
 });
 const r=await f.reader()(f.input);assert.equal(r.reason,'BINDING_MISMATCH');assert.equal(r.amounts,null);assert.equal(f.calls.length,0);
});
for(const [name,corrupt] of [
 ['HTTP error',()=>new Response('{}',{status:503})],['redirect status',()=>Response.redirect('https://foreign.invalid')],['redirected response',()=>{const r=Response.json({});Object.defineProperty(r,'redirected',{value:true});return r;}],['oversize body',()=>new Response(' '.repeat(262145))],['invalid UTF8',()=>new Response(new Uint8Array([255]))],['bad JSON',()=>new Response('{')],['wrong version',(p)=>Response.json({...p,jsonrpc:'1.0'})],['wrong id',p=>Response.json({...p,id:'wrong'})],['ambiguous response',p=>Response.json({...p,error:{}})]
])test(`closed HTTP transport rejects ${name} without fallback`,async t=>{
 const f=await fixture(t);let attempts=0;const transport=async(u,i)=>{attempts++;const r=await f.transport(u,i);return corrupt(await r.json());};const r=await f.reader({transport})(f.input);assert.equal(r.reason,'RPC_UNAVAILABLE');assert.equal(r.amounts,null);assert.equal(attempts,1);
});
test('one total deadline aborts held transport, blocks later RPC and cannot freshen evidence',async t=>{
 const f=await fixture(t);let calls=0,signal;const r=await f.reader({timeoutMs:10,transport:async(_,i)=>{calls++;signal=i.signal;return new Promise(()=>{});}})(f.input);assert.equal(r.reason,'RPC_UNAVAILABLE');assert.equal(signal.aborted,true);assert.equal(calls,1);
});
test('bounded body cancellation and same-turn caller abort leave no subsequent work',async t=>{
 const f=await fixture(t);let cancelled=false;const r=await f.reader({timeoutMs:10,transport:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))})(f.input);assert.equal(r.reason,'RPC_UNAVAILABLE');assert.equal(cancelled,true);
 const caller=new AbortController();const pending=f.reader()({...f.input,signal:caller.signal});caller.abort();await assert.rejects(pending);assert.equal(f.calls.length,0);
});
for(const rpcUrl of ['http://closed-economics.invalid','https://mainnet.invalid','https://closed-economics.invalid/path','https://closed-economics.invalid?x=1','https://u:p@closed-economics.invalid'])test(`constructor denies untrusted URL ${rpcUrl}`,async t=>{const f=await fixture(t);assert.throws(()=>f.reader({rpcUrl,allowedRpcUrls:[rpcUrl]}));assert.equal(f.calls.length,0);});
for(const [name,change] of [
 ['text error',()=>({message:'account does not exist'})],['wrong wrapper',e=>({...e,name:'INTERNAL_ERROR'})],['wrong cause',e=>({...e,cause:{...e.cause,name:'UNKNOWN_BLOCK'}})],['wrong child',e=>{e.cause.info.requested_account_id='foreign.testnet';return e;}],['legacy account_id only',e=>{e.cause.info.account_id=e.cause.info.requested_account_id;delete e.cause.info.requested_account_id;return e;}],['wrong block',e=>{e.cause.info.block_hash=baseEncode(new Uint8Array(32).fill(8));return e;}],['wrong height',e=>{e.cause.info.block_height++;return e;}],['string height',e=>{e.cause.info.block_height='456';return e;}]
])test(`child absence rejects ${name} as RPC_UNAVAILABLE`,async t=>{
 const f=await fixture(t);let attempted=0;const transport=async(u,i)=>{const q=JSON.parse(i.body);if(q.params.request_type!=='view_account')return f.transport(u,i);attempted++;const error=change({name:'HANDLER_ERROR',cause:{name:'UNKNOWN_ACCOUNT',info:{requested_account_id:f.manifest.binding.mandateId,block_hash:blockHash,block_height:456}}});return Response.json({jsonrpc:'2.0',id:q.id,error});};
 const r=await f.reader({transport})(f.input);assert.equal(attempted,1);assert.equal(r.reason,'RPC_UNAVAILABLE');assert.equal(r.amounts,null);assert.equal(r.observation,null);
});
test('observation uses a read-only transaction, no RPC inside callback, no journals or job writes',async t=>{
 const f=await fixture(t);let inTransaction=false,writes=0;
 const repository={runTransaction:callback=>f.repository.runTransaction(async tx=>{inTransaction=true;try{return await callback({get:tx.get,create(){writes++;assert.fail('observation write');},set(){writes++;assert.fail('observation write');}});}finally{inTransaction=false;}})};
 const r=await f.reader({repository,transport:async(u,i)=>{assert.equal(inTransaction,false);return f.transport(u,i);}})(f.input);assert.equal(r.state,'known');assert.equal(writes,0);
 assert.equal(await f.repository.runTransaction(tx=>tx.get('nativeOperations',f.admitted.quoteId)),null);assert.deepEqual(await f.orders.getJob({ownerId:f.input.ownerId,jobId:f.input.jobId}),f.admitted);
});
test('schema-valid refund flight and previous failed orders are observation states, not admission blockers',async t=>{
 const f=await fixture(t);f.state.in_flight='refund:2';f.state.refund_nonce='2';f.state.stopped=true;f.state.orders[1].state='failed';const r=await f.reader()(f.input);assert.equal(r.state,'known');assert.equal(r.amounts.refundedAtomic,'2');assert.equal(r.amounts.availableAtomic,'11');
});
test('transport failure is not absence and neither retries nor calls global fetch',async t=>{
 const f=await fixture(t);let calls=0;const r=await f.reader({transport:async()=>{calls++;throw new TypeError('account does not exist');}})(f.input);assert.equal(r.reason,'RPC_UNAVAILABLE');assert.equal(calls,1);
});


