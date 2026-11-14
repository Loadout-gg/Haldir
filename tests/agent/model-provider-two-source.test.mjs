import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createModelProvider } from '../../src/agent/model-provider.mjs';
import * as modelModule from '../../src/agent/model-provider.mjs';
import { approvedSources, approvedInput } from '../../src/shared/job-contract.mjs';
import { fictionalArtifact } from '../../src/vendor/fixture.mjs';

const clock = Date.parse('2026-11-13T12:00:00Z');
const configuration = () => ({ protocol: 'chat-completions', endpoint: 'https://model.invalid/v1/chat/completions',
  model: 'explicit-synthetic-model', apiKey: 'synthetic-application-key-not-real' });
const authorization = c => ({ authorizationId: 'whole-job-grant', endpoint: c.endpoint, model: c.model,
  credentialSource: 'application-runtime', billingApproved: true, dataApproved: true,
  expiresAt: '2026-11-16T23:59:00Z', maxCalls: 2, maxPromptBytes: 100000, maxCompletionTokens: 2048,
  maxTotalTokens: 300000, timeoutMs: 1000, inputRateMicrosPerMillion: '1000000',
  outputRateMicrosPerMillion: '2000000', maxCostMicros: '500000' });
function fixture() {
  const scope = { networkId: 'testnet', mandateId: 'mandate.testnet', purpose: 'Compare fictional sources',
    output: 'Evidence-linked brief', budgetAtomic: '30', vendorIds: ['registry.testnet', 'research.testnet'],
    expiresAt: '2026-11-13T18:00:00.123Z' };
  const approved = { schemaVersion: 'haldir.approved.two-source.v1', job: scope,
    sources: ['company-records', 'background-research'].map((sourceId, i) => ({ sourceId, quote: {
      networkId: scope.networkId, mandateId: scope.mandateId, vendorId: scope.vendorIds[i],
      amountAtomic: i ? '9' : '8', orderId: `order-${i}`, content: `Fictional ${sourceId}` } })) };
  const sources = approvedSources(approved);
  const j = approvedInput({ schemaVersion: 'haldir.job.two-source.v1', jobId: 'job-1', ownerId: 'alice.testnet',
    qualification: 'LOCAL_SYNTHETIC_ONLY', quoteId: sources[0].quoteId,
    sourceRefs: sources.map(({ sourceId, quoteId }) => ({ sourceId, quoteId })), scope });
  const plan = { phase: 'plan', approvedJobInput: j, approvedSources: sources,
    tools: [{ name: 'requestquotes', approvedSources: structuredClone(sources) }] };
  const evidence = sources.map(({ quoteId, quote }, i) => {
    const content = `Source ${i}: fictional supplied details, not assurance.`;
    return { artifactId: `fictional:${quoteId}`, orderId: quote.orderId, vendorId: quote.vendorId,
      fictionalSample: true, qualification: j.qualification, mediaType: 'text/plain', content,
      contentDigest: createHash('sha256').update(content).digest('hex') };
  });
  return { plan, report: { phase: 'report', approvedJobInput: structuredClone(j), evidence, tools: [] },
    proposal: { tool: 'requestquotes', arguments: { quoteIds: sources.map(s => s.quoteId) } },
    result: { findings: evidence.map(e => ({ artifactId: e.artifactId, excerpt: e.content })),
      interpretations: [{ kind: 'COMPARE_COMPANY_DETAILS', findingIndexes: [0] },
        { kind: 'COMPARE_SOURCE_CONSISTENCY', findingIndexes: [0, 1] }] } };
}
function setup(options = {}) {
  const calls = [], reservations = [];
  const c = options.configuration ?? configuration();
  const provider = createModelProvider({ configuration: c, authorization: authorization(c), now: () => clock,
    budget: { async reserve(v) { reservations.push(structuredClone(v)); return true; } },
    transport: async (url, init) => {
      const body = JSON.parse(init.body); calls.push({ url, body, init });
      const r = JSON.parse(body.messages[1].content);
      const output = options.output ? options.output(r) : r.phase === 'plan' ? fixture().proposal : fixture().result;
      return new Response(JSON.stringify({ model: c.model,
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }),
      { headers: { 'content-type': 'application/json' } });
    }, ...Object.fromEntries(Object.entries(options).filter(([k]) => k !== 'output')) });
  return { provider, calls, reservations };
}


