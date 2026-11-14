import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertGrantBinding } from './grant-binding.mjs';
import { prepareNep413 } from './nep413-adapter.mjs';

// Synthetic fixtures, independently assembled from observed field NAMES only.
// No live generated response, grant token, wallet, secret or API transport.
const now = Date.parse('2030-01-01T00:00:00Z');
const publicKey = `ed25519:${'1'.repeat(32)}`; // Synthetic 32 zero-byte public key, no secret.
// Explicit LOCAL qualification policy, not provider defaults or replay protection.
const qualificationPolicy = { maxClockSkewMs: 2000, maxAgeMs: 60000, maxSigningWindowMs: 300000 };
function fixture() {
  const approvedRequest = {
    type: 'grant_issue', agent_id: 'a'.repeat(64), label: 'Offline client',
    credential: 'b'.repeat(64), expires_at: '2030-01-02T00:00:00.000Z',
  };
  const approvedOwner = { type: 'near', account_id: 'synthetic.near', public_key: publicKey };
  const trustedContext = {
    network: 'mainnet', recipient: 'synthetic.invalid',
    envelope: {
      tenant_id: 'synthetic-tenant', wallet_id: 'synthetic-wallet',
    },
  };
  // Do NOT construct the approved pins from this untrusted generated message.
  const message = {
    domain: 'near-intents-agent-api.agent-grant.v6',
    owner: { type: 'near', account_id: 'synthetic.near', public_key: publicKey },
    tenant_id: 'synthetic-tenant', agent_id: 'a'.repeat(64), wallet_id: 'synthetic-wallet',
    label: 'Offline client', credential: 'b'.repeat(64), network: 'mainnet',
    issued_at_ms: now - 1000, expires_at_ms: Date.parse('2030-01-02T00:00:00.000Z'),
    owner_epoch: 1, nonce: 'synthetic-nonce-0001', recipient: 'synthetic.invalid',
  };
  const generated = {
    correlation_id: `intent_${'A'.repeat(43)}`, type: 'grant_issue', agent_id: 'a'.repeat(64),
    status: 'PENDING_SIGNATURE', expires_at: '2030-01-01T00:04:00.000Z',
    signer: { type: 'near', account_id: 'synthetic.near', public_key: publicKey },
    intent: { standard: 'nep413', payload: {
      message: JSON.stringify(message, null, 2) + '\n',
      recipient: 'synthetic.invalid', nonce: Buffer.alloc(32, 17).toString('base64'),
    } }, preview: { summary: 'Synthetic only; not an authorization source' },
  };
  return { generated, approvedRequest, approvedOwner, trustedContext };
}
function bind(f, options = {}) {
  return assertGrantBinding(f.generated, f.approvedRequest, f.approvedOwner, f.trustedContext, {
    clock: () => now, qualificationPolicy, ...options,
  });
}
function editMessage(f, edit) {
  const message = JSON.parse(f.generated.intent.payload.message);
  edit(message);
  f.generated.intent.payload.message = JSON.stringify(message);
}

test('issuance binds independently approved pins without changing signed bytes or any input', () => {
  const f = fixture();
  const before = structuredClone(f);
  assert.equal(bind(f), true);
  assert.deepEqual(f, before);
  assert.notEqual(f.approvedRequest.expires_at, f.generated.expires_at, 'grant lifetime is NOT signing-intent lifetime');
});

for (const [name, inject] of [
  ['different duplicate domain', raw => raw.replace('{', '{"domain":"attacker",')],
  ['identical duplicate domain', raw => raw.replace('{', '{"domain":"near-intents-agent-api.agent-grant.v6",')],
  ['escaped duplicate agent', raw => raw.replace('{', '{"\\u0061gent_id":"' + 'c'.repeat(64) + '",')],
  ['nested duplicate owner account', raw => raw.replace('"owner": {', '"owner": {"account_id":"other.near",')],
  ['escaped nested duplicate key', raw => raw.replace('"owner": {', '"owner": {"public_\\u006bey":"bad",')],
  ['rounded fractional expiry', raw => raw.replace(/("expires_at_ms": \d+)/, '$1.0001')],
  ['rounded fractional epoch', raw => raw.replace('"owner_epoch": 1', '"owner_epoch": 1.0000000000000001')],
  ['exponent numeric spelling', raw => raw.replace('"owner_epoch": 1', '"owner_epoch": 1e0')],
  ['negative zero numeric spelling', raw => raw.replace('"owner_epoch": 1', '"owner_epoch": -0')],
]) test(`refuses ambiguous JSON: ${name}`, () => {
  const f = fixture();
  f.generated.intent.payload.message = inject(f.generated.intent.payload.message);
  // The attack remains syntactically valid and JSON.parse hides the ambiguity.
  assert.doesNotThrow(() => JSON.parse(f.generated.intent.payload.message));
  assert.throws(() => bind(f), /Grant binding rejected:/);
});

