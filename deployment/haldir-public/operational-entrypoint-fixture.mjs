// TEST ONLY. Closed synthetic RPC/SDK evidence, never chain/provider proof.
// This file is deliberately outside the production runtime allowlist.
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export async function installClosedFixture(f) {
  const c = { classification:'SYNTHETIC_NOT_CHAIN_OR_PROVIDER_PROOF', pid:process.pid, ppid:process.ppid,
    argv:[...process.argv], node:process.versions.node, forbidden:0, negativeControl:0,
    opens:0, readiness:0, constructors:0, closes:0, drainedBeforeClose:false,
    seeds:[], writes:[], hooks:[], listens:[], rpc:[], inference:[], verification:0, drains:0, resolutions:0, signs:0, sends:0 };
  const deny = () => { c.forbidden++; throw Error('OPERATIONAL_EXTERNAL_DENIED'); };
  // Install before any application/SDK import, with no native external fallback.
  for (const [o,k] of [[globalThis,'fetch'],[net.Socket.prototype,'connect'],[tls,'connect'],
    [http,'request'],[http,'get'],[https,'request'],[https,'get'],[http2,'connect']]) o[k]=deny;
  const listen=net.Server.prototype.listen, servers=[];
  net.Server.prototype.listen=function(port,host,...rest){
    assert.equal(port,f.port);assert.equal(host,'0.0.0.0');assert.equal(c.readiness,c.opens);
    c.listens.push({port,host});servers.push(this);return listen.call(this,port,host,...rest);
  };
  const createServer=http.createServer;
  http.createServer=function(...args){assert.ok(c.readiness>0,'server construction must follow readiness');c.serverCreations=(c.serverCreations??0)+1;return createServer.apply(this,args);};
  syncBuiltinESMExports();
  try { await fetch('https://forbidden.invalid/negative-control'); } catch { c.negativeControl++; }
  assert.equal(c.forbidden,1);assert.equal(c.negativeControl,1);
  const root=pathToFileURL(f.root+'/'), at=p=>new URL(p,root).href;
  const { KeyPair, KeyPairSigner, SignedTransaction, baseEncode }=await import('near-api-js');
  const {openLocalRepository}=await import(at('src/server/orders.mjs'));
  const {syntheticPayment}=await import(at('src/vendor/fixture.mjs'));
  const {PINS}=await import(at('deployment/haldir-testnet/manifest.mjs'));
  const {createNearAiTransport}=await import(at('deployment/haldir-public/near-ai-transport.mjs'));
  const {verifiedCompletion}=await import(at('deployment/haldir-public/near-ai-worker.mjs'));
  const {NEAR_AI_ENDPOINT}=await import(at('deployment/haldir-public/near-ai-policy.mjs'));
  const digest=s=>baseEncode(createHash('sha256').update(s).digest()), enc=v=>Buffer.from(JSON.stringify(v)).toString('base64');
  const agent=KeyPair.fromRandom('ed25519');
  const factory='factory.testnet', ownerId='alice.testnet', label='operational';
  const mandateId='j'+createHash('sha256').update(`${ownerId}:${label}`).digest('hex').slice(0,32)+'.'+factory;
  const checkpoint=f.replay?JSON.parse(await readFile(f.checkpoint,'utf8')):null;
  const approved=checkpoint?.approved??{
    manifestId:'operational-approval',ownerId,
    approved:{schemaVersion:'haldir.approved.two-source.v1',job:{networkId:'testnet',mandateId,
      purpose:'Compare the fictional Northwind supplier records and certification gap',output:'Evidence-linked supplier brief',
      budgetAtomic:'30',vendorIds:['records.testnet','research.testnet'],expiresAt:new Date(Date.now()+86400000).toISOString().replace(/\.\d{3}Z$/,'Z')},
      sources:['company-records','background-research'].map((sourceId,i)=>({sourceId,quote:{networkId:'testnet',mandateId,
        vendorId:['records.testnet','research.testnet'][i],amountAtomic:['8','9'][i],orderId:`operational-${i}`,
        content:`Northwind fictional sample: ${sourceId}`}}))},
    binding:{networkId:'testnet',ownerId,signerId:'agent.testnet',mandateId,publicKey:agent.getPublicKey().toString(),
      maxAllowanceAtomic:'1000000000000000000000000',codeHash:baseEncode(Buffer.from(PINS.mandate,'hex'))},
    creation:{factory,job_label:label,operating_float:'2000000000000000000000000',create_gas:'300000000000000',factoryCodeHash:baseEncode(Buffer.from(PINS.factory,'hex'))},
    rpcUrl:'https://rpc.testnet.near.org',allowedRpcUrls:['https://rpc.testnet.near.org']};
  const j=approved.approved.job,b=approved.binding;
  const state=checkpoint?.state??{owner:ownerId,agent:b.signerId,allowlist:j.vendorIds,cap:j.budgetAtomic,
    deadline_ns:String(BigInt(Date.parse(j.expiresAt))*1000000n),spent:'0',refunded:'0',reserved:'0',free:'30',
    stopped:false,expired:false,in_flight:null,refund_nonce:'0',orders:[]};
  let deployed=checkpoint?.deployed??false, repository;
  const txs=new Map(),receipts=new Map(),block=digest('operational-final-block');
  const code={};
  for(const [name,path] of [['mandate','target/mandate-wasm/u01_mandate_proof.wasm'],['factory','target/mandate-factory-wasm/u01_mandate_factory.wasm']]){
    code[name]=await readFile(new URL(path,root));assert.equal(createHash('sha256').update(code[name]).digest('hex'),PINS[name],'SETUP_BLOCKED: pinned WASM unavailable');
  }
  const common=()=>({block_hash:block,block_height:123});
  const blockTimestamp=checkpoint?.blockTimestamp??String(BigInt(Date.now()-10)*1000000n);
  const head=()=>({header:{hash:block,height:123,timestamp_nanosec:blockTimestamp}});
  const rich='20000000000000000000000000';
  const entry=()=>deployed?{job:mandateId,owner:ownerId,amount:String(BigInt(j.budgetAtomic)+BigInt(approved.creation.operating_float)),state:'ready'}:null;
  const u32=n=>{const v=Buffer.alloc(4);v.writeUInt32LE(n);return v;};
  const str=s=>Buffer.concat([u32(Buffer.byteLength(s)),Buffer.from(s)]);
  const borsh=()=>{if(!deployed)return Buffer.concat([u32(0),u32(4)]);const amount=Buffer.alloc(16),n=BigInt(entry().amount);amount.writeBigUInt64LE(n&((1n<<64n)-1n));amount.writeBigUInt64LE(n>>64n,8);return Buffer.concat([u32(1),str(mandateId),str(ownerId),amount,str('ready'),u32(4)]);};
  globalThis.fetch=async(url,init)=>{
    if(String(url)!==approved.rpcUrl||init.method!=='POST'||init.redirect!=='error'||!(init.signal instanceof AbortSignal))return deny();
    init.signal.throwIfAborted();const r=JSON.parse(init.body),p=r.params;c.rpc.push({method:r.method,params:p});let result;
    if(r.method==='status')result={chain_id:'testnet',sync_info:{syncing:false}};
    else if(r.method==='block'){assert.ok(p.finality==='final'||p.block_id===block);result=head();}
    else if(r.method==='gas_price')result={gas_price:'100000000'};
    else if(r.method==='EXPERIMENTAL_protocol_config')result={chain_id:'testnet',protocol_version:88,runtime_config:{storage_amount_per_byte:'10000000000000000000',min_gas_purchase_price:'100000000',account_creation_charge:'1',transaction_costs:{storage_usage_config:{num_bytes_account:100,num_extra_bytes_record:40}}}};
    else if(r.method==='query'){
      assert.ok([ownerId,b.signerId,mandateId,factory,...j.vendorIds].includes(p.account_id),'unexpected RPC account');
      if(p.block_id!==undefined)assert.equal(p.block_id,block);
      if(p.request_type==='view_access_key'){assert.equal(p.account_id,ownerId);assert.equal(p.public_key,f.ownerKey);result={...common(),nonce:1,permission:'FullAccess'};}
      else if(p.request_type==='view_access_key_list')result={...common(),keys:p.account_id===b.signerId?[{public_key:b.publicKey,access_key:{nonce:c.sends+1,permission:{FunctionCall:{receiver_id:mandateId,method_names:['pay'],allowance:b.maxAllowanceAtomic}}}}]:[]};
      else if(p.request_type==='view_account'){
        if(p.account_id===mandateId&&!deployed)return Response.json({jsonrpc:'2.0',id:r.id,error:{name:'HANDLER_ERROR',cause:{name:'UNKNOWN_ACCOUNT',info:{requested_account_id:mandateId,...common()}}}});
        result={...common(),amount:rich,locked:'0',storage_usage:1024,code_hash:p.account_id===mandateId?b.codeHash:p.account_id===factory?approved.creation.factoryCodeHash:'11111111111111111111111111111111'};
      }else if(p.request_type==='view_code'){
        assert.ok(p.account_id===mandateId||p.account_id===factory);const name=p.account_id===factory?'factory':'mandate';
        result={...common(),hash:baseEncode(Buffer.from(PINS[name],'hex')),code_base64:code[name].toString('base64')};
      }else if(p.request_type==='view_state'){assert.equal(p.account_id,factory);assert.equal(p.prefix_base64,'U1RBVEU=');result={...common(),values:[{key:'U1RBVEU=',value:borsh().toString('base64')}],proof:[]};}
      else if(p.request_type==='call_function'){
        assert.ok(['get_status','get_entry','job_id'].includes(p.method_name));
        const output=p.method_name==='get_status'?state:p.method_name==='get_entry'?entry():mandateId;
        result={...common(),result:[...Buffer.from(JSON.stringify(output))],logs:[]};
      }else return deny();
    }else if(r.method==='send_tx'){
      assert.equal(deployed,true);assert.equal(state.stopped,false);
      const signed=SignedTransaction.decode(Buffer.from(p.signed_tx_base64,'base64')),t=signed.transaction;
      assert.equal(t.signerId,b.signerId);assert.equal(t.receiverId,mandateId);assert.equal(t.actions.length,1);
      const call=t.actions[0].functionCall,args=JSON.parse(Buffer.from(call.args).toString());assert.equal(call.methodName,'pay');
      const q=approved.approved.sources.find(s=>s.quote.orderId===args.order_id)?.quote;assert.ok(q);assert.equal(args.recipient,q.vendorId);assert.equal(args.amount,q.amountAtomic);
      assert.equal(state.orders.some(o=>o.order_id===q.orderId),false);
      const txHash=baseEncode(createHash('sha256').update(t.encode()).digest());
      assert.ok(agent.getPublicKey().verify(Buffer.from(createHash('sha256').update(t.encode()).digest()),Uint8Array.from(signed.signature.ed25519Signature.data)));
      c.sends++;const e=syntheticPayment(q,1+(c.sends-1)*30).evidence;e.finalTransaction.transaction.hash=txHash;e.finalTransaction.transaction_outcome.id=txHash;
      e.finalTransaction.transaction.public_key=b.publicKey;
      for(const row of e.receipts)row.receipt.Action.signer_public_key=b.publicKey;
      txs.set(txHash,e.finalTransaction);for(const row of e.receipts)receipts.set(row.receipt_id,row);
      state.spent=String(BigInt(state.spent)+BigInt(q.amountAtomic));state.free=String(BigInt(state.free)-BigInt(q.amountAtomic));
      state.orders.push({order_id:q.orderId,recipient:q.vendorId,amount:q.amountAtomic,state:'paid'});result=e.finalTransaction;
    }else if(r.method==='EXPERIMENTAL_tx_status'){assert.equal(p.wait_until,'FINAL');result=txs.get(p.tx_hash);assert.ok(result,'unknown synthetic transaction');}
    else if(r.method==='EXPERIMENTAL_receipt'){result=receipts.get(p.receipt_id);assert.ok(result,'unknown synthetic receipt');}
    else return deny();
    return Response.json({jsonrpc:'2.0',id:r.id,result});
  };
  const rpcTransport=globalThis.fetch;
  globalThis.fetch=async(...args)=>{try{return await rpcTransport(...args);}catch(e){(c.rpcErrors??=[]).push({message:e.message,stack:e.stack});throw e;}};
  const sign=KeyPairSigner.prototype.signTransaction;
  KeyPairSigner.prototype.signTransaction=function(...args){c.signs++;return sign.apply(this,args);};
  const localQualification={signingBindings:[{ownerId,approvalId:'operational-approval',manifestId:approved.manifestId,publicKey:b.publicKey,keyVersion:'synthetic-ephemeral-operational-v1'}],
    resolveKeyMaterial:async({keyVersion,signal})=>{assert.equal(keyVersion,'synthetic-ephemeral-operational-v1');signal.throwIfAborted();c.resolutions++;return agent.toString();},
    model:{apiKey:'SYNTHETIC_CLOSED_OPERATIONAL_AI_KEY',authorizationExpiresAt:new Date(Date.now()+86400000).toISOString().replace(/\.\d{3}Z$/,'Z'),
      transportFactory:({apiKey,signal})=>{const wire=createNearAiTransport({apiKey,signal,run:async input=>({ok:true,...await verifiedCompletion(input,async options=>{
        assert.equal(options.e2ee,true);return{sdkVersion:'0.3.0',getSdkError:()=>null,pause:async()=>assert.fail('unexpected SDK retry'),client:{
          fetch:async(url,init)=>{assert.equal(url,NEAR_AI_ENDPOINT);assert.equal(init.credentials,'omit');const body=JSON.parse(init.body),r=JSON.parse(body.messages[1].content);c.inference.push(r);
            const output=r.phase==='plan'?{tool:'requestquotes',arguments:{quoteIds:r.approvedSources.map(s=>s.quoteId)}}:
              {findings:r.evidence.map(a=>({artifactId:a.artifactId,excerpt:a.content.split('\n').slice(1).join('\n')})),interpretations:[{kind:'COMPARE_SOURCE_CONSISTENCY',findingIndexes:[0,1]}]};
            return Response.json({id:`synthetic-operational-${c.inference.length}`,model:body.model,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}});},
          verifyResponse:async id=>{c.verification++;return{id,signatureKind:'provider_tee'};},clearResponseCache(){},
        }};
      })})});return{...wire,async drain(){await wire.drain();c.drains++;}};}}};
  const openRepository=async input=>{
    assert.deepEqual(input,{projectId:'loadout-haldir-demo',databaseId:'haldir',namespace:'haldirPreviewTestnetV1',timeoutMs:5000});c.opens++;
    const local=openLocalRepository({filename:f.sqlite,localTestOnly:true});
    repository={runTransaction:fn=>local.runTransaction(tx=>fn({get:(...a)=>tx.get(...a),create:(collection,key,value)=>{c.writes.push({kind:'create',collection,key,jobId:value.jobId});return tx.create(collection,key,value);},set:(collection,key,value)=>{c.writes.push({kind:'set',collection,key,jobId:value.jobId});return tx.set(collection,key,value);}})),
      verifyReadiness:async()=>{await local.runTransaction(tx=>tx.get('walletChallenges','operational-readiness'));c.readiness++;},
      close:async()=>{assert.ok(servers.every(s=>!s.listening),'server drains before repository close');assert.equal(c.drains,c.inference.length);c.drainedBeforeClose=true;c.closes++;local.close();}};
    if(!f.replay){await local.runTransaction(tx=>{c.seeds.push('publicApprovals');tx.create('publicApprovals',JSON.stringify(['haldir-public-approval-v1',ownerId,'operational-approval']),{schemaVersion:'haldir.public.approval.v1',ownerId,approvalId:'operational-approval',manifest:approved});});}
    return repository;
  };
  const composition=at('deployment/haldir-public/trusted-composition.mjs'),main=at('deployment/haldir-public/main.mjs'),firestore=at('deployment/haldir-preview/firestore-repository.mjs');
  globalThis.__operationalFixture={c,localQualification,openRepository};
  if(f.mode==='auto'||f.replay)registerHooks({resolve(specifier,context,next){
    const found=next(specifier,context);
    if(found.url===firestore||found.url===composition){assert.equal(context.parentURL,main,'only the exact main import may be substituted');c.hooks.push({target:found.url,parent:context.parentURL});}
    return found;
  },load(url,context,next){
    if(url===firestore){return{format:'module',shortCircuit:true,source:'export const openFirestoreRepository=globalThis.__operationalFixture.openRepository;'};}
    if(url===composition){return{format:'module',shortCircuit:true,source:`import * as real from ${JSON.stringify(composition+'?operational-actual=1')}; export const validateLocalQualification=real.validateLocalQualification; export function createTrustedComposition({repository}){const f=globalThis.__operationalFixture;f.c.constructors++;return real.createTrustedComposition({repository${f.replay?'':',localQualification:f.localQualification'}});}`};}
    return next(url,context);
  }});
  process.on('message',async m=>{try{
    if(m.kind==='recover-cache'){
      const real=await import(composition+'?operational-actual=1');
      const reopened=openLocalRepository({filename:f.sqlite,localTestOnly:true});c.recoveryRepositoryOpens=(c.recoveryRepositoryOpens??0)+1;
      const port=real.createTrustedComposition({repository:reopened,localQualification}).model;
      assert.equal(port.contractVersion,'haldir.model.runner-recovery.v1');
      const before={inference:c.inference.length,verification:c.verification,resolutions:c.resolutions,signs:c.signs,sends:c.sends,writes:c.writes.length};
      const results=[];try{for(const input of c.inference)results.push(await port.recover(structuredClone(input)));}finally{reopened.close();c.recoveryRepositoryCloses=(c.recoveryRepositoryCloses??0)+1;}
      assert.deepEqual({inference:c.inference.length,verification:c.verification,resolutions:c.resolutions,signs:c.signs,sends:c.sends,writes:c.writes.length},before);
      process.send({id:m.id,contractVersion:port.contractVersion,results,before});
    }else if(m.kind==='snapshot'){
      const rows={};for(const collection of ['jobs','mandates','quotes','orders','nativeOperations','claims','deliveries','modelReservations','modelGrants','modelReleaseSpend','ownerOperations']){
        const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(f.sqlite,{readOnly:true});rows[collection]=db.prepare('SELECT key,value FROM records WHERE collection=? ORDER BY key').all(collection).map(r=>({key:r.key,value:JSON.parse(r.value)}));db.close();
      }process.send({id:m.id,rows,c,state,approved});
    }else if(m.kind==='owner-evidence'){
      const request=m.request,action=m.action,txHash=digest('operational-owner-'+action),rootId=digest(action+'-root'),effect=digest(action+'-effect'),callback=digest(action+'-callback'),dataId=digest(action+'-data');
      assert.equal(request.signerId,ownerId);assert.equal(request.methodName,action==='create'?'create_job':action);
      const call={FunctionCall:{method_name:request.methodName,args:enc(request.args),gas:request.gas,deposit:request.deposit}};
      const row=(id,executor,children,status)=>({id,block_hash:block,outcome:{executor_id:executor,receipt_ids:children,status}});
      const record=(id,predecessor_id,receiver_id,actions,input_data_ids=[],output_data_receivers=[])=>({receipt_id:id,predecessor_id,receiver_id,receipt:{Action:{signer_id:ownerId,signer_public_key:f.ownerKey,actions,input_data_ids,output_data_receivers}}});
      const success={SuccessValue:enc(true)},empty={SuccessValue:''};
      const tx={final_execution_status:'FINAL',status:action==='stop'?empty:success,transaction:{hash:txHash,signer_id:ownerId,public_key:f.ownerKey,receiver_id:request.receiverId,actions:[call]},transaction_outcome:row(txHash,ownerId,[rootId],{SuccessReceiptId:rootId}),receipts_outcome:[]};
      const rs=[record(rootId,ownerId,request.receiverId,[call])];
      if(action==='stop'){assert.equal(deployed,true);state.stopped=true;tx.receipts_outcome=[row(rootId,mandateId,[],empty)];}
      else{
        const create=action==='create';if(create)assert.equal(deployed,false);else assert.equal(state.stopped,true);
        const receiver=create?mandateId:ownerId,origin=create?factory:mandateId,cbReceiver=origin;
        const actions=create?['CreateAccount',{Transfer:{deposit:approved.creation.operating_float}},{DeployContract:{code:Buffer.from(PINS.mandate,'hex').toString('base64')}},{FunctionCall:{method_name:'new_from_factory',args:enc({owner:ownerId,agent:b.signerId,allowlist:j.vendorIds,cap:j.budgetAtomic,deadline_ns:state.deadline_ns}),gas:'100000000000000',deposit:j.budgetAtomic}}]:[{Transfer:{deposit:state.free}}];
        tx.receipts_outcome=[row(rootId,request.receiverId,[effect,callback],{SuccessReceiptId:callback}),row(effect,receiver,[],empty),row(callback,cbReceiver,[],success)];
        rs.push(record(effect,origin,receiver,actions,[],[{receiver_id:cbReceiver,data_id:dataId}]),record(callback,origin,cbReceiver,[{FunctionCall:{method_name:create?'on_create':'on_refund',args:enc(create?{job:mandateId}:{nonce:'1'}),gas:'20000000000000',deposit:'0'}}],[dataId]));
        if(create)deployed=true;else{state.refunded=state.free;state.free='0';state.refund_nonce='1';}
      }
      txs.set(txHash,tx);for(const r of rs)receipts.set(r.receipt_id,r);process.send({id:m.id,transactionHash:txHash,receiptId:action==='stop'?rootId:effect});
    }else throw Error('UNKNOWN_FIXTURE_COMMAND');
  }catch(e){process.send({id:m.id,error:e.stack});}});
  process.on('exit',()=>{process.stderr.write('OPERATIONAL_RECEIPT '+JSON.stringify(c)+'\n');});
  process.on('SIGTERM',()=>{writeFileSync(f.checkpoint,JSON.stringify({approved,state,deployed,blockTimestamp}));});
  // Checkpoint is nonsecret synthetic chain state only, not application records.
  await writeFile(f.checkpoint,JSON.stringify({approved,state,deployed,blockTimestamp}));
  if(f.mode==='exported'&&!f.replay){
    const {startPublicRuntime}=await import(main);assert.equal(typeof startPublicRuntime,'function','SETUP_BLOCKED: startPublicRuntime absent');
    c.constructors++;
    const runtime=await startPublicRuntime({openRepository,localQualification});
    process.once('SIGTERM',()=>{runtime.close().then(()=>process.exit(0),e=>{console.error(e);process.exit(1);});});
    console.log('OPERATIONAL_EXPORTED_LISTENING');
  }
}
