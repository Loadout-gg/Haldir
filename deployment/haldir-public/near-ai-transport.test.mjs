import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedCompletion } from './near-ai-worker.mjs';
import { runSdkWorker, createNearAiTransport } from './near-ai-transport.mjs';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const body = { model: 'z-ai/glm-5.3-flash', stream: false, thinking_token_budget: 512,
  max_tokens: 2048, messages: [{ role: 'user', content: 'synthetic' }] };
const secret = 'SECRET_REASONING_KEY_RAW_ERROR_CANARY';
const unavailable = error => error.message === 'NEAR_AI_UNAVAILABLE' && !JSON.stringify(error).includes(secret);
function fakeClient(options = {}) {
  const events = [], pauses = [], ids = []; let lookups = 0;
  const envelope = { id: 'synthetic-id', model: NEAR_AI_MODEL,
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}', reasoning_content: secret, reasoning: secret } }],
    usage: { prompt_tokens: 1, completion_tokens: 600, total_tokens: 601,
      completion_tokens_details: { reasoning_tokens: options.reasoning ?? 0 } }, ...options.envelope };
  return { events, pauses, ids, envelope, async factory(configuration) {
    assert.deepEqual(configuration, { apiKey: options.apiKey ?? secret, e2ee: true, baseUrl: 'https://cloud-api.near.ai/v1' });
    events.push('runtime');
    return { sdkVersion: options.sdkVersion ?? '0.3.0',
      getSdkError: error => error.syntheticApi ? error : undefined,
      pause: async ms => { pauses.push(ms); }, client: {
        async fetch(url, init) {
          events.push('fetch'); assert.equal(url, NEAR_AI_ENDPOINT);
          assert.deepEqual(JSON.parse(init.body), body);
          if (options.fetchError) throw new Error(secret);
          return options.response?.() ?? Response.json(envelope, { status: options.status ?? 200,
            headers: { 'inference-id': options.inferenceId ?? '12345678-1234-1234-1234-1234567890ab' } });
        },
        async verifyResponse(id) {
          events.push('verify'); ids.push(id); lookups++;
          if (options.error) throw options.error;
          if (lookups <= (options.unavailable ?? 0)) throw Object.assign(new Error(secret), {
            name: 'ApiError', syntheticApi: true, retryable: false,
            failure: { code: 'api.completion_signature_unavailable' },
          });
          return { id: options.verifiedId ?? id, signatureKind: options.kind ?? 'provider_tee' };
        },
        clearResponseCache() { events.push('clear'); },
      } };
  } };
}

test('worker verifies exact completion before releasing allowlisted envelope and observed receipt', async () => {
  const f = fakeClient();
  const result = await verifiedCompletion({ apiKey: secret, body }, f.factory);
  assert.deepEqual(f.events, ['runtime', 'fetch', 'verify', 'clear']);
  assert.equal(result.receipt.sdkVersion, '0.3.0');
  assert.equal(result.receipt.httpStatus, 200);
  assert.equal(result.receipt.model, f.envelope.model);
  assert.equal(result.receipt.signatureKind, 'provider_tee');
  assert.equal(result.receipt.e2ee, true);
  assert.equal(result.receipt.inferenceId, '12345678-1234-1234-1234-1234567890ab');
  assert.equal(result.receipt.completionId, 'synthetic-id');
  assert.equal(result.receipt.id, f.envelope.id);
  assert.equal(result.receipt.signatureLookups, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result.envelope.usage, { prompt_tokens: 1, completion_tokens: 600, total_tokens: 601 });
});
test('signature availability retries only same ID, four attempts maximum with 250/500/1000 backoff', async () => {
  const eventual = fakeClient({ unavailable: 2 });
  const result = await verifiedCompletion({ apiKey: secret, body }, eventual.factory);
  assert.equal(eventual.events.filter(e => e === 'fetch').length, 1);
  assert.deepEqual(eventual.ids, ['synthetic-id', 'synthetic-id', 'synthetic-id']);
  assert.deepEqual(eventual.pauses, [250, 500]);
  assert.equal(result.receipt.signatureLookups, 3);
  const exhausted = fakeClient({ unavailable: 20 });
  await assert.rejects(verifiedCompletion({ apiKey: secret, body }, exhausted.factory));
  assert.equal(exhausted.events.filter(e => e === 'fetch').length, 1);
  assert.deepEqual(exhausted.ids, Array(4).fill('synthetic-id'));
  assert.deepEqual(exhausted.pauses, [250, 500, 1000]);
  assert.equal(exhausted.events.at(-1), 'clear');
});