test('JSON strings with escaped quotes, braces, commas and key-looking substrings remain opaque', () => {
  const f = fixture();
  f.approvedRequest.label = 'Quoted "client", {"agent_id":"not a key"}';
  editMessage(f, m => { m.label = 'Quoted "client", {"agent_id":"not a key"}'; });
  const before = f.generated.intent.payload.message;
  assert.equal(bind(f), true);
  assert.equal(f.generated.intent.payload.message, before);
});

function revocationFixture() {
  const f = fixture();
  f.approvedRequest = { type: 'grant_revoke', agent_id: 'a'.repeat(64), grant_id: 'c'.repeat(64) };
  // Known decoder fragment ONLY. Deliberately no invented server metadata or
  // message expiry: a complete server revoke schema is not available here.
  f.generated.type = 'grant_revoke';
  f.generated.intent.payload.message = JSON.stringify({
    domain: 'near-intents-agent-api.owner-admin.v2', action: 'revoke_grant',
    target_id: 'c'.repeat(64),
  }, null, 2) + '\n';
  return f;
}

test('revocation is UNSUPPORTED_REVOCATION_FORMAT, not a qualified server schema', () => {
  const f = revocationFixture(); const before = structuredClone(f);
  // This incomplete synthetic fragment is NOT evidence of server metadata or
  // expiry semantics. Known domain/action/target need a real schema fixture.
  assert.throws(() => bind(f), /UNSUPPORTED_REVOCATION_FORMAT/);
  assert.deepEqual(f, before);
});

test('anchors never allow a trailing newline in an approved identifier, owner, label or response correlation', () => {
  const attacks = [
    () => { const f = fixture(); f.approvedRequest.agent_id += '\n'; f.generated.agent_id += '\n'; editMessage(f, m => { m.agent_id += '\n'; }); return f; },
    () => { const f = fixture(); f.approvedRequest.credential += '\n'; editMessage(f, m => { m.credential += '\n'; }); return f; },
    () => { const f = fixture(); f.approvedRequest.label += '\n'; editMessage(f, m => { m.label += '\n'; }); return f; },
    () => { const f = fixture(); f.approvedOwner.account_id += '\n'; f.generated.signer.account_id += '\n'; editMessage(f, m => { m.owner.account_id += '\n'; }); return f; },
    () => { const f = fixture(); f.generated.correlation_id += '\n'; return f; },
  ];
  for (const attack of attacks) assert.throws(() => bind(attack()), /Grant binding rejected:/);
});

