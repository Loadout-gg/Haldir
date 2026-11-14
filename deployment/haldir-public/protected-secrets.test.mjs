import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import { createProtectedSecretResolver, immutableSecretVersion } from './protected-secrets.mjs';
import { validateProductionBinding, readProductionBinding } from './production-binding.mjs';
const modelVersion = 'projects/147018706305/secrets/haldir-model-synthetic/versions/1';
const payVersion = 'projects/147018706305/secrets/haldir-agent-pay-synthetic/versions/1';
const identity = 'haldir-runtime@loadout-haldir-demo.iam.gserviceaccount.com';
const modelKey = 'DUMMY_NOT_PROVIDER_KEY_123456789';
const failure = { message: 'PROTECTED_SECRET_UNAVAILABLE' };
function fixture(t, mutate = x => x) {
  const calls = [], pair = KeyPair.fromRandom('ed25519');
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init }); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    let response;
    if (url.endsWith('/email')) {
      assert.equal(new Headers(init.headers).get('Metadata-Flavor'), 'Google');
      response = new Response(identity, { headers: { 'Metadata-Flavor': 'Google' } });
    } else if (url.endsWith('/token')) {
      response = Response.json({ access_token: 'SYNTHETIC_ADC_TOKEN', expires_in: 600, token_type: 'Bearer' }, { headers: { 'Metadata-Flavor': 'Google' } });
    } else {
      assert.equal(url, `https://secretmanager.googleapis.com/v1/${calls.length && url.includes('agent-pay') ? payVersion : modelVersion}:access`);
      assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer SYNTHETIC_ADC_TOKEN');
      const name = url.includes('agent-pay') ? payVersion : modelVersion;
      response = Response.json({ name, payload: { data: Buffer.from(name === modelVersion ? modelKey : pair.toString()).toString('base64') } });
    }
    return mutate(response, url, init);
  });
  const resolve = createProtectedSecretResolver({ modelVersion, payOnlyVersions: [payVersion] });
  return { calls, resolve, pair, read: (keyVersion = modelVersion, signal = new AbortController().signal) => resolve({ keyVersion, signal }) };
}
test('fixed attached ADC and exact immutable model/pay-only reads; no listing/alias/retry', async t => {
  const h = fixture(t); assert.equal(await h.read(), modelKey); assert.equal(await h.read(payVersion), h.pair.toString());
  assert.equal(h.calls.length, 6); assert.equal(h.calls.filter(c => c.url.includes('secretmanager')).length, 2);
  assert.equal(immutableSecretVersion(payVersion, 'model'), false); assert.equal(immutableSecretVersion(modelVersion, 'pay-only'), false);
});
test('wrong resource/role/version/extra field/preabort rejected before any ADC or secret request', async t => {
  const h = fixture(t);
  for (const keyVersion of [payVersion.replace('/1', '/2'), modelVersion.replace('/1', '/latest'),
    payVersion.replace('147018706305', 'other'), payVersion.replace('agent-pay', 'bootstrap'),
    payVersion.replace('agent-pay', 'owner'), modelVersion.replace('/1', '/01'), 'https://evil.invalid'])
    await assert.rejects(h.read(keyVersion), failure);
  await assert.rejects(h.read(modelVersion, AbortSignal.abort('DUMMY_SECRET_ABORT_REASON')), failure);
  await assert.rejects(h.resolve({ keyVersion: modelVersion, signal: new AbortController().signal, transport: () => {} }), failure);
  assert.equal(h.calls.length, 0);
});
for (const [name, change] of [
  ['wrong attached identity', r => new Response('other@invalid', { headers: r.headers })],
  ['missing metadata flavor', r => new Response(identity)],
]) test(`ADC ${name} denies token/secret resolution`, async t => {
  const h = fixture(t, (r, url) => url.endsWith('/email') ? change(r) : r);
  await assert.rejects(h.read(), failure); assert.equal(h.calls.length, 1);
});
for (const [name, payload] of [
  ['wrong reply version', { name: payVersion, payload: { data: Buffer.from(modelKey).toString('base64') } }],
  ['empty data', { name: modelVersion, payload: { data: '' } }],
  ['bad base64', { name: modelVersion, payload: { data: '@@@@' } }],
  ['wrong type', { name: modelVersion, payload: { data: 123 } }],
  ['extra field', { name: modelVersion, payload: { data: 'RFVNTVk=', secret: 'DUMMY_SECRET_MUST_NOT_ESCAPE' } }],
  ['wrong integrity', { name: modelVersion, payload: { data: Buffer.from(modelKey).toString('base64'), dataCrc32c: '0' } }],
]) test(`protected ${name} emits only fixed redacted errors`, async t => {
  const h = fixture(t, (r, url) => url.includes('secretmanager') ? Response.json(payload) : r);
  await assert.rejects(h.read(), failure); assert.equal(h.calls.length, 3);
});
test('raw transport/parse/abort secrets never escape and are never automatically retried', async t => {
  const h = fixture(t, (_r, url) => { if (url.includes('secretmanager')) throw Error('DUMMY_SECRET_MUST_NOT_ESCAPE'); return _r; });
  await assert.rejects(h.read(), failure); assert.equal(h.calls.length, 3);
});
test('rejects wrong pay-only key type before SDK construction', async t => {
  const h = fixture(t, (r, url) => url.includes('secretmanager') ? Response.json({ name: payVersion,
    payload: { data: Buffer.from('secp256k1:DUMMY_SECRET_MUST_NOT_ESCAPE').toString('base64') } }) : r);
  await assert.rejects(h.read(payVersion), failure);
});
test('size cap cancels and drains body; cannot release dependent finance', async t => {
  let cancelled = 0, dependent = 0;
  const h = fixture(t, (r, url) => url.includes('secretmanager') ? new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(8193)); }, cancel() { cancelled++; },
  })) : r);
  await assert.rejects(h.read().then(() => dependent++), failure);
  assert.equal(cancelled, 1); assert.equal(dependent, 0);
});
test('abort during cleanup drains fully and denies dependent finance even after valid secret bytes', async t => {
  const controller = new AbortController(); let cancelled = 0, dependent = 0;
  const h = fixture(t, (r, url) => {
    if (!url.includes('secretmanager')) return r;
    const reader = r.body.getReader();
    return { status: 200, redirected: false, headers: r.headers, body: { getReader: () => ({
      read: () => reader.read(), releaseLock: () => reader.releaseLock(),
      async cancel() { await reader.cancel(); cancelled++; controller.abort('DUMMY_SECRET_ABORT_REASON'); },
    }) } };
  });
  await assert.rejects(h.read(modelVersion, controller.signal).then(() => dependent++), failure);
  assert.equal(cancelled, 1); assert.equal(dependent, 0);
});
test('abort cancels stalled secret body and awaits cancellation before rejection', async t => {
  const controller = new AbortController(); let drained = false, started;
  const reading = new Promise(r => { started = r; });
  const h = fixture(t, (r, url, init) => {
    if (!url.includes('secretmanager')) return r;
    return new Response(new ReadableStream({ start(c) {
      started(); init.signal.addEventListener('abort', () => { drained = true; c.error(Error('DUMMY_SECRET_ABORT_REASON')); }, { once: true });
    } }));
  });
  const result = h.read(modelVersion, controller.signal); const rejection = assert.rejects(result, failure);
  await reading; controller.abort(); await rejection; assert.equal(drained, true);
});
test('single monotonic deadline rejects late email before token/secret and ignores a delayed timer', async t => {
  let clock = 0; t.mock.method(performance, 'now', () => clock);
  const h = fixture(t, (r, url) => { if (url.endsWith('/email')) clock = 5001; return r; });
  await assert.rejects(h.read(), failure); assert.equal(h.calls.length, 1);
});
test('non-success responses are drained before failure, not retried', async t => {
  let cancelled = 0;
  const h = fixture(t, (_r, url) => url.includes('secretmanager') ? new Response(new ReadableStream({
    start(c) { c.enqueue(Buffer.from('DUMMY_SECRET_MUST_NOT_ESCAPE')); }, cancel() { cancelled++; },
  }), { status: 503 }) : _r);
  await assert.rejects(h.read(), failure); assert.equal(h.calls.length, 3); assert.equal(cancelled, 1);
});
for(const kind of ['redirected','wrong-url','declared-size']) test(`protected ${kind} response is refused and drained`,async t=>{
  let cancelled=0;
  const h=fixture(t,(r,url)=>{if(!url.includes('secretmanager'))return r;
    const body=new ReadableStream({start(c){c.enqueue(Buffer.from('DUMMY_NOT_SECRET'));},cancel(){cancelled++;}});
    return {status:200,redirected:kind==='redirected',url:kind==='wrong-url'?'https://evil.invalid':url,
      headers:new Headers(kind==='declared-size'?{'content-length':'8193'}:{}),body};
  });
  await assert.rejects(h.read(),failure);assert.equal(cancelled,1);assert.equal(h.calls.length,3);
});
test('real five-second timer aborts a stalled metadata fetch, with no token/secret request or deadline renewal', {timeout:7000},async t=>{
  let settled=false;
  const h=fixture(t,(_r,_url,init)=>new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>{settled=true;reject(Error('DUMMY_ABORT_REASON'));},{once:true});}));
  const start=performance.now();await assert.rejects(h.read(),failure);assert.equal(settled,true);assert.equal(h.calls.length,1);
  assert.ok(performance.now()-start>=4900 && performance.now()-start<6500);
});
test('source-owned policy is closed and strict complete sealed schema cannot renew authority', () => {
  assert.deepEqual(readProductionBinding(), { schemaVersion: 'haldir.production-binding.v1', state: 'closed' });
  const b = { schemaVersion: 'haldir.production-binding.v1', state: 'sealed', activationApprovalId: 'SYNTHETIC_APPROVAL',
    projectId: 'loadout-haldir-demo', projectNumber: '147018706305', region: 'europe-west1', runtimeServiceAccount: identity,
    model: { model: 'z-ai/glm-5.3-flash', credentialVersion: modelVersion, authorizationExpiresAt: '2026-11-16T23:59:00Z', historicalBudgetUsdTotal: '50' },
    signingBindings: [{ ownerId: 'synthetic.testnet', approvalId: 'approved', manifestId: 'manifest', publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString(), keyVersion: payVersion }] };
  assert.ok(Object.isFrozen(validateProductionBinding(b).signingBindings[0]));
  for (const change of [x => { delete x.activationApprovalId; }, x => { x.state = 'enabled'; }, x => { x.enabled = true; },
    x => { x.model.authorizationExpiresAt = '2099-01-01T00:00:00Z'; }, x => { x.model.historicalBudgetUsdTotal = '500'; },
    x => { x.model.transportFactory = 'not allowed'; }, x => { x.model.model = 'other'; }, x => { x.signingBindings = []; },
    x => { x.signingBindings.push(structuredClone(x.signingBindings[0])); }, x => { x.signingBindings[0].keyVersion = modelVersion; },
    x => { x.runtimeServiceAccount = 'owner@invalid'; }, x => { x.model.credentialVersion = modelVersion.replace('/1', '/latest'); }]) {
    const value = structuredClone(b); change(value); assert.throws(() => validateProductionBinding(value), { message: 'PRODUCTION_BINDING_INVALID' });
  }
});
