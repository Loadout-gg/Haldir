import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
for (const wroteFirst of [false, true]) {
 test(`persistence exception (${wroteFirst ? 'wrote then threw' : 'before write'}) blocks bootstrap and all later saves`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'owner-save-latch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'synthetic-signature.json');
  let attempts = 0;
  const { url } = await serve(t, { saveSignature: async body => {
   attempts++;
   if (wroteFirst) await writeFile(file, JSON.stringify(body), { flag: 'wx', mode: 0o600 });
   throw new Error('synthetic persistence failure');
  } });
  const boot = await (await fetch(url + '/api/intent')).json();
  const signed = await sign();
  const response = await post(url, boot.csrfToken, signed);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'signature_storage_unavailable' });
  if (wroteFirst) assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).signed_data, signed);
  const after = await (await fetch(url + '/api/intent')).json();
  assert.equal(after.canSign, false, 'uncertain persistence must stay blocked after saving flag clears');
  assert.equal((await post(url, boot.csrfToken, signed)).status, 409);
  assert.equal(attempts, 1);
 });
}

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

// Exercise the actual auto-start entrypoint in a child. Every application file
// access is redirected to synthetic scratch fixtures; the private record is
// never read/stat-ed. The production 4173 listen is intercepted before binding.
const startupProbe = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { Server } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const [entry, fixtureDir, kind, signedJson, attempt = 'legacy'] = process.argv.slice(1);
process.env.U01_OWNER_ATTEMPT = attempt;
const root = new URL('../../', entry);
const proposalDir = new URL(attempt === 'legacy'
  ? '.hermes/proposals/'
  : '.hermes/proposals/attempts/owner-qualification-02/', root);
const paths = new Map([
  [fileURLToPath(new URL('owner-intent-generated.json', proposalDir)), 'generated.json'],
  [fileURLToPath(new URL('owner-qualification.json', proposalDir)), 'approved.json'],
  [fileURLToPath(new URL('index.html', entry)), 'index.html'],
  [fileURLToPath(new URL('target/owner-ui/client.js', root)), 'client.js'],
]);
const signaturePath = fileURLToPath(new URL('owner-signature.json', proposalDir));
const realRead = fs.readFile.bind(fs), realLstat = fs.lstat.bind(fs);
let signatureReads = 0, metadataChecks = 0, writes = 0, listening;
fs.readFile = async (path, ...args) => {
  const absolute = path instanceof URL ? fileURLToPath(path) : path;
  if (absolute === signaturePath) signatureReads++;
  assert.ok(paths.has(absolute), 'unexpected filesystem read');
  return realRead(join(fixtureDir, paths.get(absolute)), ...args);
};
fs.lstat = async path => {
  assert.equal(fileURLToPath(path), signaturePath);
  metadataChecks++;
  if (kind === 'metadata-error') throw Object.assign(new Error('synthetic denial'), { code: 'EACCES' });
  return realLstat(join(fixtureDir, 'signature.json'));
};
fs.writeFile = async () => { writes++; throw new Error('fixture forbids signature write'); };
syncBuiltinESMExports();
const originalListen = Server.prototype.listen;
Server.prototype.listen = function(port, host, callback) {
  assert.equal(port, 4173); assert.equal(host, '127.0.0.1');
  listening = this;
  return originalListen.call(this, 0, '127.0.0.1', callback);
};
console.log = () => {};
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  assert.ok(listening?.listening, 'no outbound startup fetch');
  assert.ok(String(args[0]).startsWith('http://127.0.0.1:' + listening.address().port + '/'), 'only owned ephemeral loopback is allowed');
  return realFetch(...args);
};
try {
  await import(entry);
  if (!listening.listening) await once(listening, 'listening');
  const url = 'http://127.0.0.1:' + listening.address().port;
  const boot = await (await fetch(url + '/api/intent')).json();
  let postStatus = null;
  if (kind !== 'absent') {
    postStatus = (await fetch(url + '/api/signature', { method: 'POST', headers: {
      Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrfToken,
    }, body: JSON.stringify({ signed_data: JSON.parse(signedJson) }) })).status;
  }
  process.stdout.write(JSON.stringify({ canSign: boot.canSign, postStatus, signatureReads, metadataChecks, writes }));
} finally {
  if (listening) await new Promise(resolve => { listening.close(resolve); listening.closeAllConnections(); });
}
`;
for (const attempt of ['legacy', 'owner-qualification-02']) {
for (const kind of ['valid', 'partial', 'malformed', 'empty', 'absent', 'metadata-error']) {
 test(`${attempt}: startup ${kind} synthetic signature fixture ${kind === 'absent' ? 'allows first signing' : 'blocks before signing without reading signature contents'}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'owner-startup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const g = generated(); g.expires_at = '2099-01-01T00:00:00Z';
  const signed = await sign(g);
  await writeFile(join(dir, 'generated.json'), JSON.stringify(g));
  await writeFile(join(dir, 'approved.json'), JSON.stringify({ owner: g.signer, policy: g.preview.policy }));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Synthetic</title>');
  await writeFile(join(dir, 'client.js'), '// synthetic');
  if (!['absent', 'metadata-error'].includes(kind)) await writeFile(join(dir, 'signature.json'),
   kind === 'valid' ? JSON.stringify({ signed_data: signed }) : kind === 'partial' ? '{"signed_data":' : kind === 'malformed' ? 'not-json' : '');
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
   '--input-type=module', '--eval', startupProbe, new URL('./run.mjs', import.meta.url).href, dir, kind, JSON.stringify(signed), attempt,
  ], { env: { TMPDIR: tmpdir() }, timeout: 5000 });
  assert.equal(stderr, '');
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.signatureReads, 0);
  assert.equal(receipt.canSign, kind === 'absent', 'existing or uncertain signature file must block initial bootstrap');
  assert.equal(receipt.metadataChecks, 1);
  assert.equal(receipt.writes, 0);
  assert.equal(receipt.postStatus, kind === 'absent' ? null : 409);
 });
}
}

test('private operator can reuse the existing pure signature verifier', async () => {
  const module = await import('./server.mjs');
  assert.equal(typeof module.validateSignature, 'function');
  assert.doesNotThrow(() => module.createOwnerServer({
    generated: generated(), expectedOwner: owner, saveSignature: async () => {},
  }));
});

test('exported verifier accepts the matching delegate and rejects a wrong signing key', async () => {
  const module = await import('./server.mjs');
  assert.equal(typeof module.validateSignature, 'function');
  const g = generated();
  const valid = await sign(g);
  const wrong = await sign(g, KeyPair.fromRandom('ed25519'));
  assert.doesNotThrow(() => module.validateSignature(valid, g, owner));
  assert.throws(() => module.validateSignature(wrong, g, owner));
});
