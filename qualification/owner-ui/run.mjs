import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createOwnerServer } from './server.mjs';
import assert from 'node:assert/strict';
import { ownerAttemptPaths } from './attempt-paths.mjs';

const root = new URL('../../', import.meta.url);
const paths = ownerAttemptPaths(root, process.env.U01_OWNER_ATTEMPT);
const generated = JSON.parse(await readFile(paths.generated, 'utf8'));
const approved = JSON.parse(await readFile(paths.approved, 'utf8'));
assert.deepEqual(generated.preview.policy,approved.policy);
assert.deepEqual(generated.signer,approved.owner);
assert.equal(generated.intent.standard,'nep366');
const signatureFile = paths.signature;
// Check existence only: even an empty/partial file or dangling symlink blocks.
// Metadata failures are uncertain, so only a definite ENOENT permits signing.
let initialSaveBlocked = true;
try { await lstat(signatureFile); }
catch (error) { if (error.code === 'ENOENT') initialSaveBlocked = false; }
const server=createOwnerServer({
  initialSaveBlocked,
  generated, expectedOwner:{account_id:approved.owner.account_id,public_key:approved.owner.public_key},
  html:await readFile(new URL('index.html',import.meta.url),'utf8'),
  bundle:await readFile(new URL('target/owner-ui/client.js',root),'utf8'),
  saveSignature:async body=>writeFile(signatureFile,JSON.stringify(body),{flag:'wx',mode:0o600}),
});
// The entrypoint never reads an API key and has no outbound request path.
server.listen(4173,'127.0.0.1',()=>console.log('U01 local owner review: http://127.0.0.1:4173 (no submission endpoint)'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
