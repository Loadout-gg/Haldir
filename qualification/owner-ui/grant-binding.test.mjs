import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { prepareNep413 } from '../agent-api/nep413-adapter.mjs';
import { createController } from './client.mjs';
import { createOwnerServer } from './server.mjs';

// Incumbent fail-closed characterization, NOT an implemented grant journey or
// RED/GREEN claim. This is deliberately NOT an official generated grant message.
// Its opaque text illustrates the missing semantic binding described in
// GRANT-BINDING-GAP.md. Keys exist only in memory; no token, wallet or API call.
const now = Date.parse('2030-01-01T00:00:00Z');
function fixture(type) {
  const pair = KeyPair.fromRandom('ed25519');
  const expectedOwner = { account_id: 'synthetic.near', public_key: pair.getPublicKey().toString() };
  const expectedRequest = type === 'grant_issue'
    ? { type, agent_id: 'a'.repeat(64), label: 'Offline synthetic only', credential: 'b'.repeat(64), expires_at: '2030-01-02T00:00:00Z' }
    : { type, agent_id: 'a'.repeat(64), grant_id: 'c'.repeat(64) };
  return { pair, boot: {
    expectedOwner, expectedRequest, csrfToken: 'synthetic-csrf-only', canSign: true,
    generated: {
      correlation_id: `intent_${'A'.repeat(43)}`, type, agent_id: expectedRequest.agent_id,
      status: 'PENDING_SIGNATURE', expires_at: '2030-01-01T00:01:00Z',
      signer: { type: 'near', ...expectedOwner },
      intent: { standard: 'nep413', payload: {
        message: '{"synthetic":"Opaque text does not bind any grant request fields"}',
        recipient: 'synthetic.invalid', nonce: Buffer.alloc(32, 17).toString('base64'),
      } },
      preview: { summary: 'Synthetic summary is not a structured grant authorization.' },
    },
  } };
}
function assertBlocked(boot) {
  let walletCalls = 0, saves = 0;
  assert.throws(() => createController(boot, {
    clock: () => now,
    wallet: async () => { walletCalls++; assert.fail('must not call a wallet'); },
    fetcher: async () => { saves++; assert.fail('must not save'); },
  }), /qualification.*invalid/i);
  assert.throws(() => createOwnerServer({
    generated: boot.generated, expectedOwner: boot.expectedOwner,
    expectedRequest: boot.expectedRequest, now: () => now,
    saveSignature: async () => { saves++; assert.fail('must not persist'); },
  }), /owner_intent_mismatch/);
  assert.equal(walletCalls, 0);
  assert.equal(saves, 0);
}
for (const type of ['grant_issue', 'grant_revoke']) {
  test(`${type}: cryptographically valid opaque message is insufficient; controller and server remain blocked`, async () => {
    const { pair, boot } = fixture(type);
    const adapter = prepareNep413(boot.generated, boot.expectedOwner.public_key, { clock: () => now });
    const output = await new KeyPairSigner(pair).signNep413Message(
      boot.expectedOwner.account_id, adapter.request.input.messageParams,
    );
    const signed = await adapter.signedData(output);
    assert.deepEqual(signed.payload, boot.generated.intent.payload);
    assert.equal(signed.public_key, boot.expectedOwner.public_key);
    assert.equal(Buffer.from(signed.signature, 'base64').length, 64);
    assertBlocked(boot);
  });
  test(`${type}: matching outer request fields, changed pins, expiry and unsupported standard cannot bypass blanket rejection`, () => {
    const { boot } = fixture(type);
    // No claim of semantic tamper/replay verification: rejection precedes
    // cryptography. A future implementation must add genuine lifecycle tests.
    for (const mutate of [
      () => {},
      b => { b.expectedRequest.agent_id = 'd'.repeat(64); },
      b => { b.generated.signer.account_id = 'other.near'; },
      b => { b.generated.expires_at = '2000-01-01T00:00:00Z'; },
      b => { b.generated.intent.standard = 'nep366'; },
      b => { b.generated.type = 'policy_update'; },
      b => { b.generated.preview.grant = structuredClone(b.expectedRequest); },
    ]) {
      const altered = structuredClone(boot);
      mutate(altered);
      assertBlocked(altered);
    }
  });
}
