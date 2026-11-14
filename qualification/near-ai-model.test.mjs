import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight, applyProfile, executeAttempt, cli, ENDPOINT, MODEL, PROFILE, ATTEMPT, fixture } from './near-ai-model.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const SCRATCH = fileURLToPath(new URL('../test-results/near-ai-offline/', import.meta.url));
const KEY = 'synthetic-SECRET-CANARY-not-real';
const REASONING = 'synthetic-REASONING-CANARY';
async function temp(t) { await mkdir(SCRATCH, { recursive: true }); const root = await mkdtemp(join(SCRATCH, 'near-ai-offline-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function envelope(patch = {}) {
  return { id: 'chatcmpl-synthetic-01', model: MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', reasoning_content: REASONING,
    content: JSON.stringify({ findings: [{ artifactId: fixture().evidence[0].artifactId, excerpt: 'PUBLIC FICTIONAL TEST EVIDENCE ONLY.' }] }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, completion_tokens_details: { reasoning_tokens: 20 } }, ...patch };
}
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'x-request-id': 'req-synthetic-01' } });
const options = root => ({ root, profile: PROFILE, env: { HALDIR_NEAR_AI_API_KEY: KEY }, mode: 'synthetic' });

test('one-shot synthetic execution uses actual adapter and durably reserves before HTTP, never replaying', async t => {
  const root = await temp(t); let calls = 0;
  const transport = async (url, init) => {
    calls++; assert.equal(url, ENDPOINT);
    const reservation = JSON.parse(await readFile(join(root, ATTEMPT, 'reservation.json'), 'utf8'));
    assert.equal(reservation.status, 'RESERVED_OUTCOME_UNKNOWN');
    assert.equal(reservation.maxCostMicros, '50000');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(JSON.parse(init.body).thinking_token_budget, 512);
    assert.equal(JSON.parse(init.body).max_completion_tokens, 2048);
    return jsonResponse(envelope());
  };
  const result = await executeAttempt({ ...options(root), transport });
  assert.equal(result.status, 'SYNTHETIC_PASS_NOT_LIVE');
  assert.equal(result.observedModel, MODEL); assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, reasoning_tokens: 20 });
  assert.equal(result.requestId, 'req-synthetic-01');
  assert.equal(result.validExcerpt, 'PUBLIC FICTIONAL TEST EVIDENCE ONLY.');
  assert.equal(typeof result.elapsedMs, 'number');
  const saved = await readFile(join(root, ATTEMPT, 'receipt.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved), result);
  assert.ok(!saved.includes(KEY)); assert.ok(!saved.includes(REASONING));
  const replay = await executeAttempt({ ...options(root), transport });
  assert.equal(replay.refusalCode, 'ATTEMPT_ALREADY_RESERVED'); assert.equal(calls, 1);
});

test('typed explicit transport delta adds only thinking_token_budget=512, rejecting implicit/mutated fields', () => {
  const body = { model: 'z-ai/glm-5.3-flash', messages: [], tools: [], tool_choice: 'none', parallel_tool_calls: false,
    stream: false, store: false, n: 1, max_completion_tokens: 2048, response_format: { type: 'json_schema' } };
  const init = { method: 'POST', redirect: 'error', credentials: 'omit', body: JSON.stringify(body) };
  assert.throws(() => applyProfile(ENDPOINT, init), e => e.code === 'TRANSPORT_PROFILE_REQUIRED');
  const next = applyProfile(ENDPOINT, init, PROFILE);
  assert.deepEqual(JSON.parse(next.body), { ...body, thinking_token_budget: 512 });
  assert.deepEqual(JSON.parse(init.body), body);
  for (const patch of [{ max_completion_tokens: 8192 }, { thinking_token_budget: null }, { enable_thinking: false }, { store: true }]) {
    assert.throws(() => applyProfile(ENDPOINT, { ...init, body: JSON.stringify({ ...body, ...patch }) }, PROFILE));
  }
});

test('offline preflight exercises the actual adapter without live evidence or secret lookup', async () => {
  const result = await preflight();
  assert.equal(result.status, 'OFFLINE_PASS_LIVE_NOT_RUN');
  assert.equal(result.model, 'z-ai/glm-5.3-flash');
  assert.equal(result.syntheticAdapterCalls, 1);
  assert.ok(BigInt(result.reservedCostMicros) <= 50000n);
});

