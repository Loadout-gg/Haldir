import { readFile, writeFile } from 'node:fs/promises';
import { createOwnerServer } from './server.mjs';
import assert from 'node:assert/strict';

const root = new URL('../../', import.meta.url);
const generated = JSON.parse(await readFile(new URL('.hermes/proposals/owner-intent-generated.json',root),'utf8'));
const approved = JSON.parse(await readFile(new URL('.hermes/proposals/owner-qualification.json',root),'utf8'));
assert.deepEqual(generated.preview.policy,approved.policy);
assert.deepEqual(generated.signer,approved.owner);
assert.equal(generated.intent.standard,'nep366');
const server=createOwnerServer({
  generated, expectedOwner:{account_id:approved.owner.account_id,public_key:approved.owner.public_key},
  html:await readFile(new URL('index.html',import.meta.url),'utf8'),
  bundle:await readFile(new URL('target/owner-ui/client.js',root),'utf8'),
  saveSignature:async body=>writeFile(new URL('.hermes/proposals/owner-signature.json',root),JSON.stringify(body),{flag:'wx',mode:0o600}),
});
// The entrypoint never reads an API key and has no outbound request path.
server.listen(4173,'127.0.0.1',()=>console.log('U01 local owner review: http://127.0.0.1:4173 (no submission endpoint)'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
