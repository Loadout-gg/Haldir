import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelProvider } from '../../src/agent/model-provider.mjs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

function artifact() { const content = 'Northwind is fictional. Registry excerpt: sample company records, not assurance.';
  return { artifactId: 'fictional:quote-1', orderId: quote().orderId, vendorId: quote().vendorId,
    fictionalSample: true, qualification: 'LOCAL_SYNTHETIC_ONLY', mediaType: 'text/plain', content,
    contentDigest: createHash('sha256').update(content).digest('hex') }; };
const report = () => ({ phase: 'report', approvedJobInput: job(), evidence: [artifact()], tools: [] });
function findings() { return { findings: [{ artifactId: artifact().artifactId, excerpt: 'Northwind is fictional.' }] }; }

test('report receives delivered content only and returns exact bounded citation ABI', async () => {
  let body;
  const { provider } = setup({ transport: async (_url, init) => { body = JSON.parse(init.body); return response(findings()); } });
  assert.deepEqual(await provider.propose(report()), findings());
  assert.deepEqual(body.tools, []);
  assert.equal(body.response_format.json_schema.name, 'haldir_report');
  const f = body.response_format.json_schema.schema.properties.findings;
  assert.equal(f.minItems, 1);
  assert.equal(f.maxItems, 12);
  assert.equal(f.items.properties.excerpt.maxLength, 4096);
  assert.ok(body.messages[0].content.includes('exact substring'));
  assert.ok(body.messages[1].content.includes(artifact().content));
});

const badRequests = [
  ['unknown phase', r => { r.phase = 'owner-stop'; }],
  ['secret field', r => { r.accessKey = 'do-not-send'; }],
  ['job extra secret', r => { r.approvedJobInput.privateKey = 'do-not-send'; }],
  ['quote extra secret', r => { r.approvedQuote.apiKey = 'do-not-send'; }],
  ['configured credential in job text', r => { r.approvedJobInput.purpose = configuration().apiKey; }],
  ['private key text', r => { r.approvedJobInput.purpose = '-----BEGIN PRIVATE KEY-----'; }],
  ['unapproved recipient', r => { r.approvedQuote.vendorId = 'evil.testnet'; r.tools[0].approvedQuote = r.approvedQuote; }],
  ['over-budget quote', r => { r.approvedQuote.amountAtomic = '31'; r.tools[0].approvedQuote = r.approvedQuote; }],
  ['noncanonical amount', r => { r.approvedQuote.amountAtomic = '08'; r.tools[0].approvedQuote = r.approvedQuote; }],
  ['wrong network', r => { r.approvedQuote.networkId = 'mainnet'; }],
  ['wrong mandate', r => { r.approvedQuote.mandateId = 'other.testnet'; }],
  ['expired purchase', r => { r.approvedJobInput.expiresAt = '2026-11-13T11:00:00Z'; }],
  ['unbounded job text', r => { r.approvedJobInput.purpose = 'x'.repeat(2049); }],
  ['arbitrary tool descriptor', r => { r.tools.push({ name: 'withdraw' }); }],
  ['changed allowlisted quote', r => { r.tools[0].approvedQuote.amountAtomic = '7'; }],
];
for (const [name, mutate] of badRequests) test(`request rejects ${name} without model billing or transport`, async () => {
  const { provider, calls, reservations } = setup(); const r = plan(); mutate(r);
  await assert.rejects(provider.propose(r), e => e.code === 'MODEL_INPUT_REJECTED');
  assert.equal(calls.length, 0); assert.equal(reservations.length, 0);
});