for (const [label, apiKey] of [['quote','SYNTHETIC-"CREDENTIAL'],['backslash','SYNTHETIC-\\CREDENTIAL']]) {
 test(`configured ${label} key in actual input string is rejected before reservation and HTTP`,async()=>{
  const f=fixture();f.plan.approvedJobInput.purpose=`Fictional input ${apiKey}`;
  const s=setup({configuration:{...configuration(),apiKey}});
  await assert.rejects(s.provider.propose(f.plan),error=>error.code==='MODEL_INPUT_REJECTED');
  assert.equal(s.reservations.length,0);assert.equal(s.calls.length,0);
 });
 test(`pure cached request rejects configured ${label} key without I/O`,()=>{
  const f=fixture();f.plan.approvedJobInput.purpose=`Fictional input ${apiKey}`;
  assert.throws(()=>modelModule.validateModelResult(f.plan,f.proposal,{apiKey}),error=>error.code==='MODEL_INPUT_REJECTED');
 });
}
test('noncredential escaped input remains accepted in fresh and cached paths',async()=>{
 const f=fixture();f.plan.approvedJobInput.purpose='Compare "fictional" \\ records';
 const s=setup();assert.deepEqual(await s.provider.propose(f.plan),f.proposal);
 assert.deepEqual(modelModule.validateModelResult(f.plan,f.proposal,{apiKey:configuration().apiKey}),f.proposal);
});

test('public TS1 projection accepts BOTH real fictionalArtifact outputs without relabeling their qualification', async () => {
  const f = fixture();
  f.plan.approvedJobInput.qualification = 'PUBLIC_TESTNET_FICTIONAL_VENDOR';
  f.report.approvedJobInput = structuredClone(f.plan.approvedJobInput);
  f.report.evidence = f.plan.approvedSources.map(s => fictionalArtifact(s));
  assert.deepEqual(f.report.evidence.map(e => e.qualification), ['LOCAL_SYNTHETIC_ONLY', 'LOCAL_SYNTHETIC_ONLY']);
  f.result.findings = f.report.evidence.map(e => ({ artifactId: e.artifactId, excerpt: e.content }));
  const s = setup({ output: r => r.phase === 'plan' ? f.proposal : f.result });
  assert.deepEqual(await s.provider.propose(f.plan), f.proposal);
  assert.deepEqual(await s.provider.propose(f.report), f.result);
  assert.deepEqual(modelModule.validateModelResult(f.report, f.result), f.result);
  assert.deepEqual(s.reservations.map(r => r.phase), ['plan', 'report']);
  assert.deepEqual(JSON.parse(s.calls[1].body.messages[1].content).evidence, f.report.evidence);
});

for (const qualification of ['PUBLIC_TESTNET_FICTIONAL_VENDOR', 'UNVERIFIED', '']) test(`public TS1 rejects relabeled fictional artifact qualification ${qualification}`, async () => {
  const f = fixture(); f.report.approvedJobInput.qualification = 'PUBLIC_TESTNET_FICTIONAL_VENDOR';
  f.report.evidence = f.plan.approvedSources.map(s => fictionalArtifact(s));
  f.report.evidence[1].qualification = qualification;
  const s = setup();
  await assert.rejects(s.provider.propose(f.report), e => e.code === 'MODEL_INPUT_REJECTED');
  assert.equal(s.calls.length, 0); assert.equal(s.reservations.length, 0);
});