const failures = [
  ...[400, 401, 402, 429, 500].map(status => [`HTTP ${status}`, () => new Response(`${KEY} ${REASONING} raw-provider-error`, { status }), 'MODEL_RESPONSE_REJECTED', `HTTP_${status}`]),
  ['transport secret error', () => { throw Object.assign(new Error(`${KEY} ${REASONING}`), { code: KEY }); }, 'MODEL_TRANSPORT_FAILED', null],
  ['malformed body', () => new Response(`{${KEY}`, { headers: { 'content-type': 'application/json' } }), 'MODEL_RESPONSE_REJECTED', null],
  ['oversized body', () => new Response('x'.repeat(131073), { headers: { 'content-type': 'application/json' } }), 'MODEL_RESPONSE_REJECTED', null],
  ['model mismatch', () => jsonResponse(envelope({ model: KEY })), 'MODEL_RESPONSE_REJECTED', 'MODEL_IDENTITY_MISMATCH'],
  ['wrong usage', () => jsonResponse(envelope({ usage: { prompt_tokens: 1, completion_tokens: 2049, total_tokens: 2050 } })), 'MODEL_RESPONSE_REJECTED', null],
  ['refusal', () => { const e = envelope(); e.choices[0].message.refusal = KEY; return jsonResponse(e); }, 'MODEL_RESPONSE_REJECTED', 'ASSISTANT_REFUSAL'],
  ['truncation', () => { const e = envelope(); e.choices[0].finish_reason = 'length'; return jsonResponse(e); }, 'MODEL_RESPONSE_REJECTED', 'OUTPUT_TRUNCATED'],
  ['fabricated excerpt', () => { const e = envelope(); e.choices[0].message.content = JSON.stringify({ findings: [{ artifactId: fixture().evidence[0].artifactId, excerpt: KEY }] }); return jsonResponse(e); }, 'MODEL_OUTPUT_REJECTED', null],
  ['expanded report ABI', () => { const e = envelope(); e.choices[0].message.content = JSON.stringify({ findings: [{ artifactId: fixture().evidence[0].artifactId, excerpt: 'PUBLIC FICTIONAL TEST EVIDENCE ONLY.' }], verified: true }); return jsonResponse(e); }, 'MODEL_OUTPUT_REJECTED', null],
];
for (const [name, respond, code, providerCode] of failures) test(`offline canary: ${name} sanitizes persisted receipt and never retries`, async t => {
  const root = await temp(t); let calls = 0;
  const transport = async () => { calls++; return respond(); };
  const receipt = await executeAttempt({ ...options(root), transport });
  assert.equal(receipt.status, 'ATTEMPT_FAILED_OR_UNKNOWN_NO_RETRY');
  assert.equal(receipt.refusalCode, code); assert.equal(receipt.providerRefusalCode, providerCode);
  assert.equal(receipt.validExcerpt, null);
  for (const file of ['reservation.json', 'receipt.json']) {
    const raw = await readFile(join(root, ATTEMPT, file), 'utf8');
    assert.ok(!raw.includes(KEY)); assert.ok(!raw.includes(REASONING)); assert.ok(!raw.includes('raw-provider-error'));
    assert.ok(!/reasoning_content|Authorization/.test(raw));
  }
  assert.equal((await executeAttempt({ ...options(root), transport })).refusalCode, 'ATTEMPT_ALREADY_RESERVED');
  assert.equal(calls, 1);
});
test('completion id is retained separately, never mislabeled as an HTTP request id', async t => {
  const root = await temp(t);
  const result = await executeAttempt({ ...options(root), transport: async () => new Response(JSON.stringify(envelope()), {
    headers: { 'content-type': 'application/json' } }) });
  assert.equal(result.requestId, null); assert.equal(result.responseId, 'chatcmpl-synthetic-01');
});
test('all persistent/output sinks reject credential collisions even in fixed metadata', async t => {
  const root = await temp(t); let calls = 0;
  const result = await executeAttempt({ ...options(root), env: { HALDIR_NEAR_AI_API_KEY: ATTEMPT },
    transport: async () => { calls++; return jsonResponse(envelope()); } });
  assert.ok(!JSON.stringify(result).includes(ATTEMPT));
  assert.equal(calls, 0); assert.deepEqual(await readdir(root), []);
});
test('provider exceeding the accepted thinking budget fails qualification even with an adapter-valid report', async t => {
  const root = await temp(t); const e = envelope();
  e.usage = { prompt_tokens: 100, completion_tokens: 600, total_tokens: 700, completion_tokens_details: { reasoning_tokens: 513 } };
  const result = await executeAttempt({ ...options(root), transport: async () => jsonResponse(e) });
  assert.equal(result.status, 'ATTEMPT_FAILED_OR_UNKNOWN_NO_RETRY');
  assert.equal(result.refusalCode, 'NEAR_AI_REASONING_BUDGET_REJECTED'); assert.equal(result.validExcerpt, null);
});
test('credential echoes in metadata are dropped; reasoning and unknown usage fields are never retained', async t => {
  const root = await temp(t);
  const e = envelope(); e.id = KEY; e.usage.secret = KEY;
  const result = await executeAttempt({ ...options(root), transport: async () => new Response(JSON.stringify(e), {
    headers: { 'content-type': 'application/json', 'x-request-id': KEY } }) });
  assert.equal(result.status, 'SYNTHETIC_PASS_NOT_LIVE'); assert.equal(result.requestId, null);
  assert.ok(!JSON.stringify(result).includes(KEY)); assert.ok(!JSON.stringify(result).includes(REASONING));
});
test('concurrent instances get only one permanent attempt and a crash tombstone cannot be reused', async t => {
  const root = await temp(t); let calls = 0;
  const opts = { ...options(root), transport: async () => { calls++; return jsonResponse(envelope()); } };
  const results = await Promise.all([executeAttempt(opts), executeAttempt(opts)]);
  assert.equal(results.filter(r => r.status === 'SYNTHETIC_PASS_NOT_LIVE').length, 1);
  assert.equal(results.filter(r => r.refusalCode === 'ATTEMPT_ALREADY_RESERVED').length, 1); assert.equal(calls, 1);
  const tombstoneRoot = await temp(t); await mkdir(join(tombstoneRoot, ATTEMPT));
  assert.equal((await executeAttempt({ ...opts, root: tombstoneRoot })).refusalCode, 'ATTEMPT_ALREADY_RESERVED');
  assert.equal(calls, 1);
});