for (const [name, mutate] of [
  ['undelivered source', r => { r.evidence = []; }],
  ['multiple sources beyond current ABI', r => { r.evidence.push(artifact()); }],
  ['wrong digest', r => { r.evidence[0].contentDigest = '0'.repeat(64); }],
  ['unapproved vendor', r => { r.evidence[0].vendorId = 'evil.testnet'; }],
  ['lost fictional label', r => { r.evidence[0].fictionalSample = false; }],
  ['report tool capability', r => { r.tools = [{ name: 'withdraw' }]; }],
  ['artifact secret field', r => { r.evidence[0].secret = 'do-not-send'; }],
]) test(`report input rejects ${name} before model I/O`, async () => {
  const { provider, calls, reservations } = setup(); const r = report(); mutate(r);
  await assert.rejects(provider.propose(r), e => e.code === 'MODEL_INPUT_REJECTED');
  assert.equal(calls.length, 0); assert.equal(reservations.length, 0);
});

test('paid evidence reporting remains allowed after purchase deadline', async () => {
  const { provider } = setup({ transport: async () => response(findings()) });
  const r = report(); r.approvedJobInput.expiresAt = '2026-11-13T11:00:00Z';
  assert.deepEqual(await provider.propose(r), findings());
});

for (const [name, options] of [
  ['prompt byte limit', { maxPromptBytes: 1 }],
  ['total token limit', { maxTotalTokens: 1 }],
  ['currency limit', { maxCostMicros: '1' }],
]) test(`${name} rejects before reservation or model transport`, async () => {
  const { provider, calls, reservations } = setup({ authorization: { ...authorization(), ...options } });
  await assert.rejects(provider.propose(plan()), e => e.code === 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(calls.length, 0); assert.equal(reservations.length, 0);
});

test('call budget is cumulative and plan cannot be replayed as another billed request', async () => {
  const { provider, calls } = setup();
  assert.deepEqual(await provider.propose(plan()), proposal());
  await assert.rejects(provider.propose(plan()), e => e.code === 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(calls.length, 1);
});

test('durable budget denial prevents any HTTP request', async () => {
  const { provider, calls } = setup({ budget: { reserve: async () => false } });
  await assert.rejects(provider.propose(plan()), e => e.code === 'MODEL_BUDGET_REJECTED');
  assert.equal(calls.length, 0);
});

for (const [name, mutate] of [
  ['HTTP rejection', () => new Response('do-not-leak-provider-error', { status: 429 })],
  ['redirect', () => new Response('', { status: 307, headers: { location: 'https://evil.invalid' } })],
  ['streaming media type', () => new Response('{}', { headers: { 'content-type': 'text/event-stream' } })],
  ['malformed JSON envelope', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
  ['wrong model', () => response(proposal(), { model: 'other-model' })],
  ['missing usage', () => response(proposal(), { usage: null })],
  ['over-completion ceiling', () => response(proposal(), { usage: { prompt_tokens: 100, completion_tokens: 2049, total_tokens: 2149 } })],
  ['inconsistent usage', () => response(proposal(), { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 151 } })],
  ['over-input reservation', () => response(proposal(), { usage: { prompt_tokens: 999999, completion_tokens: 1, total_tokens: 1000000 } })],
  ['multiple candidates', () => response(proposal(), { choices: [0, 1].map(() => ({ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposal()) } })) })],
  ['null candidate', () => response(proposal(), { choices: [null] })],
  ['invalid proposal JSON', () => response(proposal(), { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{' } }] })],
  ['truncated generation', () => response(proposal(), { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: JSON.stringify(proposal()) } }] })],
  ['tool call despite valid content', () => response(proposal(), { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposal()), tool_calls: [{ type: 'function', function: { name: 'pay', arguments: '{}' } }] } }] })],
  ['legacy function call', () => response(proposal(), { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposal()), function_call: { name: 'withdraw' } } }] })],
  ['refusal', () => response(proposal(), { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposal()), refusal: 'denied' } }] })],
  ['oversized response', () => new Response(' '.repeat(131073), { headers: { 'content-type': 'application/json' } })],
]) test(`HTTP result rejects ${name} without retry or leaking remote text`, async () => {
  let count = 0;
  const { provider } = setup({ transport: async () => { count++; return mutate(); } });
  await assert.rejects(provider.propose(plan()), e => e.code === 'MODEL_RESPONSE_REJECTED' && e.message === e.code && !e.cause);
  assert.equal(count, 1);
});