test('pure cache validator returns defensive dual-ABI copies with no inference or clock authority', () => {
  assert.equal(typeof modelModule.validateModelResult, 'function', 'pure cache validator export');
  const f = fixture();
  for (const [request, result] of [[f.plan, f.proposal], [f.report, f.result]]) {
    const validated = modelModule.validateModelResult(request, result);
    assert.deepEqual(validated, result); assert.notEqual(validated, result);
    if (request.phase === 'plan') validated.arguments.quoteIds.reverse();
    else validated.findings[0].excerpt = 'mutation';
    assert.notDeepEqual(validated, result);
  }
  f.plan.approvedJobInput.expiresAt = '2020-01-01T00:00:00.123Z';
  assert.deepEqual(modelModule.validateModelResult(f.plan, f.proposal), f.proposal);
  const legacyPlan = structuredClone(f.plan);
  delete legacyPlan.approvedJobInput.sourceRefs;
  legacyPlan.approvedQuote = legacyPlan.approvedSources[0].quote; delete legacyPlan.approvedSources;
  legacyPlan.tools = [{ name: 'requestquote', approvedQuote: structuredClone(legacyPlan.approvedQuote) }];
  assert.deepEqual(modelModule.validateModelResult(legacyPlan, { tool: 'requestquote', arguments: legacyPlan.approvedQuote }),
    { tool: 'requestquote', arguments: legacyPlan.approvedQuote });
  const legacyReport = structuredClone(f.report); delete legacyReport.approvedJobInput.sourceRefs; legacyReport.evidence.pop();
  assert.deepEqual(modelModule.validateModelResult(legacyReport, { findings: [f.result.findings[0]] }), { findings: [f.result.findings[0]] });
  assert.throws(() => modelModule.validateModelResult({ ...f.plan, signal: new AbortController().signal }, f.proposal), e => e.code === 'MODEL_INPUT_REJECTED');
  const corrupt = structuredClone(f.result); corrupt.findings.pop();
  assert.throws(() => modelModule.validateModelResult(f.report, corrupt), e => e.code === 'MODEL_OUTPUT_REJECTED');
  const sparse = structuredClone(f.result); delete sparse.findings[0];
  assert.throws(() => modelModule.validateModelResult(f.report, sparse), e => e.code === 'MODEL_OUTPUT_REJECTED');
});

for (const [name, mutate] of [
  ['sparse findings', v => { v.findings.length = 3; }],
  ['sparse interpretations', v => { v.interpretations = new Array(1); }],
  ['sparse indexes', v => { v.interpretations = [{ kind: 'COMPARE_COMPANY_DETAILS', findingIndexes: [0, ,] }]; }],
]) test(`pure cache validator rejects ${name}`, () => {
  const f = fixture(); mutate(f.result);
  assert.throws(() => modelModule.validateModelResult(f.report, f.result), e => e.code === 'MODEL_OUTPUT_REJECTED');
});

test('literal repository-key and artifact-ID bounds preserve opaque legacy identifiers', async () => {
  const f = fixture(), r = structuredClone(f.report);
  delete r.approvedJobInput.sourceRefs;
  r.approvedJobInput.quoteId = `opaque:/+ ${'q'.repeat(2038)}`;
  assert.equal(r.approvedJobInput.quoteId.length, 2048);
  r.evidence.pop(); r.evidence[0].artifactId = 'a'.repeat(2060);
  const value = { findings: [{ artifactId: r.evidence[0].artifactId, excerpt: r.evidence[0].content }] };
  const ok = setup({ output: () => value }); assert.deepEqual(await ok.provider.propose(r), value);
  for (const mutate of [x => { x.approvedJobInput.quoteId += 'x'; }, x => { x.evidence[0].artifactId += 'x'; }]) {
    const bad = structuredClone(r); mutate(bad); const s = setup();
    await assert.rejects(s.provider.propose(bad), e => e.code === 'MODEL_INPUT_REJECTED');
    assert.equal(s.reservations.length, 0); assert.equal(s.calls.length, 0);
  }
});