const liveArgs = ['--live', '--accept-transport-profile', PROFILE, '--confirm-usd-ceiling', '0.05',
  '--confirm-public-fictional-data', '--tariff-confirmed', '2026-11-13'];
test('actual CLI entrypoint returns offline JSON by default and refuses unbounded live flags', () => {
  const path = fileURLToPath(new URL('./near-ai-model.mjs', import.meta.url));
  for (const [args, status, exit] of [[[], 'OFFLINE_PASS_LIVE_NOT_RUN', 0], [['--preflight'], 'OFFLINE_PASS_LIVE_NOT_RUN', 0], [['--live'], 'BLOCKED_NO_HTTP', 1]]) {
    const child = spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, HOME: SCRATCH, HALDIR_NEAR_AI_API_KEY: KEY } });
    assert.equal(child.status, exit); assert.equal(child.stderr, '');
    assert.equal(JSON.parse(child.stdout).status, status); assert.ok(!child.stdout.includes(KEY));
  }
});
test('CLI defaults offline without reading a poisoned credential getter; live admission is explicit and tariff-fresh', async t => {
  const root = await temp(t); let calls = 0;
  const env = new Proxy({}, { get() { throw new Error('NO_SECRET_READ_ALLOWED'); } });
  const deps = { env, root, transport: async () => { calls++; throw new Error(KEY); }, now: () => Date.parse('2026-11-13T11:00:00Z') };
  assert.equal((await cli([], deps)).status, 'OFFLINE_PASS_LIVE_NOT_RUN');
  assert.equal((await cli(['--preflight'], deps)).status, 'OFFLINE_PASS_LIVE_NOT_RUN');
  assert.equal((await cli(['--live'], deps)).refusalCode, 'EXPLICIT_LIVE_BOUNDS_REQUIRED');
  assert.equal((await cli([...liveArgs, '--model', 'other'], deps)).refusalCode, 'CLI_ARGUMENTS_REJECTED');
  assert.equal((await cli(liveArgs, { ...deps, now: () => Date.parse('2026-11-15T00:00:00Z') })).refusalCode, 'TARIFF_RECONFIRMATION_REQUIRED');
  const missing = await cli(liveArgs, { ...deps, env: { NEAR_AI_API_KEY: KEY, NEARAI_API_KEY: KEY } });
  assert.equal(missing.refusalCode, 'DEDICATED_APPLICATION_KEY_REQUIRED');
  assert.equal(calls, 0); assert.deepEqual(await readdir(root), []);
});
