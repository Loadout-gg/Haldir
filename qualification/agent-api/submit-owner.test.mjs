import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, KeyPairSigner, actions, encodeSignedDelegate } from 'near-api-js';
import { createAgentApi } from '@near-intents-agent-api/sdk';
import * as operator from './submit-owner.mjs';

const ORIGIN = 'https://api.demo.agentsonintents.com';
const DIR = new URL('../../.hermes/proposals/attempts/owner-qualification-02/', import.meta.url);
const LEGAL = new URL('../../.hermes/proposals/owner-signing-authorization.md', import.meta.url);
const file = name => new URL(name, DIR).href;
const sha = value => operator.sha256(value);
async function fixture() {
  const pair = KeyPair.fromRandom('ed25519');
  const expected = structuredClone(operator.EXPECTED_REQUEST);
  expected.owner = { type: 'near', account_id: 'synthetic-owner.near',
    public_key: pair.getPublicKey().toString() };
  const g = { correlation_id: 'intent_synthetic02', type: 'agent_create', agent_id: null,
    status: 'PENDING_SIGNATURE', expires_at: '2030-01-01T00:00:00Z',
    signer: expected.owner, preview: { policy: expected.policy },
    intent: { standard: 'nep366', payload: { receiverId: 'outlayer.near', actions: [
      { type: 'FunctionCall', params: { methodName: 'store_wallet_policy',
        args: { synthetic_only: true }, gas: '50000000000000', deposit: '12630000000000000000000' } },
      { type: 'FunctionCall', params: { methodName: 'freeze_wallet',
        args: { synthetic_only: true }, gas: '50000000000000', deposit: '0' } },
    ] } } };
  const signed = await new KeyPairSigner(pair).signDelegateAction({
    senderId: expected.owner.account_id, receiverId: g.intent.payload.receiverId,
    publicKey: pair.getPublicKey(), nonce: 1n, maxBlockHeight: 100n,
    actions: g.intent.payload.actions.map(({ params: p }) => actions.functionCall(
      p.methodName, Buffer.from(JSON.stringify(p.args)), BigInt(p.gas), BigInt(p.deposit))),
  });
  const records = { request: JSON.stringify(expected), generated: JSON.stringify(g),
    signature: JSON.stringify({ correlation_id: g.correlation_id, type: 'agent_create',
      signed_data: { ...g.intent,
        signed_delegate: Buffer.from(encodeSignedDelegate(signed.signedDelegate)).toString('base64') } }),
    legal: 'SYNTHETIC LEGAL RECORD: NOT REAL ACCEPTANCE' };
  const a = { schema: 'u01-owner-submit-approval-v1', origin: ORIGIN,
    attempt: 'owner-qualification-02', type: 'agent_create', correlation_id: g.correlation_id,
    request_sha256: sha(records.request), generated_sha256: sha(records.generated),
    signature_sha256: sha(records.signature), payload_sha256: sha(JSON.stringify(g.intent)),
    legal_record_sha256: sha(records.legal), owner: expected.owner, policy: expected.policy,
    owner_authorized_submit: true, legal_gate_cleared: true };
  records.approval = JSON.stringify(a);
  return { records, expected, g, a };
}
function harness(f, { responseStatus = 'PROCESSING', http = 202, fail = false } = {}) {
  const files = new Map([
    [file('owner-qualification.json'), f.records.request],
    [file('owner-intent-generated.json'), f.records.generated],
    [file('owner-signature.json'), f.records.signature],
    [file('owner-submit-approval.json'), f.records.approval], [LEGAL.href, f.records.legal],
  ]);
  const events = [], seen = [], reads = [];
  let keyReads = 0;
  const io = {
    now: () => Date.parse('2029-01-01T00:00:00Z'),
    exists: async url => { events.push('exists'); return files.has(url.href); },
    read: async url => { reads.push(url.href); assert.ok(files.has(url.href)); return files.get(url.href); },
    loadKey: async () => { keyReads++; return 'synthetic-partner-key'; },
    exclusive: async (url, text, options) => {
      assert.deepEqual(options, { flag: 'wx', mode: 0o600 });
      assert.ok([file('owner-submit-attempt.json'), file('owner-submit-outcome.json')].includes(url.href));
      if (files.has(url.href)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(url.href, text); events.push(url.href.endsWith('owner-submit-attempt.json') ? 'durable-journal' : 'outcome');
    },
    fetch: async (url, init) => {
      const u = new URL(url);
      assert.equal(u.origin, ORIGIN);
      assert.ok((init.method === 'POST' && u.pathname === '/v1/submit-intent' && !u.search) ||
        (init.method === 'GET' && u.pathname === '/v1/status' &&
          u.searchParams.get('correlation_id') === f.g.correlation_id &&
          u.searchParams.get('wait_ms') === '0' && [...u.searchParams.keys()].length === 2));
      if (init.method === 'POST') {
        assert.ok(files.has(file('owner-submit-attempt.json')), 'journal must precede transport');
        assert.ok(events.includes('durable-journal'));
        assert.equal(seen.length, 0, 'no submit retry');
      }
      events.push(init.method); seen.push({ url: u.href, init });
      if (fail) throw new Error('RAW_SECRET_SIGNATURE_TOKEN_API_ERROR');
      return Response.json({ correlation_id: f.g.correlation_id, type: 'agent_create',
        status: responseStatus, agent_id: 'a'.repeat(64),
        details: { agent_id: 'a'.repeat(64), reason: 'RAW_SECRET_SIGNATURE_TOKEN_API_ERROR' },
        arbitrary_secret: 'RAW_SECRET_SIGNATURE_TOKEN_API_ERROR' }, { status: http });
    },
  };
  return { io, files, events, seen, reads, keyReads: () => keyReads };
}

// B2-T1: pure binding. First use an importable scaffold, not an import failure.
test('binding: exact reviewed ephemeral signature passes existing crypto', async () => {
  const f = await fixture();
  assert.equal(typeof operator.bindRecords, 'function');
  const b = operator.bindRecords(f.records, { submit: true, expected: f.expected, now: () => 0 });
  assert.ok(b.request, 'binding must return the validated submit request');
  assert.equal(b.request.correlation_id, f.g.correlation_id);
  assert.deepEqual(Object.keys(b.request).sort(), ['correlation_id','signed_data','type']);
});
for (const field of ['owner_authorized_submit','legal_gate_cleared']) {
  for (const value of [false, null, 'true', undefined]) {
    test(`binding: ${field}=${String(value)} denies independently`, async () => {
      const f = await fixture(); f.a[field] = value; f.records.approval = JSON.stringify(f.a);
      assert.throws(() => operator.bindRecords(f.records, { submit: true, expected: f.expected, now: () => 0 }));
    });
  }
}
for (const field of ['request','generated','signature','legal']) {
  test(`binding: ${field} byte hash mismatch denies`, async () => {
    const f = await fixture(); f.records[field] += '\n';
    assert.throws(() => operator.bindRecords(f.records, { submit: true, expected: f.expected, now: () => 0 }));
  });
}
const mutations = {
  'request owner': f => { const r = JSON.parse(f.records.request); r.owner.account_id = 'wrong.near';
    f.records.request = JSON.stringify(r); f.a.request_sha256 = sha(f.records.request); },
  'request frozen policy': f => { const r = JSON.parse(f.records.request); r.policy.frozen = false;
    f.records.request = JSON.stringify(r); f.a.request_sha256 = sha(f.records.request); },
  'approval owner': f => { f.a.owner = { ...f.a.owner, account_id: 'wrong.near' }; },
  'approval policy': f => { f.a.policy = { ...f.a.policy, frozen: false }; },
  'approval correlation': f => { f.a.correlation_id = 'intent_wrong'; },
  'approval type': f => { f.a.type = 'grant_issue'; },
  'approval origin': f => { f.a.origin = 'https://attacker.invalid'; },
  'approval attempt': f => { f.a.attempt = 'owner-qualification-03'; },
  'unknown approval field': f => { f.a.allow_retry = true; },
  'payload hash': f => { f.a.payload_sha256 = '0'.repeat(64); },
  'saved signature correlation': f => { const s = JSON.parse(f.records.signature); s.correlation_id = 'intent_wrong';
    f.records.signature = JSON.stringify(s); f.a.signature_sha256 = sha(f.records.signature); },
  'saved signature type': f => { const s = JSON.parse(f.records.signature); s.type = 'grant_issue';
    f.records.signature = JSON.stringify(s); f.a.signature_sha256 = sha(f.records.signature); },
  'cryptographic signature tamper with rehashed file': f => {
    const s = JSON.parse(f.records.signature);
    const bytes = Buffer.from(s.signed_data.signed_delegate, 'base64'); bytes[bytes.length - 1] ^= 1;
    s.signed_data.signed_delegate = bytes.toString('base64');
    f.records.signature = JSON.stringify(s); f.a.signature_sha256 = sha(f.records.signature);
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`binding: ${name} denied even when related file hash is updated`, async () => {
    const f = await fixture(); mutate(f); f.records.approval = JSON.stringify(f.a);
    assert.throws(() => operator.bindRecords(f.records, { submit: true, expected: f.expected, now: () => 0 }));
  });
}
for (const change of [g => { g.type = 'grant_issue'; }, g => { g.signer.account_id = 'wrong.near'; },
  g => { g.preview.policy.frozen = false; }, g => { g.intent.payload.receiverId = 'wrong.near'; },
  g => { g.intent.payload.actions[0].params.deposit = '1'; }, g => { g.status = 'SUCCESS'; }]) {
  test(`binding: generated semantic mutation ${String(change)} denied after rehash`, async () => {
    const f = await fixture(); const g = JSON.parse(f.records.generated); change(g);
    f.records.generated = JSON.stringify(g); f.a.generated_sha256 = sha(f.records.generated);
    f.a.payload_sha256 = sha(JSON.stringify(g.intent)); f.records.approval = JSON.stringify(f.a);
    assert.throws(() => operator.bindRecords(f.records, { submit: true, expected: f.expected, now: () => 0 }));
  });
}
test('binding: expiry denies submit but does not block pinned read-only reconciliation', async () => {
  const f = await fixture();
  assert.throws(() => operator.bindRecords(f.records, { submit: true, expected: f.expected,
    now: () => Date.parse('2031-01-01') }));
  const r = { request: f.records.request, generated: f.records.generated, approval: f.records.approval };
  assert.equal(operator.bindRecords(r, { expected: f.expected }).g.correlation_id, f.g.correlation_id);
});

// B2-T2: real SDK submit + exclusive-before-write + replay refusal.
test('submit: one SDK POST, exact body/headers, durable private journal first, not completion', async () => {
  const f = await fixture(); const h = harness(f);
  const report = await operator.runOwner('submit', h.io, f.expected);
  assert.equal(report.state, 'STATUS_OBSERVED'); assert.equal(report.lifecycle_complete, false);
  assert.equal(report.observed_success, false); assert.equal(h.seen.length, 1);
  assert.deepEqual(h.events, ['exists','durable-journal','POST','outcome']);
  const { url, init } = h.seen[0]; assert.equal(url, ORIGIN + '/v1/submit-intent');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('x-api-key'), 'synthetic-partner-key');
  assert.equal(headers.get('x-grant-token'), null); assert.equal(headers.get('idempotency-key'), null);
  assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
  assert.deepEqual(JSON.parse(init.body), JSON.parse(f.records.signature));
  const journal = JSON.parse(h.files.get(file('owner-submit-attempt.json')));
  assert.equal(journal.approval_sha256, sha(f.records.approval));
  assert.equal(journal.signature_sha256, sha(f.records.signature));
  assert.ok(!JSON.stringify(report).includes('RAW_SECRET'));
  assert.ok(!JSON.stringify(journal).includes('signed_delegate'));
  assert.equal((await operator.runOwner('submit', h.io, f.expected)).state, 'REFUSED');
  assert.equal(h.seen.length, 1); assert.equal(h.keyReads(), 1);
});
for (const previous of ['', '{', 'not-json', '{"state":"UNCERTAIN"}', '{"state":"SUCCESS"}']) {
  test(`submit: any existing journal ${JSON.stringify(previous)} denies before key or transport`, async () => {
    const f = await fixture(); const h = harness(f); h.files.set(file('owner-submit-attempt.json'), previous);
    assert.equal((await operator.runOwner('submit', h.io, f.expected)).state, 'REFUSED');
    assert.equal(h.keyReads(), 0); assert.equal(h.seen.length, 0); assert.equal(h.reads.length, 0);
    assert.equal(h.files.get(file('owner-submit-attempt.json')), previous);
  });
}
test('submit: no owner authorization denies before key, journal and transport', async () => {
  const f = await fixture(); f.a.owner_authorized_submit = false; f.records.approval = JSON.stringify(f.a);
  const h = harness(f); const r = await operator.runOwner('submit', h.io, f.expected);
  assert.equal(r.state, 'REFUSED'); assert.equal(h.keyReads(), 0); assert.equal(h.seen.length, 0);
  assert.ok(!h.files.has(file('owner-submit-attempt.json')));
});
for (const kind of ['metadata','exclusive-race','partial-journal','expiry-during-journal']) {
  test(`submit: ${kind} refuses external write`, async () => {
    const f = await fixture(); const h = harness(f); const write = h.io.exclusive;
    if (kind === 'metadata') h.io.exists = async () => { throw new Error('EACCES'); };
    else h.io.exclusive = async (...args) => {
      if (kind === 'exclusive-race') throw new Error('EEXIST');
      if (kind === 'partial-journal') { h.files.set(args[0].href, '{'); throw new Error('EIO'); }
      await write(...args); h.io.now = () => Date.parse('2031-01-01');
    };
    assert.equal((await operator.runOwner('submit', h.io, f.expected)).state, 'REFUSED');
    assert.equal(h.seen.length, 0);
    if (['partial-journal','expiry-during-journal'].includes(kind)) {
      assert.ok(h.files.has(file('owner-submit-attempt.json')));
      assert.equal((await operator.runOwner('submit', h.io, f.expected)).state, 'REFUSED');
    }
  });
}
for (const options of [{ fail: true }, { http: 503 }, { responseStatus: 'UNRECOGNIZED' }]) {
  test(`submit: uncertain failure ${JSON.stringify(options)} persists redacted outcome, no retry`, async () => {
    const f = await fixture(); const h = harness(f, options);
    const r = await operator.runOwner('submit', h.io, f.expected);
    assert.equal(r.state, 'OUTCOME_UNCERTAIN'); assert.equal(h.seen.length, 1);
    assert.ok(!JSON.stringify(r).includes('RAW_SECRET'));
    assert.ok(!h.files.get(file('owner-submit-outcome.json')).includes('RAW_SECRET'));
    assert.equal((await operator.runOwner('submit', h.io, f.expected)).state, 'REFUSED');
    assert.equal(h.seen.length, 1);
  });
}
test('submit: outcome persistence failure preserves original bytes and never repeats submit', async () => {
  const f = await fixture(); const h = harness(f);
  h.files.set(file('owner-submit-outcome.json'), '{partial-original');
  assert.equal((await operator.runOwner('submit', h.io, f.expected)).state, 'OUTCOME_UNCERTAIN');
  assert.equal(h.files.get(file('owner-submit-outcome.json')), '{partial-original');
  assert.equal((await operator.runOwner('submit', h.io, f.expected)).state, 'REFUSED');
  assert.equal(h.seen.length, 1);
});