test('report permits two opaque 2048-unit refs and exact fictional artifact IDs without decoding keys', async () => {
  const f = fixture();
  f.report.approvedJobInput.sourceRefs.forEach((ref, i) => {
    ref.quoteId = `${i}:${'x'.repeat(2046)}`;
    f.report.evidence[i].artifactId = `fictional:${ref.quoteId}`;
    f.result.findings[i].artifactId = f.report.evidence[i].artifactId;
  });
  f.report.approvedJobInput.quoteId = f.report.approvedJobInput.sourceRefs[0].quoteId;
  const s = setup({ output: () => f.result });
  assert.deepEqual(await s.provider.propose(f.report), f.result);
});

test('U128 maximum sum is accepted with canonical second-aligned deadline', async () => {
  const f = fixture(), r = f.plan;
  r.approvedJobInput.budgetAtomic = String(2n ** 128n - 1n);
  r.approvedJobInput.expiresAt = '2026-11-13T18:00:00Z';
  r.approvedSources[0].quote.amountAtomic = String(2n ** 128n - 2n);
  r.approvedSources[1].quote.amountAtomic = '1';
  r.tools[0].approvedSources = structuredClone(r.approvedSources);
  assert.deepEqual(await setup().provider.propose(r), f.proposal);
});

for (const count of [0, 1, 2]) test(`report accepts ${count} interpretations with exact 4096-char excerpts and twelve findings`, async () => {
  const f = fixture();
  for (const e of f.report.evidence) { e.content = 'x'.repeat(4096); e.contentDigest = createHash('sha256').update(e.content).digest('hex'); }
  f.result.findings = Array.from({ length: 12 }, (_, i) => ({ artifactId: f.report.evidence[i % 2].artifactId, excerpt: 'x'.repeat(4096) }));
  f.result.interpretations = f.result.interpretations.slice(0, count);
  if (count === 2) f.result.interpretations[1].findingIndexes = Array.from({ length: 12 }, (_, i) => 11 - i);
  const s = setup({ output: () => f.result });
  assert.deepEqual(await s.provider.propose(f.report), f.result);
});

test('report remains available after millisecond purchase expiry; second-order mismatch cannot reserve a report', async () => {
  const f = fixture();
  f.report.approvedJobInput.expiresAt = '2020-01-01T00:00:00.123Z';
  assert.deepEqual(await setup().provider.propose(f.report), f.result);
  const s = setup(); await s.provider.propose(f.plan);
  f.report.approvedJobInput = structuredClone(f.plan.approvedJobInput);
  f.report.evidence[1].orderId = 'different-order';
  await assert.rejects(s.provider.propose(f.report), e => e.code === 'MODEL_INPUT_REJECTED');
  assert.equal(s.calls.length, 1); assert.equal(s.reservations.length, 1);
});

test('pure cache validator applies obvious secret guards and optional configured-key guard', () => {
  const f = fixture();
  f.plan.approvedJobInput.purpose = configuration().apiKey;
  assert.throws(() => modelModule.validateModelResult(f.plan, f.proposal, { apiKey: configuration().apiKey }), e => e.code === 'MODEL_INPUT_REJECTED');
  f.plan.approvedJobInput.purpose = '-----BEGIN PRIVATE KEY-----';
  assert.throws(() => modelModule.validateModelResult(f.plan, f.proposal), e => e.code === 'MODEL_INPUT_REJECTED');
});

test('partial report input consumes no report phase; later full evidence can use its one report', async () => {
  const s = setup(), f = fixture();
  await s.provider.propose(f.plan);
  const partial = structuredClone(f.report); partial.evidence.pop();
  await assert.rejects(s.provider.propose(partial), e => e.code === 'MODEL_INPUT_REJECTED');
  assert.equal(s.reservations.length, 1);
  assert.deepEqual(await s.provider.propose(f.report), f.result);
  assert.deepEqual(s.reservations.map(r => r.phase), ['plan', 'report']);
});