test('worker rejects gateway, wrong verified ID and invalid signatures, sanitizing all thrown errors', async () => {
  for (const options of [{ kind: 'gateway' }, { verifiedId: 'wrong-id' },
    { error: new Error(secret) },
    { error: Object.assign(new Error(secret), { name: 'VerificationError', syntheticApi: true, retryable: true }) },
    { error: Object.assign(new Error(secret), { name: 'ApiError', retryable: true }) },
    { fetchError: true }]) {
    const f = fakeClient(options);
    await assert.rejects(verifiedCompletion({ apiKey: secret, body }, f.factory), unavailable);
    assert.equal(f.events.filter(e => e === 'fetch').length, 1);
    assert.ok(f.ids.length <= 1); assert.deepEqual(f.pauses, []);
    assert.equal(f.events.at(-1), 'clear');
  }
});

test('worker rejects wrong SDK/model/profile and invalid HTTP/usage before releasing output', async () => {
  for (const options of [{ sdkVersion: '0.3.1' }, { envelope: { model: 'different-model' } },
    { status: 201 }, { status: 503 }, { envelope: { id: secret + '\\n' } },
    { envelope: { usage: { prompt_tokens: 1, completion_tokens: 2049, total_tokens: 2050 } } },
    { envelope: { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 1 } } },
    { envelope: { usage: { prompt_tokens: 210000, completion_tokens: 1, total_tokens: 210001 } } },
    { reasoning: 601 }]) {
    const f = fakeClient(options);
    await assert.rejects(verifiedCompletion({ apiKey: secret, body }, f.factory), unavailable);
    assert.equal(f.events.at(-1), 'clear');
  }
  for (const invalidBody of [{ ...body, model: 'different-model' }, { ...body, stream: true },
    { ...body, thinking_token_budget: 513 }, { ...body, max_tokens: 2049 }]) {
    const f = fakeClient();
    await assert.rejects(verifiedCompletion({ apiKey: secret, body: invalidBody }, f.factory), unavailable);
    assert.deepEqual(f.events, []);
  }
  await assert.rejects(verifiedCompletion({ apiKey: secret, body }, async () => { throw new Error(secret); }), unavailable);
});

test('worker records thinking overshoot without rejecting otherwise bounded output', async () => {
  const f = fakeClient({ reasoning: 513, inferenceId: secret });
  const result = await verifiedCompletion({ apiKey: secret, body }, f.factory);
  assert.equal(result.receipt.reasoningTokens, 513);
  assert.equal(result.receipt.reasoningBudgetExceeded, true);
  assert.equal(result.receipt.inferenceId, null);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('worker bounds streamed bytes, validates UTF8/JSON and rejects echoed key without raw errors', async () => {
  let cancelled = false;
  const huge = fakeClient({ response: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(131073).fill(32)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }) });
  // The stream deliberately never ends: the byte cap must cancel it, not await JSON EOF.
  await assert.rejects(verifiedCompletion({ apiKey: secret, body }, huge.factory), unavailable);
  assert.equal(cancelled, true); assert.equal(huge.events.at(-1), 'clear');
  for (const options of [
    { response: () => new Response(secret, { headers: { 'content-type': 'text/plain' } }) },
    { response: () => new Response(secret, { headers: { 'content-type': 'application/json' } }) },
    { response: () => new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }) },
    { envelope: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: secret } }] } },
  ]) {
    const f = fakeClient(options);
    await assert.rejects(verifiedCompletion({ apiKey: secret, body }, f.factory), unavailable);
    assert.equal(f.events.at(-1), 'clear');
  }
});

test('bridge abort awaits termination and ignores success/error messages arriving during termination', async () => {
  const worker = new EventEmitter(), controller = new AbortController(), termination = deferred();
  let terminating = false, settled = false, created = false;
  worker.terminate = () => { terminating = true; return termination.promise; };
  const promise = runSdkWorker({ apiKey: secret, body }, controller.signal, { workerFactory: (url, options) => {
    created = true;
    assert.equal(url.pathname.endsWith('/near-ai-worker.mjs'), true);
    assert.deepEqual(options.env, {}); assert.deepEqual(options.execArgv, []);
    assert.equal(options.stdout, true); assert.equal(options.stderr, true);
    assert.equal(options.resourceLimits.maxOldGenerationSizeMb, 128);
    return worker;
  } });
  const checked = promise.then(() => { settled = true; assert.fail('late result released'); }, error => {
    settled = true; assert.equal(unavailable(error), true);
  });
  controller.abort(); await Promise.resolve();
  assert.equal(created, true); assert.equal(terminating, true); assert.equal(settled, false);
  worker.emit('message', { ok: true, secret }); worker.emit('error', new Error(secret));
  termination.resolve(1); await checked;
});

