import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { createOwnerServer } from './server.mjs';
import { KeyPair,KeyPairSigner,actions,encodeSignedDelegate } from 'near-api-js';
const key=KeyPair.fromRandom('ed25519');
const owner={account_id:'owner.testnet',public_key:key.getPublicKey().toString()};
function generated(){return {type:'agent_create',status:'PENDING_SIGNATURE',correlation_id:'intent_fixture',expires_at:'2030-01-01T00:00:00Z',signer:{type:'near',...owner},intent:{standard:'nep366',payload:{receiverId:'fixture.testnet',actions:[{type:'FunctionCall',params:{methodName:'fixture',args:{safe:true},gas:'10000000000000',deposit:'0'}}]}},preview:{policy:{frozen:true}}};}
async function serve(t,options={}){
 const saved=[];const server=createOwnerServer({generated:generated(),expectedOwner:owner,now:()=>0,saveSignature:async v=>saved.push(v),...options});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 return {url:`http://127.0.0.1:${server.address().port}`,saved};
}
test('bootstrap returns only unsigned intent, pinned owner and local session token',async t=>{
 const {url}=await serve(t);const response=await fetch(url+'/api/intent');
 assert.equal(response.status,200);const b=await response.json();
 assert.deepEqual(b.generated,generated());assert.deepEqual(b.expectedOwner,owner);
 assert.match(b.csrfToken,/^[a-f0-9]{64}$/);assert.equal(b.canSign,true);
 assert.equal(response.headers.get('cache-control'),'no-store');
});
async function sign(g=generated(),pair=key){
 const p=g.intent.payload;
 const result=await new KeyPairSigner(pair).signDelegateAction({senderId:owner.account_id,receiverId:p.receiverId,publicKey:pair.getPublicKey(),nonce:1n,maxBlockHeight:100n,actions:p.actions.map(({params:a})=>actions.functionCall(a.methodName,Buffer.from(JSON.stringify(a.args)),BigInt(a.gas),BigInt(a.deposit)))});
 return {...g.intent,signed_delegate:Buffer.from(encodeSignedDelegate(result.signedDelegate)).toString('base64')};
}
async function post(url,token,signed,extra={}){
 return fetch(url+'/api/signature',{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-CSRF-Token':token,...extra},body:JSON.stringify({signed_data:signed})});
}
test('valid matching signature is saved locally exactly once',async t=>{
 const {url,saved}=await serve(t);const b=await (await fetch(url+'/api/intent')).json();const signed=await sign();
 const response=await post(url,b.csrfToken,signed);assert.equal(response.status,201);
 assert.equal(saved.length,1);assert.deepEqual(saved[0].signed_data,signed);
 assert.equal((await post(url,b.csrfToken,signed)).status,409);assert.equal(saved.length,1);
});
test('cross-origin reads and forged host are rejected',async t=>{
 const {url}=await serve(t);
 assert.equal((await fetch(url+'/api/intent',{headers:{Origin:'https://attacker.invalid'}})).status,403);
 const code=await new Promise((resolve,reject)=>{const req=get(url+'/api/intent',{headers:{Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
 assert.equal(code,403);
});
test('expired intent and missing CSRF never save',async t=>{
 const {url,saved}=await serve(t,{now:()=>Date.parse('2031-01-01')});const b=await (await fetch(url+'/api/intent')).json();
 assert.equal(b.canSign,false);
 assert.equal((await post(url,b.csrfToken,await sign())).status,409);assert.equal(saved.length,0);
 const other=await serve(t);assert.equal((await post(other.url,'wrong',await sign())).status,403);assert.equal(other.saved.length,0);
});
test('wrong signer, substituted payload and extra Borsh bytes never save',async t=>{
 const {url,saved}=await serve(t);const b=await (await fetch(url+'/api/intent')).json();
 const valid=await sign();
 const altered=generated();altered.intent.payload.actions[0].params.deposit='1';
 for(const signed of [await sign(generated(),KeyPair.fromRandom('ed25519')),await sign(altered),{...valid,signed_delegate:Buffer.concat([Buffer.from(valid.signed_delegate,'base64'),Buffer.from([1])]).toString('base64')}]){
  assert.equal((await post(url,b.csrfToken,signed)).status,400);assert.equal(saved.length,0);
 }
});
test('no generation or submission endpoint exists',async t=>{
 const {url}=await serve(t);
 for(const path of ['/api/generate','/api/submit','/../../package.json']) assert.equal((await fetch(url+path,{method:'POST',headers:{Origin:url}})).status,404);
});
test('static assets are explicit and missing bundle is unavailable',async t=>{
 const {url}=await serve(t,{html:'<!doctype html><title>Fixture</title>',bundle:'// fixture'});
 assert.match(await (await fetch(url+'/')).text(),/Fixture/);
 assert.equal((await fetch(url+'/client.js')).status,200);
 assert.equal((await fetch(url+'/.env')).status,404);
});
