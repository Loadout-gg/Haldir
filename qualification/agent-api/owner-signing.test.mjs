import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { KeyPair, KeyPairSigner, actions, encodeDelegateAction, encodeSignedDelegate } from 'near-api-js';

// Characterize the installed SDK, not an owner adapter or the hosted API.
// Keys exist only in memory; no account, RPC, credential store or submit call.
function fixture() {
  const pair = KeyPair.fromRandom('ed25519');
  const publicKey = pair.getPublicKey();
  const verifier = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey.data)]),
    format: 'der', type: 'spki',
  });
  return { signer: new KeyPairSigner(pair), publicKey, verifier };
}
const payload = {
  receiverId: 'fixture-contract.testnet',
  actions: [{ type: 'FunctionCall', params: {
    methodName: 'fixture_policy', args: { note: 'synthetic only', revision: '7' },
    gas: '30000000000000', deposit: '0',
  } }],
};
function delegate(publicKey) {
  return {
    senderId: 'fixture-owner.testnet', receiverId: payload.receiverId, publicKey,
    nonce: 9007199254740993n, maxBlockHeight: 123456789n,
    actions: payload.actions.map(({ params }) => actions.functionCall(
      params.methodName, Buffer.from(JSON.stringify(params.args)), BigInt(params.gas), BigInt(params.deposit),
    )),
  };
}
function sha(bytes) { return createHash('sha256').update(bytes).digest(); }
function borshString(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}
function messageDigest(message) {
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(2147484061);
  return sha(Buffer.concat([
    prefix, borshString(message.message), Buffer.from(message.nonce),
    borshString(message.recipient), Buffer.from([0]), // No callback URL.
  ]));
}

test('NEP-366 signs unchanged actions and exact bigint nonce without network', async () => {
  const { signer, publicKey, verifier } = fixture();
  const before = structuredClone(payload);
  const action = delegate(publicKey);
  const { delegateHash, signedDelegate } = await signer.signDelegateAction(action);
  assert.deepEqual(payload, before);
  assert.deepEqual(signedDelegate.delegateAction, action);
  assert.equal(signedDelegate.delegateAction.nonce, 9007199254740993n);
  assert.deepEqual(Buffer.from(delegateHash), sha(encodeDelegateAction(action)));
  assert.equal(verify(null, delegateHash, verifier, signedDelegate.signature.data), true);
  const wire = Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64');
  assert.deepEqual(Buffer.from(wire, 'base64'), Buffer.from(encodeSignedDelegate(signedDelegate)));
});

test('NEP-366 signature does not authorize changed receiver or nonce', async () => {
  const { signer, publicKey, verifier } = fixture();
  const action = delegate(publicKey);
  const { signedDelegate } = await signer.signDelegateAction(action);
  for (const changed of [
    { ...action, receiverId: 'another-fixture.testnet' },
    { ...action, nonce: action.nonce + 1n },
  ]) assert.equal(verify(null, sha(encodeDelegateAction(changed)), verifier, signedDelegate.signature.data), false);
});

test('NEP-366 rejects a different public key before signing', async () => {
  const { signer } = fixture();
  const other = fixture();
  await assert.rejects(signer.signDelegateAction(delegate(other.publicKey)), /public key.*match/i);
});

test('NEP-413 verifies using an independent message serialization', async () => {
  const { signer, verifier } = fixture();
  const message = { message: 'Synthetic consent only', recipient: 'fixture.invalid', nonce: new Uint8Array(32).fill(17) };
  const before = structuredClone(message);
  const result = await signer.signNep413Message('fixture-owner.testnet', message);
  assert.deepEqual(message, before);
  assert.equal(verify(null, messageDigest(message), verifier, result.signature), true);
  assert.equal(result.accountId, 'fixture-owner.testnet');
});

test('NEP-413 binds message, recipient and nonce', async () => {
  const { signer, verifier } = fixture();
  const message = { message: 'Synthetic consent only', recipient: 'fixture.invalid', nonce: new Uint8Array(32).fill(17) };
  const result = await signer.signNep413Message('fixture-owner.testnet', message);
  for (const changed of [
    { ...message, message: 'Changed consent' },
    { ...message, recipient: 'different.invalid' },
    { ...message, nonce: new Uint8Array(32).fill(18) },
  ]) assert.equal(verify(null, messageDigest(changed), verifier, result.signature), false);
});

test('NEP-413 rejects a nonce with the wrong byte length', async () => {
  const { signer } = fixture();
  await assert.rejects(signer.signNep413Message('fixture-owner.testnet', {
    message: 'Synthetic', recipient: 'fixture.invalid', nonce: new Uint8Array(31),
  }), /32 bytes/);
});