test('bridge timeout, worker errors, early exit and factory failures sanitize and terminate', async () => {
  for (const event of ['timeout', 'error', 'exit', 'message']) {
    const worker = new EventEmitter(); let terminated = 0;
    worker.terminate = async () => { terminated++; return 1; };
    const promise = runSdkWorker({}, undefined, { timeoutMs: 5, workerFactory: () => worker });
    if (event === 'error') worker.emit('error', new Error(secret));
    if (event === 'exit') worker.emit('exit', 0);
    if (event === 'message') worker.emit('message', { ok: false, error: secret });
    await assert.rejects(promise, unavailable); assert.equal(terminated, 1);
  }
  await assert.rejects(runSdkWorker({}, undefined, { workerFactory: () => { throw new Error(secret); } }), unavailable);
  const controller = new AbortController(); controller.abort(); let created = false;
  await assert.rejects(runSdkWorker({}, controller.signal, { workerFactory: () => { created = true; } }), unavailable);
  assert.equal(created, false);
});

test('real Worker termination finishes before abort/deadline settles, with no late result', async t => {
  for (const mode of ['abort', 'deadline']) {
    const state = new SharedArrayBuffer(8), view = new Int32Array(state);
    const controller = new AbortController(); let worker, exited = false;
    const promise = runSdkWorker({}, controller.signal, { timeoutMs: 500, workerFactory: (_url, options) => {
      worker = new Worker(`const {workerData,parentPort}=require('node:worker_threads');
        const view=new Int32Array(workerData); Atomics.store(view,0,1);
        setInterval(()=>Atomics.add(view,1,1),1);
        setTimeout(()=>parentPort.postMessage({ok:true,secret:'${secret}'}),2000);`,
      { ...options, eval: true, workerData: state });
      worker.once('exit', () => { exited = true; });
      t.after(async () => { await worker.terminate(); });
      return worker;
    } });
    const checked = assert.rejects(promise, unavailable);
    for (let i = 0; i < 100 && !Atomics.load(view, 0); i++) await delay(2);
    assert.equal(Atomics.load(view, 0), 1, 'real worker must have started');
    if (mode === 'abort') controller.abort();
    await checked;
    assert.equal(exited, true); assert.equal(worker.threadId, -1);
    const stoppedHeartbeat = Atomics.load(view, 1); await delay(15);
    assert.equal(Atomics.load(view, 1), stoppedHeartbeat);
  }
});

test('default worker entry replies fail-closed before importing SDK for invalid profile', async t => {
  let worker, message;
  const promise = runSdkWorker({ apiKey: secret, body: { ...body, model: 'wrong' } }, undefined, {
    workerFactory: (url, options) => {
      worker = new Worker(url, options); worker.on('message', value => { message = value; });
      t.after(async () => { await worker.terminate(); }); return worker;
    },
  });
  await assert.rejects(promise, unavailable);
  assert.deepEqual(message, { ok: false }); assert.equal(worker.threadId, -1);
});

test('transport preserves exact profile, returns only verified envelope and defensive observed receipt', async () => {
  const expected = await verifiedCompletion({ apiKey: secret, body }, fakeClient().factory);
  let received;
  const wire = createNearAiTransport({ apiKey: secret, run: async (input, signal) => {
    received = input; assert.equal(signal, undefined); return { ok: true, ...expected };
  } });
  assert.equal(wire.getReceipt(), null);
  const response = await wire.transport(NEAR_AI_ENDPOINT, { method: 'POST', body: JSON.stringify(body) });
  assert.deepEqual(received, { apiKey: secret, body }); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(expected.envelope)));
  assert.deepEqual(wire.getReceipt(), expected.receipt);
  const copy = wire.getReceipt(); copy.usage.total_tokens = 999;
  assert.equal(wire.getReceipt().usage.total_tokens, 601);
  await wire.drain();
});