test('two-source caller mutations during reservation cannot change second source or returned IDs', async () => {
  const f = fixture(); let release;
  const held = new Promise(resolve => { release = resolve; });
  const s = setup({ budget: { reserve: async () => held } });
  const input = structuredClone(f.plan), pending = s.provider.propose(input);
  input.approvedSources[1].quote.vendorId = 'evil.testnet';
  input.approvedJobInput.sourceRefs[1].quoteId = 'changed'; input.tools[0].approvedSources.reverse();
  release(true); assert.deepEqual(await pending, f.proposal);
  assert.deepEqual(JSON.parse(s.calls[0].body.messages[1].content), f.plan);
});

test('exact opt-in NEAR thinking512 profile is included before byte/token/currency reservation', async () => {
  const c = { ...configuration(), endpoint: 'https://cloud-api.near.ai/v1/chat/completions', model: 'z-ai/glm-5.3-flash' };
  const { provider, calls, reservations } = setup({ configuration: c, authorization: authorization(c), profile: 'near-ai-glm53-thinking512-v1' });
  await provider.propose(fixture().plan);
  assert.equal(calls[0].body.thinking_token_budget, 512);
  assert.equal(reservations[0].inputTokensUpperBound, Buffer.byteLength(JSON.stringify(calls[0].body)) + 1024);
  const generic = setup({ configuration: c, authorization: authorization(c) }); await generic.provider.propose(fixture().plan);
  assert.equal(Object.hasOwn(generic.calls[0].body, 'thinking_token_budget'), false);
  assert.deepEqual(calls[0].body, { ...generic.calls[0].body, thinking_token_budget: 512 });
  const reserved = reservations[0];
  const ceil = (n, rate) => (BigInt(n) * BigInt(rate) + 999999n) / 1000000n;
  assert.equal(reserved.reservedCostMicros, String(ceil(reserved.inputTokensUpperBound, '1000000') + ceil(2048, '2000000')));
  const limit = Buffer.byteLength(JSON.stringify(calls[0].body)) - 1;
  const limited = setup({ configuration: c, authorization: { ...authorization(c), maxPromptBytes: limit }, profile: 'near-ai-glm53-thinking512-v1' });
  await assert.rejects(limited.provider.propose(fixture().plan), e => e.code === 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(limited.calls.length, 0); assert.equal(limited.reservations.length, 0);
});
for (const [name, patch] of [
  ['unknown profile', { profile: 'near-ai-other' }],
  ['profile object', { profile: { thinking_token_budget: 512 } }],
  ['wrong model or endpoint', { profile: 'near-ai-glm53-thinking512-v1' }],
]) test(`profile rejects ${name} at construction`, () => {
  assert.throws(() => setup(patch), e => e.code === 'MODEL_PROVIDER_DECISION_REQUIRED');
});

test('TS1 report accepts both exact artifacts with bounded advisory indexes, once per whole job', async () => {
  const f = fixture(), { provider, calls, reservations } = setup();
  assert.deepEqual(await provider.propose(f.plan), f.proposal);
  assert.deepEqual(await provider.propose(f.report), f.result);
  assert.deepEqual(reservations.map(r => [r.jobId, r.phase]), [['job-1', 'plan'], ['job-1', 'report']]);
  assert.equal(calls.length, 2);
  const schema = calls[1].body.response_format.json_schema.schema;
  assert.deepEqual(schema.required, ['findings', 'interpretations']);
  assert.equal(schema.properties.interpretations.maxItems, 2);
  assert.deepEqual(schema.properties.findings.items.properties.artifactId.enum, f.report.evidence.map(e => e.artifactId));
  await assert.rejects(provider.propose(f.report), e => e.code === 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(calls.length, 2);
});

test('TS1 plan uses canonical shared sources, literal milliseconds and exact ordered quoteIds', async () => {
  const f = fixture(), { provider, calls, reservations } = setup();
  assert.ok(f.plan.approvedJobInput.quoteId.length > 64);
  assert.deepEqual(await provider.propose(f.plan), f.proposal);
  assert.equal(calls.length, 1); assert.equal(reservations.length, 1);
  assert.equal(reservations[0].phase, 'plan'); assert.equal(reservations[0].jobId, 'job-1');
  const sent = JSON.parse(calls[0].body.messages[1].content);
  assert.deepEqual(sent, f.plan);
  assert.equal(sent.approvedJobInput.expiresAt, '2026-11-13T18:00:00.123Z');
  assert.equal(calls[0].body.response_format.json_schema.schema.properties.tool.enum[0], 'requestquotes');
});

for (const [name, mutate] of [
  ['unknown variant', r => { r.approvedJobInput.schemaVersion = 'unknown'; }],
  ['null refs', r => { r.approvedJobInput.sourceRefs = null; }],
  ['missing refs', r => { delete r.approvedJobInput.sourceRefs; }],
  ['missing sources', r => { delete r.approvedSources; }],
  ['legacy mixed branch', r => { r.approvedQuote = r.approvedSources[0].quote; }],
  ['extra top key', r => { r.execute = true; }],
  ['extra source key', r => { r.approvedSources[1].secret = 'synthetic'; }],
  ['extra ref key', r => { r.approvedJobInput.sourceRefs[1].secret = 'synthetic'; }],
  ['extra quote key', r => { r.approvedSources[1].quote.secret = 'synthetic'; }],
  ['unknown source ID', r => { r.approvedSources[1].sourceId = 'unapproved'; }],
  ['reordered sources', r => { r.approvedSources.reverse(); }],
  ['reordered refs', r => { r.approvedJobInput.sourceRefs.reverse(); }],
  ['duplicate source', r => { r.approvedSources[1] = structuredClone(r.approvedSources[0]); }],
  ['missing source', r => { r.approvedSources.pop(); }],
  ['third source', r => { r.approvedSources.push(structuredClone(r.approvedSources[0])); }],
  ['duplicate refs', r => { r.approvedJobInput.sourceRefs[1].quoteId = r.approvedJobInput.quoteId; }],
  ['wrong primary alias', r => { r.approvedJobInput.quoteId = r.approvedJobInput.sourceRefs[1].quoteId; }],
  ['forged quote key', r => { r.approvedSources[1].quoteId = 'forged:key'; r.approvedJobInput.sourceRefs[1].quoteId = 'forged:key'; }],
  ['overlong key', r => { r.approvedJobInput.sourceRefs[1].quoteId = 'q'.repeat(2049); }],
  ['duplicate vendor', r => { r.approvedSources[1].quote.vendorId = r.approvedSources[0].quote.vendorId; }],
  ['reordered vendors', r => { r.approvedJobInput.vendorIds.reverse(); }],
  ['unused vendor', r => { r.approvedJobInput.vendorIds.push('unused.testnet'); }],
  ['duplicate order', r => { r.approvedSources[1].quote.orderId = r.approvedSources[0].quote.orderId; }],
  ['duplicate content', r => { r.approvedSources[1].quote.content = r.approvedSources[0].quote.content; }],
  ['changed second network', r => { r.approvedSources[1].quote.networkId = 'mainnet'; }],
  ['changed second mandate', r => { r.approvedSources[1].quote.mandateId = 'evil.testnet'; }],
  ['zero amount', r => { r.approvedSources[1].quote.amountAtomic = '0'; }],
  ['noncanonical amount', r => { r.approvedSources[1].quote.amountAtomic = '09'; }],
  ['sum over cap', r => { r.approvedJobInput.budgetAtomic = '16'; }],
  ['U128 amount overflow', r => { r.approvedSources[1].quote.amountAtomic = String(2n ** 128n); }],
  ['U128 sum overflow', r => { r.approvedJobInput.budgetAtomic = String(2n ** 128n - 1n); r.approvedSources[0].quote.amountAtomic = String(2n ** 128n - 1n); }],
  ['U128 cap overflow', r => { r.approvedJobInput.budgetAtomic = String(2n ** 128n); }],
  ['tool args altered', r => { r.tools[0].approvedSources[1].quote.amountAtomic = '7'; }],
  ['legacy tool', r => { r.tools[0].name = 'requestquote'; }],
  ['fractional UTC precision', r => { r.approvedJobInput.expiresAt = '2026-11-13T18:00:00.12Z'; }],
  ['UTC offset', r => { r.approvedJobInput.expiresAt = '2026-11-13T19:00:00+01:00'; }],
  ['invalid calendar', r => { r.approvedJobInput.expiresAt = '2026-11-31T18:00:00.123Z'; }],
  ['millisecond deadline reached', r => { r.approvedJobInput.expiresAt = '2026-11-13T12:00:00.000Z'; }],
  ['credential in source', r => { r.approvedSources[1].quote.content = configuration().apiKey; }],
  ['private key in source', r => { r.approvedSources[1].quote.content = '-----BEGIN PRIVATE KEY-----'; }],
  ['ed25519 key', r => { r.approvedJobInput.output = `ed25519:${'1'.repeat(64)}`; }],
]) test(`TS1 plan rejects ${name} before reservation or transport`, async () => {
  const { provider, calls, reservations } = setup(), r = fixture().plan;
  mutate(r);
  await assert.rejects(provider.propose(r), e => e.code === 'MODEL_INPUT_REJECTED' && e.message === e.code && !e.cause);
  assert.equal(calls.length, 0); assert.equal(reservations.length, 0);
});

for (const [name, mutate] of [
  ['no artifacts', r => { r.evidence = []; }],
  ['one artifact', r => { r.evidence.pop(); }],
  ['third artifact', r => { r.evidence.push(structuredClone(r.evidence[1])); }],
  ['sparse artifacts', r => { delete r.evidence[0]; }],
  ['swapped artifacts', r => { r.evidence.reverse(); }],
  ['duplicate artifact', r => { r.evidence[1] = structuredClone(r.evidence[0]); }],
  ['wrong artifact ID', r => { r.evidence[1].artifactId = 'fictional:forged'; }],
  ['oversize artifact ID', r => { r.evidence[1].artifactId = 'a'.repeat(2061); }],
  ['wrong vendor', r => { r.evidence[1].vendorId = 'evil.testnet'; }],
  ['duplicate order', r => { r.evidence[1].orderId = r.evidence[0].orderId; }],
  ['false fictional label', r => { r.evidence[1].fictionalSample = false; }],
  ['wrong qualification', r => { r.evidence[1].qualification = 'UNVERIFIED'; }],
  ['extra artifact field', r => { r.evidence[1].privateKey = 'synthetic'; }],
  ['wrong media type', r => { r.evidence[1].mediaType = 'application/json'; }],
  ['forged digest', r => { r.evidence[1].contentDigest = '0'.repeat(64); }],
  ['changed content', r => { r.evidence[1].content += ' changed'; }],
  ['oversize content', r => { r.evidence[1].content = 'x'.repeat(65537); }],
  ['report tools', r => { r.tools.push({ name: 'pay' }); }],
  ['credential in evidence', r => { const e = r.evidence[1]; e.content = configuration().apiKey; e.contentDigest = createHash('sha256').update(e.content).digest('hex'); }],
]) test(`TS1 report rejects ${name} before reservation or transport`, async () => {
  const { provider, calls, reservations } = setup(), r = fixture().report;
  mutate(r);
  await assert.rejects(provider.propose(r), e => e.code === 'MODEL_INPUT_REJECTED');
  assert.equal(calls.length, 0); assert.equal(reservations.length, 0);
});

for (const [name, mutate] of [
  ['reordered IDs', v => { v.arguments.quoteIds.reverse(); }],
  ['duplicated IDs', v => { v.arguments.quoteIds[1] = v.arguments.quoteIds[0]; }],
  ['forged ID', v => { v.arguments.quoteIds[1] = 'forged'; }],
  ['extra ID', v => { v.arguments.quoteIds.push('third'); }],
  ['extra argument', v => { v.arguments.amountAtomic = '1'; }],
  ['extra capability', v => { v.execute = true; }],
  ['wrong tool', v => { v.tool = 'pay'; }],
]) test(`TS1 plan output rejects ${name} and never retries`, async () => {
  const v = fixture().proposal; mutate(v);
  const { provider, calls, reservations } = setup({ output: () => v });
  await assert.rejects(provider.propose(fixture().plan), e => e.code === 'MODEL_OUTPUT_REJECTED');
  await assert.rejects(provider.propose(fixture().plan), e => e.code === 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(calls.length, 1); assert.equal(reservations.length, 1);
});

for (const [name, mutate] of [
  ['missing findings', v => { delete v.findings; }],
  ['no findings', v => { v.findings = []; }],
  ['single source coverage', v => { v.findings[1] = structuredClone(v.findings[0]); }],
  ['thirteen findings', v => { v.findings = Array.from({ length: 13 }, (_, i) => v.findings[i % 2]); }],
  ['fabricated artifact', v => { v.findings[1].artifactId = 'fictional:unpaid'; }],
  ['non-substring', v => { v.findings[1].excerpt = 'Supplier verified'; }],
  ['empty excerpt', v => { v.findings[1].excerpt = ''; }],
  ['overlong excerpt', v => { v.findings[1].excerpt = 'x'.repeat(4097); }],
  ['extra finding key', v => { v.findings[0].score = 100; }],
  ['free prose', v => { v.conclusion = 'Safe to sign'; }],
  ['missing interpretations', v => { delete v.interpretations; }],
  ['null interpretations', v => { v.interpretations = null; }],
  ['three interpretations', v => { v.interpretations.push(structuredClone(v.interpretations[0])); }],
  ['duplicate kind', v => { v.interpretations[1].kind = v.interpretations[0].kind; }],
  ['unknown kind', v => { v.interpretations[0].kind = 'SIGN_CONTRACT'; }],
  ['free prose interpretation', v => { v.interpretations[0] = 'Safe to sign'; }],
  ['extra interpretation key', v => { v.interpretations[0].text = 'Safe'; }],
  ['empty indexes', v => { v.interpretations[0].findingIndexes = []; }],
  ['duplicate indexes', v => { v.interpretations[1].findingIndexes = [0, 0, 1]; }],
  ['thirteen indexes', v => { v.interpretations[0].findingIndexes = Array.from({ length: 13 }, (_, i) => i); }],
  ['string index', v => { v.interpretations[0].findingIndexes = ['0']; }],
  ['fractional index', v => { v.interpretations[0].findingIndexes = [0.5]; }],
  ['negative index', v => { v.interpretations[0].findingIndexes = [-1]; }],
  ['null index', v => { v.interpretations[0].findingIndexes = [null]; }],
  ['out of range index', v => { v.interpretations[0].findingIndexes = [2]; }],
  ['single-source consistency', v => { v.interpretations[1].findingIndexes = [0]; }],
]) test(`TS1 report output rejects ${name} without re-inference`, async () => {
  const v = fixture().result; mutate(v);
  const { provider, calls, reservations } = setup({ output: () => v });
  await assert.rejects(provider.propose(fixture().report), e => e.code === 'MODEL_OUTPUT_REJECTED');
  await assert.rejects(provider.propose(fixture().report), e => e.code === 'MODEL_BUDGET_EXHAUSTED');
  assert.equal(calls.length, 1); assert.equal(reservations.length, 1);
});