// B2-T3: bounded status-only reconciliation, including expired/uncertain attempts.
test('reconcile: one GET after expiry without signature/legal/consent; journals stay byte-identical', async () => {
  const f = await fixture(); f.a.owner_authorized_submit = false; f.a.legal_gate_cleared = false;
  f.records.approval = JSON.stringify(f.a); const h = harness(f, { responseStatus: 'SUCCESS', http: 200 });
  h.io.now = () => Date.parse('2031-01-01');
  h.files.delete(file('owner-signature.json')); h.files.delete(LEGAL.href);
  h.files.set(file('owner-submit-attempt.json'), '{partial');
  h.files.set(file('owner-submit-outcome.json'), 'uncertain-original');
  const before = [...h.files];
  const r = await operator.runOwner('reconcile', h.io, f.expected);
  assert.equal(r.status, 'SUCCESS'); assert.equal(r.observed_success, true);
  assert.equal(r.lifecycle_complete, false); assert.deepEqual([...h.files], before);
  assert.deepEqual(h.events, ['GET']); assert.equal(h.seen.length, 1);
  assert.equal(h.reads.length, 3); assert.ok(!JSON.stringify(r).includes('RAW_SECRET'));
});
for (const responseStatus of ['UNCERTAIN','NEEDS_REVIEW','FAILED','REFUNDED','PROCESSING']) {
  test(`reconcile: HTTP200 ${responseStatus} is not success`, async () => {
    const f = await fixture(); const h = harness(f, { responseStatus, http: 200 });
    const r = await operator.runOwner('reconcile', h.io, f.expected);
    assert.equal(r.status, responseStatus); assert.equal(r.observed_success, false);
    assert.equal(r.lifecycle_complete, false); assert.equal(h.seen.length, 1);
    assert.ok(!h.events.includes('outcome'));
  });
}
for (const mutation of [r => { r.correlation_id = 'intent_wrong'; }, r => { r.type = 'transfer'; },
  r => { r.status = 'INVENTED'; }, r => { r.agent_id = null; }]) {
  test(`status: reject mismatched/malformed successful response ${String(mutation)}`, async () => {
    const f = await fixture(); const r = { correlation_id: f.g.correlation_id,
      type: 'agent_create', status: 'SUCCESS', agent_id: 'a'.repeat(64), details: { agent_id: 'a'.repeat(64) } };
    mutation(r); assert.throws(() => operator.statusReport(r, f.g, 'status_read'));
  });
}
test('status: HTTP200 submit SUCCESS still requires distinct readback and lifecycle evidence', async () => {
  const f = await fixture(); const h = harness(f, { responseStatus: 'SUCCESS', http: 200 });
  const r = await operator.runOwner('submit', h.io, f.expected);
  assert.equal(r.status, 'SUCCESS'); assert.equal(r.observed_success, false);
  assert.equal(r.lifecycle_complete, false);
});
test('SDK characterization: unkeyed submit transport failure makes exactly one call', async () => {
  let calls = 0;
  const api = createAgentApi({ apiKey: 'synthetic-partner-key', baseUrl: ORIGIN,
    fetch: async (url, init) => { calls++; assert.equal(String(url), ORIGIN + '/v1/submit-intent');
      assert.equal(init.method, 'POST'); throw new Error('synthetic transport failure'); } });
  await assert.rejects(api.submitIntent({ type: 'agent_create', correlation_id: 'intent_synthetic02',
    signed_data: { standard: 'nep366', payload: {}, signed_delegate: 'synthetic-not-valid' } }));
  assert.equal(calls, 1);
});

// B2-T4: CLI contract without constructing production IO or executing an app.
test('CLI: exact arity and invalid modes refuse before all IO; no raw error output', async () => {
  const deny = new Proxy({}, { get() { throw new Error('RAW_SECRET_SIGNATURE_TOKEN_API_ERROR'); } });
  for (const args of [[], ['submit','--origin=elsewhere'], ['generate'], ['fund'], ['retry']]) {
    const output = [];
    assert.equal(await operator.main(args, deny, text => output.push(text)), 1);
    assert.equal(JSON.parse(output[0]).state, 'REFUSED');
    assert.ok(!output[0].includes('RAW_SECRET'));
  }
  const f = await fixture(); const h = harness(f); const output = [];
  h.io.exists = async () => { throw new Error('RAW_SECRET_SIGNATURE_TOKEN_API_ERROR'); };
  assert.equal(await operator.main(['submit'], h.io, text => output.push(text)), 1);
  assert.ok(!output[0].includes('RAW_SECRET')); assert.equal(h.seen.length, 0);
});