test('transport fails closed on malformed scope, unverified receipts and key-bearing thrown errors', async () => {
  let calls = 0;
  const wire = createNearAiTransport({ apiKey: secret, run: async () => { calls++; throw new Error(secret); } });
  for (const [url, init] of [
    ['https://evil.invalid', { method: 'POST', body: JSON.stringify(body) }],
    [NEAR_AI_ENDPOINT, { method: 'GET', body: JSON.stringify(body) }],
    [NEAR_AI_ENDPOINT, { method: 'POST', body: '{' }],
    [NEAR_AI_ENDPOINT, { method: 'POST', body: JSON.stringify({ ...body, model: 'wrong' }) }],
    [NEAR_AI_ENDPOINT, { method: 'POST', body: JSON.stringify({ ...body, stream: true }) }],
    [NEAR_AI_ENDPOINT, { method: 'POST', body: JSON.stringify({ ...body, thinking_token_budget: 513 }) }],
  ]) await assert.rejects(wire.transport(url, init), unavailable);
  assert.equal(calls, 0);
  await assert.rejects(wire.transport(NEAR_AI_ENDPOINT, { method: 'POST', body: JSON.stringify(body) }), unavailable);
  await wire.drain(); assert.equal(calls, 1); assert.equal(wire.getReceipt(), null);
  const expected = await verifiedCompletion({ apiKey: secret, body }, fakeClient().factory);
  for (const delta of [{ signatureKind: 'gateway' }, { model: 'wrong' }, { e2ee: false },
    { sdkVersion: '0.3.1' }, { httpStatus: 201 }]) {
    const unverified = createNearAiTransport({ apiKey: secret, run: async () => ({ ok: true, ...expected,
      receipt: { ...expected.receipt, ...delta } }) });
    await assert.rejects(unverified.transport(NEAR_AI_ENDPOINT, { method: 'POST', body: JSON.stringify(body) }), unavailable);
    assert.equal(unverified.getReceipt(), null);
  }
});

test('transport rejects concurrent use so drain cannot lose an outstanding worker', async () => {
  const expected = { ok: true, ...await verifiedCompletion({ apiKey: secret, body }, fakeClient().factory) };
  const release = deferred(); let calls = 0, drained = false;
  const wire = createNearAiTransport({ apiKey: secret, run: async () => {
    calls++; if (calls === 1) await release.promise; return expected;
  } });
  const init = { method: 'POST', body: JSON.stringify(body) };
  const first = wire.transport(NEAR_AI_ENDPOINT, init);
  try {
    await assert.rejects(wire.transport(NEAR_AI_ENDPOINT, init), unavailable);
    const drain = wire.drain().then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false); assert.equal(calls, 1);
    release.resolve(); await first; await drain; assert.equal(drained, true);
  } finally { release.resolve(); await first; }
});

test('transport combines both signals, blocks pre-abort and suppresses late success while drain awaits', async () => {
  const expected = { ok: true, ...await verifiedCompletion({ apiKey: secret, body }, fakeClient().factory) };
  for (const source of ['constructor', 'request']) {
    const controller = new AbortController(), release = deferred(); let receivedSignal, drained = false;
    const wire = createNearAiTransport({ apiKey: secret,
      signal: source === 'constructor' ? controller.signal : undefined,
      run: async (_input, signal) => { receivedSignal = signal; await release.promise; return expected; },
    });
    const pending = wire.transport(NEAR_AI_ENDPOINT, { method: 'POST', body: JSON.stringify(body),
      signal: source === 'request' ? controller.signal : undefined });
    const checked = assert.rejects(pending, unavailable);
    await Promise.resolve(); controller.abort(); assert.equal(receivedSignal.aborted, true);
    const drain = wire.drain().then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    release.resolve(); await checked; await drain; assert.equal(wire.getReceipt(), null);
  }
  const controller = new AbortController(); controller.abort(); let called = false;
  const wire = createNearAiTransport({ apiKey: secret, signal: controller.signal, run: async () => { called = true; } });
  await assert.rejects(wire.transport(NEAR_AI_ENDPOINT, { method: 'POST', body: JSON.stringify(body) }), unavailable);
  assert.equal(called, false);
});

test('bridge deadline includes constructor delay and post-message termination, not just SDK wait', async () => {
  for (const phase of ['constructor', 'termination']) {
    const worker = new EventEmitter(); let terminated = 0;
    worker.terminate = async () => { terminated++; if (phase === 'termination') await delay(20); return 1; };
    const pending = runSdkWorker({}, undefined, { timeoutMs: 5, workerFactory: () => {
      if (phase === 'constructor') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      queueMicrotask(() => worker.emit('message', { ok: true })); return worker;
    } });
    await assert.rejects(pending, unavailable); assert.equal(terminated, 1);
  }
});