const issueChanges = [
  ['unknown domain', m => { m.domain = 'near-intents-agent-api.agent-grant.v7'; }],
  ['wrong domain', m => { m.domain = 'near-intents-agent-api.owner-admin.v2'; }],
  ['extra action', m => { m.action = 'revoke_grant'; }],
  ['changed agent', m => { m.agent_id = 'c'.repeat(64); }],
  ['uppercase agent', m => { m.agent_id = 'A'.repeat(64); }],
  ['changed label', m => { m.label = 'Other client'; }],
  ['changed commitment', m => { m.credential = 'c'.repeat(64); }],
  ['uppercase commitment', m => { m.credential = 'B'.repeat(64); }],
  ['changed expiry', m => { m.expires_at_ms++; }],
  ['signing expiry used as grant expiry', m => { m.expires_at_ms = now + 240000; }],
  ['string expiry', m => { m.expires_at_ms = String(m.expires_at_ms); }],
  ['fractional expiry', m => { m.expires_at_ms += 0.5; }],
  ['unsafe expiry', m => { m.expires_at_ms = 9007199254740992; }],
  ['wrong owner account', m => { m.owner.account_id = 'other.near'; }],
  ['wrong owner key', m => { m.owner.public_key = `ed25519:${'2'.repeat(44)}`; }],
  ['nonNEAR owner', m => { m.owner.type = 'evm'; }],
  ['owner extras', m => { m.owner.address = 'other'; }],
  ['testnet', m => { m.network = 'testnet'; }],
  ['missing network', m => { delete m.network; }],
  ['changed tenant', m => { m.tenant_id = 'other-tenant'; }],
  ['changed wallet', m => { m.wallet_id = 'other-wallet'; }],
  ['string owner epoch', m => { m.owner_epoch = '1'; }],
  ['changed recipient', m => { m.recipient = 'other.invalid'; }],
  ['extra policy', m => { m.policy = { actions: ['withdraw'] }; }],
  ['extra permissions', m => { m.permissions = ['all']; }],
  ['extra grant target', m => { m.target_id = 'd'.repeat(64); }],
  ['unverified metadata', m => { m.server_note = 'looks harmless'; }],
];
for (const [name, edit] of issueChanges) test(`issuance refuses ${name}`, () => {
  const f = fixture(); editMessage(f, edit);
  assert.throws(() => bind(f), /Grant binding rejected:/);
});
for (const key of Object.keys(JSON.parse(fixture().generated.intent.payload.message))) {
  test(`issuance refuses missing message field ${key}`, () => {
    const f = fixture(); editMessage(f, m => { delete m[key]; });
    assert.throws(() => bind(f), /Grant binding rejected:/);
  });
}
for (const [name, edit] of [
  ['wrong outer agent', f => { f.generated.agent_id = 'c'.repeat(64); }],
  ['wrong outer type', f => { f.generated.type = 'grant_revoke'; }],
  ['wrong outer signer', f => { f.generated.signer.account_id = 'other.near'; }],
  ['wrong signer key', f => { f.generated.signer.public_key = `ed25519:${'2'.repeat(44)}`; }],
  ['wrong standard', f => { f.generated.intent.standard = 'nep366'; }],
  ['wrong payload recipient', f => { f.generated.intent.payload.recipient = 'other.invalid'; }],
  ['unknown payload field', f => { f.generated.intent.payload.callbackUrl = ''; }],
  ['invalid NEP413 nonce', f => { f.generated.intent.payload.nonce = Buffer.alloc(31).toString('base64'); }],
  ['noncanonical NEP413 nonce', f => { f.generated.intent.payload.nonce = Buffer.alloc(32).toString('base64').slice(0, -2) + 'B='; }],
  ['wrong pending state', f => { f.generated.status = 'APPLIED'; }],
  ['missing independent context', f => { f.trustedContext = undefined; }],
  ['missing independent request', f => { f.approvedRequest = undefined; }],
  ['missing independent owner', f => { f.approvedOwner = undefined; }],
  ['malformed approved agent', f => { f.approvedRequest.agent_id = 'a'.repeat(63); }],
  ['malformed approved credential', f => { f.approvedRequest.credential = 'B'.repeat(64); }],
  ['extra approved request field', f => { f.approvedRequest.policy = {}; }],
  ['unsupported approved action', f => { f.approvedRequest.type = 'policy_update'; }],
  ['nonstring approved expiry', f => { f.approvedRequest.expires_at = now + 86400000; }],
  ['invalid approved expiry date', f => { f.approvedRequest.expires_at = '2030-02-30T00:00:00Z'; }],
  ['nonUTC approved expiry', f => { f.approvedRequest.expires_at = '2030-01-02T00:00:00+00:00'; }],
  ['submillisecond approved expiry', f => { f.approvedRequest.expires_at = '2030-01-02T00:00:00.0001Z'; }],
  ['extra owner field', f => { f.approvedOwner.network = 'mainnet'; }],
  ['missing owner type', f => { delete f.approvedOwner.type; }],
  ['malformed owner key', f => { f.approvedOwner.public_key = 'ed25519:1'; }],
  ['invalid owner account', f => { f.approvedOwner.account_id = 'Bad.NEAR'; }],
  ['foreign trusted network', f => { f.trustedContext.network = 'testnet'; }],
  ['missing recipient pin', f => { delete f.trustedContext.recipient; }],
  ['missing response signing deadline', f => { delete f.generated.expires_at; }],
  ['missing metadata pin', f => { delete f.trustedContext.envelope.wallet_id; }],
  ['unverified metadata pin', f => { f.trustedContext.envelope.permissions = ['all']; }],
]) test(`issuance refuses ${name}`, () => {
  const f = fixture(); edit(f);
  assert.throws(() => bind(f), /Grant binding rejected:/);
});