test('transport failure is sanitized and never retried', async () => {
  let count = 0;
  const { provider } = setup({ transport: async () => { count++; throw new Error(configuration().apiKey); } });
  await assert.rejects(provider.propose(plan()), e => e.code === 'MODEL_TRANSPORT_FAILED' && e.message === e.code && !e.cause);
  await assert.rejects(provider.propose(plan()), e => e.code === 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(count, 1);
});

for (const [name, value] of [
  ['changed recipient', { tool: 'requestquote', arguments: { ...quote(), vendorId: 'evil.testnet' } }],
  ['extra capability', { ...proposal(), execute: true }],
  ['unapproved tool', { tool: 'pay', arguments: quote() }],
]) test(`plan output rejects ${name}`, async () => {
  const { provider } = setup({ transport: async () => response(value) });
  await assert.rejects(provider.propose(plan()), e => e.code === 'MODEL_OUTPUT_REJECTED');
});
for (const [name, value] of [
  ['missing citations', { findings: [] }],
  ['fabricated artifact', { findings: [{ artifactId: 'unpaid', excerpt: 'Northwind is fictional.' }] }],
  ['invented assurance', { findings: [{ artifactId: artifact().artifactId, excerpt: 'Supplier verified.' }] }],
  ['extra finding fields', { findings: [{ ...findings().findings[0], supplierVerified: true }] }],
  ['extra report fields', { ...findings(), conclusions: 'Supplier verified.' }],
  ['too many citations', { findings: Array.from({ length: 13 }, () => findings().findings[0]) }],
  ['empty excerpt', { findings: [{ artifactId: artifact().artifactId, excerpt: '' }] }],
]) test(`report output rejects ${name}`, async () => {
  const { provider } = setup({ transport: async () => response(value) });
  await assert.rejects(provider.propose(report()), e => e.code === 'MODEL_OUTPUT_REJECTED');
});

test('authorization is checked again at use, before any reservation', async () => {
  let observed = clock;
  const { provider, calls, reservations } = setup({ now: () => observed });
  observed = Date.parse(authorization().expiresAt);
  await assert.rejects(provider.propose(plan()), e => e.code === 'MODEL_AUTHORIZATION_EXPIRED');
  assert.equal(calls.length, 0); assert.equal(reservations.length, 0);
});

test('authorization expiration during durable reservation blocks HTTP', async () => {
  let observed = clock, count = 0;
  const { provider } = setup({ now: () => observed,
    budget: { reserve: async () => { observed = Date.parse(authorization().expiresAt); return true; } },
    transport: async () => { count++; return response(proposal()); } });
  await assert.rejects(provider.propose(plan()), e => e.code === 'MODEL_AUTHORIZATION_EXPIRED');
  assert.equal(count, 0);
});

for (const stage of ['reservation', 'transport', 'response-body']) test(`wall deadline bounds stuck ${stage} and quarantines the instance`, async () => {
  let signal, canceled = false, count = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  const { provider } = setup({ authorization: { ...authorization(), timeoutMs: 15 },
    budget: { reserve: async () => stage === 'reservation' ? held : true },
    transport: async (_url, init) => {
      count++; signal = init.signal;
      if (stage === 'transport') return held;
      return new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'content-type': 'application/json' } });
    } });
  let timer;
  try {
    const outcome = await Promise.race([
      provider.propose(plan()).then(() => 'unexpected-success', e => e.code),
      new Promise(resolve => { timer = setTimeout(() => resolve('NOT_BOUNDED'), 200); }),
    ]);
    assert.equal(outcome, 'MODEL_TIMEOUT');
    if (signal) assert.equal(signal.aborted, true);
    if (stage === 'response-body') assert.equal(canceled, true);
    await assert.rejects(provider.propose(report()), e => e.code === 'MODEL_BUDGET_EXHAUSTED');
  } finally {
    clearTimeout(timer); release(stage === 'transport' ? response(proposal()) : true);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(count, stage === 'reservation' ? 0 : 1);
});