test('bridge default and oversized test timeout never schedule beyond twenty seconds', async () => {
  for (const timeoutMs of [undefined, 999999]) {
    let scheduled; const original = globalThis.setTimeout;
    const worker = new EventEmitter(); worker.terminate = async () => 1;
    let promise;
    try {
      globalThis.setTimeout = (callback, milliseconds) => { scheduled = milliseconds; return original(callback, 1); };
      promise = runSdkWorker({}, undefined, { timeoutMs, workerFactory: () => worker });
    } finally { globalThis.setTimeout = original; }
    await assert.rejects(promise, unavailable);
    assert.ok(scheduled > 0 && scheduled <= 20000);
  }
});

test('bridge success also waits for termination and a termination failure never returns output', async () => {
  const worker = new EventEmitter(), termination = deferred(); let settled = false;
  worker.terminate = () => termination.promise;
  const promise = runSdkWorker({}, undefined, { workerFactory: () => worker });
  const checked = promise.then(result => { settled = true; return result; });
  worker.emit('message', { ok: true, value: 'synthetic-verified' });
  await Promise.resolve(); assert.equal(settled, false);
  termination.resolve(1); assert.deepEqual(await checked, { ok: true, value: 'synthetic-verified' });
  const broken = new EventEmitter(); broken.terminate = async () => { throw new Error(secret); };
  const rejected = runSdkWorker({}, undefined, { workerFactory: () => broken });
  broken.emit('message', { ok: true, secret });
  await assert.rejects(rejected, unavailable);
});


for (const [label, apiKey] of [['quote','SYNTHETIC-"CREDENTIAL'],['backslash','SYNTHETIC-\\CREDENTIAL']]) {
 test(`worker rejects ${label} key inside JSON completion string leaves`,async()=>{
  const content=JSON.stringify({findings:[{artifactId:'fictional:test',excerpt:`Input contains ${apiKey}`}],interpretations:[]});
  const f=fakeClient({apiKey,envelope:{choices:[{finish_reason:'stop',message:{role:'assistant',content}}]}});
  await assert.rejects(verifiedCompletion({apiKey,body},f.factory),unavailable);
  assert.equal(f.events.at(-1),'clear');
 });
}
test('escaped noncredential JSON completion remains usable',async()=>{
 const content=JSON.stringify({findings:[{artifactId:'fictional:test',excerpt:'A "quoted" \\ noncredential sample'}],interpretations:[]});
 const f=fakeClient({envelope:{choices:[{finish_reason:'stop',message:{role:'assistant',content}}]}});
 const result=await verifiedCompletion({apiKey:secret,body},f.factory);
 assert.equal(result.envelope.choices[0].message.content,content);
});

test('worker rejects echoed key even when JSON escaping changes its serialized bytes', async () => {
  const apiKey = 'SYNTHETIC-"BACKSLASH\\\\-KEY';
  const f = fakeClient({ apiKey, envelope: { choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: apiKey } }] } });
  await assert.rejects(verifiedCompletion({ apiKey, body }, f.factory), unavailable);
  assert.equal(f.events.at(-1), 'clear');
});

import { NEAR_AI_ENDPOINT, NEAR_AI_MODEL, NEAR_AI_PROFILE, NEAR_AI_RELEASE, modelAuthorization } from './near-ai-policy.mjs';

test('policy preserves approved limits and uses explicit caller-selected authorization expiry', () => {
  const expiresAt = '2026-11-16T23:59:00Z';
  const authorization = modelAuthorization('synthetic-authorization', expiresAt);
  assert.deepEqual(authorization, {
    authorizationId: 'synthetic-authorization', endpoint: NEAR_AI_ENDPOINT, model: NEAR_AI_MODEL,
    credentialSource: 'application-runtime', billingApproved: true, dataApproved: true,
    expiresAt, maxCalls: 2, maxPromptBytes: 98304, maxCompletionTokens: 2048,
    maxTotalTokens: 210000, timeoutMs: 25000, inputRateMicrosPerMillion: '80000',
    outputRateMicrosPerMillion: '500000', maxCostMicros: '50000',
  });
  assert.equal(NEAR_AI_PROFILE, 'near-ai-glm53-thinking512-v1');
  assert.deepEqual(NEAR_AI_RELEASE, { key: 'haldir-near-ai-demo-20261113', maxCostMicros: '1000000' });
  assert.equal(modelAuthorization('other', '2026-11-17T00:00:00Z').expiresAt, '2026-11-17T00:00:00Z');
});