for (const message of ['null', '[]', 'true', '42', '"opaque"', '{', '{}', '{"domain":null}', '{"domain":1}']) {
  test(`refuses unknown or malformed JSON ${message}`, () => {
    const f = fixture(); f.generated.intent.payload.message = message;
    assert.throws(() => bind(f), /Grant binding rejected:/);
  });
}

test('clock, response signing deadline and approved grant expiry fail closed', () => {
  const f = fixture();
  for (const time of [NaN, Infinity, '2030', now + 300000, now + 86400000]) {
    assert.throws(() => bind(f, { clock: () => time }), /Grant binding rejected:/);
  }
});

test('matching response and envelope substitutions cannot overwrite the independent owner, request or context', () => {
  for (const mutate of [
    f => { f.generated.agent_id = 'c'.repeat(64); editMessage(f, m => { m.agent_id = 'c'.repeat(64); }); },
    f => { f.generated.signer.account_id = 'other.near'; editMessage(f, m => { m.owner.account_id = 'other.near'; }); },
    f => { const otherKey = `ed25519:${'1'.repeat(31)}2`; f.generated.signer.public_key = otherKey; editMessage(f, m => { m.owner.public_key = otherKey; }); },
    f => { f.generated.intent.payload.recipient = 'other.invalid'; editMessage(f, m => { m.recipient = 'other.invalid'; }); },
    f => { editMessage(f, m => { m.label = 'Not approved'; }); },
    f => { editMessage(f, m => { m.credential = 'c'.repeat(64); }); },
    f => { editMessage(f, m => { m.expires_at_ms++; }); },
    f => { editMessage(f, m => { m.network = 'testnet'; }); },
    f => { editMessage(f, m => { m.tenant_id = 'other-tenant'; }); },
    f => { editMessage(f, m => { m.wallet_id = 'other-wallet'; }); },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => bind(f), /Grant binding rejected:/);
  }
});

test('issuance: every known message field rejects null, boolean, array and object substitutions', () => {
  const keys = Object.keys(JSON.parse(fixture().generated.intent.payload.message));
  for (const field of keys) for (const value of [null, true, [], {}]) {
    const f = fixture(); editMessage(f, m => { m[field] = value; });
    assert.throws(() => bind(f), /Grant binding rejected:/, `${field}: ${JSON.stringify(value)}`);
  }
});
test('issuance: independent context pins are validated even when the message agrees', () => {
  for (const [field, value] of [['tenant_id', ''], ['wallet_id', ''], ['owner_epoch', -1]]) {
    const f = fixture(); f.trustedContext.envelope[field] = value;
    editMessage(f, m => { m[field] = value; });
    assert.throws(() => bind(f), /Grant binding rejected:/, field);
  }
});
test('issuance: helper composes with unchanged adapter while preserving the exact original NEP413 string', () => {
  const f = fixture(); const before = structuredClone(f);
  assert.equal(bind(f), true);
  const prepared = prepareNep413(f.generated, f.approvedOwner.public_key, { clock: () => now });
  assert.equal(prepared.request.input.messageParams.message, before.generated.intent.payload.message);
  assert.deepEqual(f, before);
  assert.throws(() => bind(f, { clock: () => now + 300000 }), /Grant binding rejected:/);
});

test('plain JSON data only: accessors, inherited fields, symbol fields and alternate prototypes are rejected', () => {
  const cases = [
    f => { f.approvedRequest = Object.assign(Object.create({ approval: true }), f.approvedRequest); },
    f => { f.approvedRequest[Symbol('hidden')] = 'anything'; },
    f => { Object.defineProperty(f.approvedRequest, 'label', { get() { assert.fail('accessor must not execute'); }, enumerable: true }); },
    f => { f.generated.signer = Object.create(f.generated.signer); },
    f => { Object.defineProperty(f.generated.intent.payload, 'message', { get() { assert.fail('accessor must not execute'); }, enumerable: true }); },
  ];
  for (const mutate of cases) {
    const f = fixture(); mutate(f);
    assert.throws(() => bind(f), /Grant binding rejected:/);
  }
});