test('durable reservation errors are sanitized and block transport', async () => {
  const { provider, calls } = setup({ budget: { reserve: async () => { throw new Error('private repository detail'); } } });
  await assert.rejects(provider.propose(plan()), e => e.code === 'MODEL_BUDGET_REJECTED' && e.message === e.code && !e.cause);
  assert.equal(calls.length, 0);
});

test('same instance cannot report a different order after planning', async () => {
  const { provider, calls } = setup();
  await provider.propose(plan());
  const r = report(); r.evidence[0].orderId = 'other-order';
  await assert.rejects(provider.propose(r), e => e.code === 'MODEL_INPUT_REJECTED');
  assert.equal(calls.length, 1);
});

test('instance cannot overlap a report with its unresolved plan', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { provider } = setup({ transport: async () => held });
  const pending = provider.propose(plan());
  let timer;
  try {
    const outcome = await Promise.race([
      provider.propose(report()).then(() => 'unexpected-success', e => e.code),
      new Promise(resolve => { timer = setTimeout(() => resolve('OVERLAPPED'), 200); }),
    ]);
    assert.equal(outcome, 'MODEL_BUDGET_EXHAUSTED');
  } finally { clearTimeout(timer); release(response(proposal())); await pending; }
});

test('synthetic loopback HTTP roundtrip carries both exact runner phases (not live model qualification)', async t => {
  const received = [];
  const transport = await loopback(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push({ method: req.method, path: req.url, headers: req.headers, body });
    const result = body.response_format.json_schema.name === 'haldir_plan' ? proposal() : findings();
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(await response(result).text());
  });
  const { provider, reservations } = setup({ transport });
  assert.deepEqual(await provider.propose(plan()), proposal());
  assert.deepEqual(await provider.propose(report()), findings());
  await assert.rejects(provider.propose(report()), e => e.code === 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(received.length, 2); assert.equal(reservations.length, 2);
  for (const r of received) {
    assert.equal(r.method, 'POST'); assert.equal(r.path, '/v1/chat/completions');
    assert.equal(r.headers.authorization, `Bearer ${configuration().apiKey}`);
    assert.equal(r.headers['content-type'], 'application/json');
    assert.deepEqual(r.body.tools, []); assert.equal(r.body.tool_choice, 'none');
    assert.equal(r.body.max_completion_tokens, authorization().maxCompletionTokens);
  }
});

