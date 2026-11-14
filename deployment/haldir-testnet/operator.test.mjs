import test from 'node:test';
import assert from 'node:assert/strict';
import { executeStep, authorize } from './operator.mjs';
import { manifestHash } from './manifest.mjs';
import { ReadOnlyProvider } from './readonly.mjs';
test('operator denies public writes without independent exact manifest approval before signer I/O', async () => {
  let reads=0;
  await assert.rejects(executeStep({ manifest:{}, step:'factory_create', signer:{getPublicKey(){reads++;}}, approval:null }),/APPROVAL_REQUIRED/);
  assert.equal(reads,0);
});
test('independent approval binds hash, cap, explicit steps and expiry', () => {
  const m={spec:{max_total_outlay:'1'}}, now=Date.now();
  const a={public_writes:true,manifest_sha256:manifestHash(m),max_total_outlay:'1',allowed_steps:['factory_create'],expires_at:new Date(now+1000).toISOString()};
  assert.doesNotThrow(()=>authorize(m,a,'factory_create',now));
  for(const delta of [{manifest_sha256:'0'.repeat(64)},{max_total_outlay:'2'},{allowed_steps:[]},{allowed_steps:['owner_create']},{expires_at:new Date(now-1).toISOString()},{expires_at:new Date(now+9*3600000).toISOString()},{extra:true}])
    assert.throws(()=>authorize(m,{...a,...delta},'factory_create',now),/APPROVAL_MISMATCH/);
});
test('read-only provider denies broadcast and unapproved endpoints without network',async()=>{
  const p=new ReadOnlyProvider();
  await assert.rejects(p.sendJsonRpc('send_tx',{}),/READ_ONLY_RPC/);
  for(const url of ['https://rpc.mainnet.near.org','http://rpc.testnet.near.org','https://rpc.testnet.near.org.evil','http://127.0.0.1:1234']) assert.throws(()=>new ReadOnlyProvider(url));
});