test('valid escaped JSON member names are accepted without reserializing the signed text', () => {
  const f = fixture();
  f.generated.intent.payload.message = f.generated.intent.payload.message.replace('"agent_id"', '"\\u0061gent_id"');
  const before = f.generated.intent.payload.message;
  assert.equal(bind(f), true);
  assert.equal(f.generated.intent.payload.message, before);
});

test('oversized, deeply nested, trailing, prototype-shaped and invalid JSON stays fail closed', () => {
  for (const raw of [
    ' '.repeat(65537), '['.repeat(40) + '0' + ']'.repeat(40),
    fixture().generated.intent.payload.message + '{}',
    '{"__proto__":{"domain":"near-intents-agent-api.agent-grant.v6"}}',
    '{"x":1,"x":2}', '{"x":[{"a":1,"a":2}]}', '{"x":[1,true,null]}',
  ]) {
    const f = fixture(); f.generated.intent.payload.message = raw;
    assert.throws(() => bind(f), /Grant binding rejected:/);
  }
});

test('fresh unpredictable response nonce, time, deadline and noninitial epoch need no preknown pins', () => {
  const f = fixture();
  editMessage(f, m => {
    m.nonce = randomBytes(24).toString('hex');
    m.issued_at_ms = now - 500;
    m.owner_epoch = 37;
  });
  f.generated.expires_at = '2030-01-01T00:02:00.000Z';
  const before = structuredClone(f);
  assert.equal(assertGrantBinding(f.generated, f.approvedRequest, f.approvedOwner, f.trustedContext, {
    clock: () => now, qualificationPolicy,
  }), true);
  assert.deepEqual(f, before);
  const prepared = prepareNep413(f.generated, f.approvedOwner.public_key, { clock: () => now });
  assert.equal(prepared.request.input.messageParams.message, before.generated.intent.payload.message);
  assert.notEqual(f.approvedRequest.expires_at, f.generated.expires_at);
});

test('local freshness policy refuses stale or excessively future issued times', () => {
  for (const [issuedAt, reason] of [
    [now - qualificationPolicy.maxAgeMs - 1, /stale issued time/],
    [now + qualificationPolicy.maxClockSkewMs + 1, /future issued time/],
  ]) {
    const f = fixture(); editMessage(f, m => { m.issued_at_ms = issuedAt; });
    assert.throws(() => bind(f), reason);
  }
});

test('local signing window policy bounds the response deadline against issued time', () => {
  for (const [issuedAt, deadline] of [
    [now - 1000, '2030-01-01T00:05:00.000Z'],
    [now + 2000, '2030-01-01T00:00:01.000Z'],
    [now + 2000, '2030-01-01T00:00:02.000Z'],
  ]) {
    const f = fixture();
    editMessage(f, m => { m.issued_at_ms = issuedAt; });
    f.generated.expires_at = deadline;
    assert.throws(() => bind(f), /signing window/);
  }
});

test('response nonce must be nonempty canonical text, never trimmed or repaired', () => {
  for (const nonce of ['', 'short', ' '.repeat(20), ' synthetic-nonce-0001', 'synthetic-nonce-0001 ', 'synthetic-nonce-\n0001', 'x'.repeat(65)]) {
    const f = fixture(); editMessage(f, m => { m.nonce = nonce; });
    assert.throws(() => bind(f), /internal nonce/);
  }
});

test('caller must supply finite bounded local qualification policy, not inferred provider defaults', () => {
  for (const policy of [undefined, null, {},
    { ...qualificationPolicy, maxAgeMs: Infinity },
    { ...qualificationPolicy, maxAgeMs: 0 },
    { ...qualificationPolicy, maxAgeMs: -1 },
    { ...qualificationPolicy, maxClockSkewMs: NaN },
    { ...qualificationPolicy, maxClockSkewMs: -1 },
    { ...qualificationPolicy, maxSigningWindowMs: 0 },
    { ...qualificationPolicy, maxSigningWindowMs: '300000' },
    { ...qualificationPolicy, maxSigningWindowMs: 0.5 },
    { ...qualificationPolicy, maxAgeMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...qualificationPolicy, providerDefault: true },
  ]) assert.throws(() => bind(fixture(), { qualificationPolicy: policy }), /qualification policy/);
});