test('synthetic native HTTP body stall is aborted within the configured deadline', async t => {
  let count = 0;
  const transport = await loopback(t, async (_req, res) => {
    count++; res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
  });
  const { provider } = setup({ transport, authorization: { ...authorization(), timeoutMs: 100 } });
  await assert.rejects(provider.propose(plan()), e => e.code === 'MODEL_TIMEOUT');
  assert.equal(count, 1);
  await assert.rejects(provider.propose(report()), e => e.code === 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(count, 1);
});

test('synthetic native HTTP never follows a redirect to another endpoint', async t => {
  let count = 0;
  const transport = await loopback(t, async (_req, res) => {
    count++; res.writeHead(302, { location: '/forbidden-second-request' }); res.end();
  });
  const { provider } = setup({ transport });
  await assert.rejects(provider.propose(plan()), e => e.code === 'MODEL_TRANSPORT_FAILED');
  assert.equal(count, 1);
});

// Only this test-owned transport can call real fetch, and only a fixed ephemeral
// loopback URL. No credential discovery, remote DNS or external model call.
const nativeFetch = globalThis.fetch;
async function loopback(t, handler) {
  const server = createServer((req, res) => { handler(req, res).catch(() => { res.destroy(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  return (url, init) => {
    assert.equal(url, configuration().endpoint);
    return nativeFetch(endpoint, init);
  };
}

// Characterization of the preserved guards and extra cumulative budget coverage.
test('a second instance still needs a fresh durable reservation, not a replay acknowledgement', async () => {
  const used = new Set(); let requests = 0;
  const budget = { reserve: async ({ authorizationId, jobId, phase }) => {
    const key = JSON.stringify([authorizationId, jobId, phase]);
    if (used.has(key)) return false; used.add(key); return true;
  } };
  const options = { budget, transport: async () => { requests++; return response(proposal()); } };
  await setup(options).provider.propose(plan());
  await assert.rejects(setup(options).provider.propose(plan()), e => e.code === 'MODEL_BUDGET_REJECTED');
  assert.equal(requests, 1);
});

test('maxCalls one cannot admit a second phase', async () => {
  const { provider, calls } = setup({ authorization: { ...authorization(), maxCalls: 1 } });
  await provider.propose(plan());
  await assert.rejects(provider.propose(report()), e => e.code === 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(calls.length, 1);
});

for (const dimension of ['tokens', 'currency']) test(`cumulative ${dimension} reservation prevents a second phase`, async () => {
  const probe = setup(); await probe.provider.propose(plan());
  const first = probe.reservations[0];
  const limited = { ...authorization(), ...(dimension === 'tokens'
    ? { maxTotalTokens: first.reservedTokens } : { maxCostMicros: first.reservedCostMicros }) };
  const { provider, calls } = setup({ authorization: limited });
  await provider.propose(plan());
  await assert.rejects(provider.propose(report()), e => e.code === 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(calls.length, 1);
});

test('caller mutation while reservation waits cannot change the approved quote or returned plan', async () => {
  let release; const reserved = new Promise(resolve => { release = resolve; });
  const { provider } = setup({ budget: { reserve: async () => reserved } });
  const input = plan(); const pending = provider.propose(input);
  input.approvedQuote.amountAtomic = '7'; input.tools[0].approvedQuote.vendorId = 'evil.testnet';
  release(true); assert.deepEqual(await pending, proposal());
});

test('same adapter cannot be reused for a different admitted job', async () => {
  const { provider, calls } = setup(); await provider.propose(plan());
  const r = report(); r.approvedJobInput.jobId = 'job-2';
  await assert.rejects(provider.propose(r), e => e.code === 'MODEL_INPUT_REJECTED');
  assert.equal(calls.length, 1);
});

const clock = Date.parse('2026-11-13T12:00:00Z');
function quote() { return { networkId: 'testnet', mandateId: 'mandate.testnet', vendorId: 'registry.testnet',
  amountAtomic: '8', orderId: 'registry-1', content: 'Fictional supplier records' }; }
const job = () => ({ jobId: 'job-1', ownerId: 'alice.testnet', quoteId: 'quote-1',
  qualification: 'LOCAL_SYNTHETIC_ONLY', networkId: 'testnet', mandateId: 'mandate.testnet',
  purpose: 'Check fictional Northwind Print', output: 'Evidence-linked report', budgetAtomic: '30',
  vendorIds: ['registry.testnet', 'repcheck.testnet'], expiresAt: '2026-11-13T18:00:00Z' });
const plan = () => ({ phase: 'plan', approvedJobInput: job(), approvedQuote: quote(),
  tools: [{ name: 'requestquote', approvedQuote: quote() }] });
function proposal() { return { tool: 'requestquote', arguments: quote() }; }
const configuration = () => ({ protocol: 'chat-completions', endpoint: 'https://model.invalid/v1/chat/completions',
  model: 'explicit-synthetic-model', apiKey: 'synthetic-application-key-not-real' });
const authorization = () => ({ authorizationId: 'test-grant-1', endpoint: configuration().endpoint,
  model: configuration().model, credentialSource: 'application-runtime', billingApproved: true, dataApproved: true,
  expiresAt: '2026-11-13T18:00:00Z', maxCalls: 2, maxPromptBytes: 20000, maxCompletionTokens: 2048,
  maxTotalTokens: 50000, timeoutMs: 1000, inputRateMicrosPerMillion: '1000000',
  outputRateMicrosPerMillion: '2000000', maxCostMicros: '100000' });
function response(value, patch = {}) {
  return new Response(JSON.stringify({ model: configuration().model,
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, ...patch }),
  { headers: { 'content-type': 'application/json' } });
}
function setup(options = {}) {
  const calls = [], reservations = [];
  const provider = createModelProvider({ configuration: configuration(), authorization: authorization(), now: () => clock,
    budget: { async reserve(value) { reservations.push(structuredClone(value)); return true; } },
    transport: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return response(proposal()); },
    ...options });
  return { provider, calls, reservations };
}

test('explicit offline HTTP transport emits constrained JSON request and returns exact runner plan ABI', async () => {
  const { provider, calls, reservations } = setup();
  assert.deepEqual(await provider.propose(plan()), proposal());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, configuration().endpoint);
  const { init, body } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers.Authorization, `Bearer ${configuration().apiKey}`);
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(body.model, configuration().model);
  assert.equal(body.max_completion_tokens, authorization().maxCompletionTokens);
  assert.deepEqual(body.tools, []);
  assert.equal(body.tool_choice, 'none');
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.stream, false);
  assert.equal(body.store, false);
  assert.equal(body.n, 1);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(JSON.stringify(body.messages).includes(configuration().apiKey), false);
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].authorizationId, authorization().authorizationId);
  assert.equal(reservations[0].jobId, job().jobId);
  assert.ok(reservations[0].reservedTokens > body.max_completion_tokens);
});

test('missing runtime provider selection fails closed without transport or ambient credentials', () => {
  let calls = 0;
  assert.throws(() => createModelProvider({ transport: () => { calls++; } }),
    e => e.code === 'MODEL_PROVIDER_DECISION_REQUIRED');
  assert.equal(calls, 0);
});

for (const [name, change] of [
  ['missing authorization', p => { p.authorization = undefined; }],
  ['missing runtime key', p => { p.configuration.apiKey = ''; }],
  ['other endpoint', p => { p.authorization.endpoint = 'https://other.invalid/v1/chat/completions'; }],
  ['other model', p => { p.authorization.model = 'unapproved'; }],
  ['HTTP endpoint', p => { p.configuration.endpoint = p.authorization.endpoint = 'http://model.invalid/v1/chat/completions'; }],
  ['embedded credentials', p => { p.configuration.endpoint = p.authorization.endpoint = 'https://user:pass@model.invalid/v1/chat/completions'; }],
  ['query credential', p => { p.configuration.endpoint = p.authorization.endpoint += '?key=secret'; }],
  ['fragment', p => { p.configuration.endpoint = p.authorization.endpoint += '#secret'; }],
  ['different protocol', p => { p.configuration.protocol = 'subscription-cli'; }],
  ['Hermes credential provenance', p => { p.authorization.credentialSource = 'hermes-subscription'; }],
  ['no billing authorization', p => { p.authorization.billingApproved = false; }],
  ['no privacy authorization', p => { p.authorization.dataApproved = false; }],
  ['expired grant', p => { p.authorization.expiresAt = '2026-11-13T11:59:59Z'; }],
  ['unbounded calls', p => { p.authorization.maxCalls = 3; }],
  ['unbounded tokens', p => { p.authorization.maxCompletionTokens = Infinity; }],
  ['unbounded timeout', p => { p.authorization.timeoutMs = 60001; }],
  ['negative tariff', p => { p.authorization.inputRateMicrosPerMillion = '-1'; }],
  ['zero budget', p => { p.authorization.maxCostMicros = '0'; }],
  ['missing durable budget gate', p => { p.budget = undefined; }],
  ['key header injection', p => { p.configuration.apiKey = 'key\r\nInjected: bad'; }],
]) test(`configuration rejects ${name} before any I/O`, () => {
  let calls = 0;
  const p = { configuration: configuration(), authorization: authorization(), now: () => clock,
    budget: { reserve: async () => { calls++; return true; } }, transport: async () => { calls++; } };
  change(p);
  assert.throws(() => createModelProvider(p), e => e.code === 'MODEL_PROVIDER_DECISION_REQUIRED');
  assert.equal(calls, 0);
});