test('local policy accepts exact bounds and caller changes actually control admission', () => {
  for (const issuedAt of [now - qualificationPolicy.maxAgeMs, now, now + qualificationPolicy.maxClockSkewMs]) {
    const f = fixture(); editMessage(f, m => { m.issued_at_ms = issuedAt; });
    assert.equal(bind(f), true);
  }
  const f = fixture();
  assert.throws(() => bind(f, { qualificationPolicy: { ...qualificationPolicy, maxAgeMs: 999 } }), /stale issued time/);
  assert.throws(() => bind(f, { qualificationPolicy: { ...qualificationPolicy, maxSigningWindowMs: 240999 } }), /signing window/);
  assert.equal(bind(f, { qualificationPolicy: { ...qualificationPolicy, maxSigningWindowMs: 241000 } }), true);
  editMessage(f, m => { m.issued_at_ms = now + 1; });
  assert.throws(() => bind(f, { qualificationPolicy: { ...qualificationPolicy, maxClockSkewMs: 0 } }), /future issued time/);
  editMessage(f, m => { m.issued_at_ms = now; });
  assert.equal(bind(f, { qualificationPolicy: { ...qualificationPolicy, maxClockSkewMs: 0 } }), true);
});

test('epoch is structural without observation and compared exactly only when independently observed', () => {
  const f = fixture();
  for (const epoch of [0, 37, Number.MAX_SAFE_INTEGER]) {
    editMessage(f, m => { m.owner_epoch = epoch; });
    assert.equal(bind(f), true);
  }
  f.trustedContext.envelope.owner_epoch = 37; // Separate synthetic observation, not response-derived.
  editMessage(f, m => { m.owner_epoch = 37; });
  assert.equal(bind(f), true);
  editMessage(f, m => { m.owner_epoch = 38; });
  assert.throws(() => bind(f), /observed owner epoch mismatch/);
  f.trustedContext.envelope.owner_epoch = undefined;
  assert.throws(() => bind(f), /observed owner epoch/);
});

test('malformed epoch and issued time remain refused without independent metadata pins', () => {
  for (const field of ['owner_epoch', 'issued_at_ms']) {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', '', null]) {
      const f = fixture(); editMessage(f, m => { m[field] = value; });
      assert.throws(() => bind(f), /Grant binding rejected:/, `${field}: ${value}`);
    }
  }
});

test('outer deadline is validated as response metadata and is strictly unexpired', () => {
  for (const deadline of [
    '', null, now + 240000, '2030-01-01T00:00:00.000Z',
    '2029-12-31T23:59:59.999Z', '2030-02-30T00:00:00Z',
    '2030-01-01T00:04:00+00:00', '2030-01-01T00:04:00.0001Z',
  ]) {
    const f = fixture(); f.generated.expires_at = deadline;
    assert.throws(() => bind(f), /intent expiry|expired intent/);
  }
  const f = fixture();
  assert.throws(() => bind(f, { clock: () => Date.parse('2030-01-01T00:04:00.000Z') }), /expired intent/);
});

test('grant expiry remains independently approved even if a response offers a different signing window', () => {
  const f = fixture();
  f.generated.expires_at = '2030-01-01T00:02:00.000Z';
  assert.equal(bind(f), true);
  editMessage(f, m => { m.expires_at_ms = Date.parse(f.generated.expires_at); });
  assert.throws(() => bind(f), /message expiry mismatch/);
  const expired = fixture();
  expired.approvedRequest.expires_at = '2030-01-01T00:00:00.000Z';
  editMessage(expired, m => { m.expires_at_ms = now; });
  assert.throws(() => bind(expired), /expired grant/);
});

test('a valid preview cannot rescue an opaque or tampered message', () => {
  const f = fixture(); f.generated.preview = { ...f.approvedRequest, owner: f.approvedOwner, network: 'mainnet' };
  f.generated.intent.payload.message = '{"synthetic":"not a grant authorization"}';
  assert.throws(() => bind(f), /Grant binding rejected:/);
});
