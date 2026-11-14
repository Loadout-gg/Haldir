import { createHash } from 'node:crypto';
import { createModelProvider } from '../src/agent/model-provider.mjs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const DELTA_BYTES = Buffer.byteLength(',"thinking_token_budget":512');
const CODES = new Set(['MODEL_PROVIDER_DECISION_REQUIRED', 'MODEL_INPUT_REJECTED', 'MODEL_RESPONSE_REJECTED',
  'MODEL_OUTPUT_REJECTED', 'MODEL_TIMEOUT', 'MODEL_TRANSPORT_FAILED', 'MODEL_BUDGET_EXHAUSTED',
  'MODEL_BUDGET_REJECTED', 'MODEL_AUTHORIZATION_EXPIRED', 'TRANSPORT_PROFILE_REQUIRED', 'TRANSPORT_PROFILE_REJECTED',
  'NEAR_AI_REASONING_BUDGET_REJECTED']);
const DEFAULT_ROOT = fileURLToPath(new URL('../.hermes/qualification/near-ai-model/', import.meta.url));

export const ENDPOINT = 'https://cloud-api.near.ai/v1/chat/completions';
export const MODEL = 'z-ai/glm-5.3-flash';
export const PROFILE = 'near-ai-glm53-thinking512-v1';
export const ATTEMPT = 'owner-approved-glm53flash-01';
export const TARIFF = Object.freeze({ source: 'https://near.ai/models/z-ai/glm-5.3-flash',
  observedAt: '2026-11-13T10:29:33Z', inputRateMicrosPerMillion: '80000', outputRateMicrosPerMillion: '500000' });
export const CONTENT = 'PUBLIC FICTIONAL TEST EVIDENCE ONLY. Example Lantern Print is an invented supplier. The fictional public registry sample lists status: sample-active. This is not supplier verification, payment evidence, or a real company record.';
const micros = (tokens, rate) => (BigInt(tokens) * BigInt(rate) + 999999n) / 1000000n;
export function fixture() {
  return { phase: 'report', approvedJobInput: { jobId: 'near-ai-qualification', ownerId: 'fictional.testnet',
    quoteId: 'fictional-quote', qualification: 'LOCAL_SYNTHETIC_ONLY', networkId: 'testnet',
    mandateId: 'fictional-mandate.testnet', purpose: 'Quote this explicitly fictional public test record only.',
    output: 'Exact evidence excerpts, no verification or conclusions.', budgetAtomic: '1',
    vendorIds: ['fictional-registry.testnet'], expiresAt: '2026-11-13T00:00:00Z' },
  evidence: [{ artifactId: 'fictional:near-ai-qualification', orderId: 'fictional-order',
    vendorId: 'fictional-registry.testnet', fictionalSample: true, qualification: 'LOCAL_SYNTHETIC_ONLY',
    mediaType: 'text/plain', content: CONTENT, contentDigest: createHash('sha256').update(CONTENT).digest('hex') }], tools: [] };
}
function authorization(now) {
  return { authorizationId: ATTEMPT, endpoint: ENDPOINT, model: MODEL, credentialSource: 'application-runtime',
    billingApproved: true, dataApproved: true, expiresAt: new Date(now + 120000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    maxCalls: 1, maxPromptBytes: 16384, maxCompletionTokens: 2048, maxTotalTokens: 24576, timeoutMs: 60000,
    inputRateMicrosPerMillion: TARIFF.inputRateMicrosPerMillion, outputRateMicrosPerMillion: TARIFF.outputRateMicrosPerMillion,
    maxCostMicros: '50000' };
}
const fail = code => { throw Object.assign(new Error(code), { code }); };
/**
 * Exact, qualification-only transport proposal, activated only by explicit profile acceptance.
 * @typedef {{model: string, messages: object[], tools: [], tool_choice: 'none', parallel_tool_calls: false,
 * stream: false, store: false, n: 1, max_completion_tokens: 2048, response_format: object}} AdapterBody
 * @typedef {AdapterBody & {thinking_token_budget: 512}} NearAIThinking512Body
 * No field renames/removals, no response rewriting, no change to adapter/runner validation.
 */
export function applyProfile(url, init, profile) {
  if (profile !== PROFILE) fail('TRANSPORT_PROFILE_REQUIRED');
  let body;
  try { body = JSON.parse(init.body); } catch { fail('TRANSPORT_PROFILE_REJECTED'); }
  if (url !== ENDPOINT || init.method !== 'POST' || init.redirect !== 'error' || init.credentials !== 'omit' ||
    Object.keys(body).sort().join(' ') !== 'max_completion_tokens messages model n parallel_tool_calls response_format store stream tool_choice tools' ||
    body.model !== MODEL || body.max_completion_tokens !== 2048 || body.n !== 1 || body.store !== false || body.stream !== false ||
    body.tool_choice !== 'none' || body.parallel_tool_calls !== false || !Array.isArray(body.tools) || body.tools.length ||
    !Array.isArray(body.messages) || body.response_format?.type !== 'json_schema') fail('TRANSPORT_PROFILE_REJECTED');
  const next = { ...init, body: JSON.stringify({ ...body, thinking_token_budget: 512 }) };
  if (Buffer.byteLength(next.body) > 16384) fail('TRANSPORT_PROFILE_REJECTED');
  return next;
}
async function durableJSON(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}
async function syncDir(path) { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
function safeRecord(value, key) {
  if (typeof value === 'string') return value.replaceAll(key, '[REDACTED]');
  if (Array.isArray(value)) return value.map(v => safeRecord(v, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replaceAll(key, '[REDACTED]'), safeRecord(v, key)]));
  return value;
}
function safeId(value, key) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) &&
    !value.includes(key) && !/bearer|authorization/i.test(value) ? value : null;
}
function captureEnvelope(envelope, meta, key) {
  // Positive field allowlist only: never copy raw envelope, content, errors, refusal prose or reasoning.
  meta.observedModel = envelope?.model === MODEL && !MODEL.includes(key) ? MODEL : null;
  const reason = envelope?.choices?.[0]?.finish_reason;
  meta.finishReason = ['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(reason) ? reason : null;
  meta.responseId = safeId(envelope?.id, key);
  const u = envelope?.usage;
  if (u && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(k => Number.isSafeInteger(u[k]) && u[k] >= 0 && u[k] <= 1048576) &&
    u.total_tokens === u.prompt_tokens + u.completion_tokens) {
    meta.usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens };
    const reasoning = u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens;
    if (Number.isSafeInteger(reasoning) && reasoning >= 0 && reasoning <= u.completion_tokens) meta.usage.reasoning_tokens = reasoning;
  }
  if (envelope?.choices?.[0]?.message?.refusal != null) meta.providerRefusalCode = 'ASSISTANT_REFUSAL';
  else if (reason === 'content_filter') meta.providerRefusalCode = 'CONTENT_FILTER';
  else if (reason === 'length') meta.providerRefusalCode = 'OUTPUT_TRUNCATED';
  else if (envelope?.model !== MODEL) meta.providerRefusalCode = 'MODEL_IDENTITY_MISMATCH';
}
function observeResponse(response, meta, key) {
  meta.httpStatus = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
  meta.requestId = safeId(response?.headers?.get('x-request-id'), key) ?? safeId(response?.headers?.get('request-id'), key);
  if (response?.status !== 200) { meta.providerRefusalCode = `HTTP_${meta.httpStatus ?? 'UNKNOWN'}`; return response; }
  if (!response.body?.getReader) return response;
  const reader = response.body.getReader(); let bytes = 0, chunks = [];
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          if (bytes <= 131072) {
            try { captureEnvelope(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), meta, key); } catch { /* metadata unavailable */ }
          }
          chunks = []; controller.close(); reader.releaseLock(); return;
        }
        bytes += item.value.byteLength;
        if (bytes <= 131072) chunks.push(Buffer.from(item.value)); else chunks = [];
        controller.enqueue(item.value);
      } catch { chunks = []; controller.error(new Error('SANITIZED_BODY_READ_FAILURE')); }
    },
    async cancel() { chunks = []; try { await reader.cancel(); } catch { /* never expose remote error */ } },
  }, { highWaterMark: 0 });
  // Preserve the actual status/redirect/header semantics; forward original bytes unchanged.
  return { status: response.status, redirected: response.redirected, headers: response.headers, body };
}
/** Dependency-injected offline seam. No default transport, credentials or credential lookup.
 * Live CLI alone selects native fetch, the fixed persistent root and dedicated env name.
 */
export async function executeAttempt({ root = DEFAULT_ROOT, profile, env = {}, transport, mode = 'synthetic', now = Date.now } = {}) {
  const started = performance.now();
  const meta = { observedModel: null, finishReason: null, usage: null, requestId: null, responseId: null, httpStatus: null, providerRefusalCode: null };
  const result = { status: 'BLOCKED_NO_HTTP', mode, attempt: ATTEMPT, model: MODEL, endpoint: ENDPOINT,
    transportProfile: PROFILE, maxCompletionTokens: 2048, thinkingTokenBudget: 512, timeoutMs: 60000,
    maxCostMicros: '50000', tariff: TARIFF, reservedCostMicros: null, elapsedMs: 0, ...meta,
    validExcerpt: null, refusalCode: null };
  let key;
  const done = () => { const value = { ...result, ...meta, elapsedMs: Math.max(0, Math.round(performance.now() - started)) }; return typeof key === 'string' && key.length ? safeRecord(value, key) : value; };
  if (profile !== PROFILE) { result.refusalCode = 'TRANSPORT_PROFILE_REQUIRED'; return done(); }
  if (typeof transport !== 'function' || !['live', 'synthetic'].includes(mode)) { result.refusalCode = 'TRANSPORT_REQUIRED'; return done(); }
  key = env.HALDIR_NEAR_AI_API_KEY;
  if (typeof key !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(key)) { result.refusalCode = 'DEDICATED_APPLICATION_KEY_REQUIRED'; return done(); }
  // Fail before any filesystem/HTTP action if a key collides with fixed public receipt/input text.
  // No key-derived identifier, fingerprint or hash is generated.
  if (JSON.stringify([result, authorization(now()), fixture()]).includes(key)) {
    return JSON.parse(JSON.stringify({ status: 'BLOCKED_NO_HTTP', refusalCode: 'SECRET_COLLISION' }).replaceAll(key, '[REDACTED]'));
  }
  let reserved = false;
  const attemptDir = join(root, ATTEMPT);
  let provider;
  try {
    provider = createModelProvider({ configuration: { protocol: 'chat-completions', endpoint: ENDPOINT, model: MODEL, apiKey: key },
      authorization: authorization(now()), now,
      budget: { async reserve(intent) {
        const effectiveInputTokensUpperBound = intent.inputTokensUpperBound + DELTA_BYTES;
        const reservedCostMicros = String(micros(effectiveInputTokensUpperBound, TARIFF.inputRateMicrosPerMillion) + micros(2048, TARIFF.outputRateMicrosPerMillion));
        if (BigInt(reservedCostMicros) > 50000n || effectiveInputTokensUpperBound + 2048 > 24576) return false;
        await mkdir(root, { recursive: true, mode: 0o700 });
        try { await mkdir(attemptDir, { mode: 0o700 }); }
        catch (error) { if (error?.code === 'EEXIST') { result.refusalCode = 'ATTEMPT_ALREADY_RESERVED'; return false; } throw error; }
        // The directory itself is a permanent replay tombstone even if a later write/sync fails.
        await syncDir(root);
        await durableJSON(join(attemptDir, 'reservation.json'), safeRecord({ status: 'RESERVED_OUTCOME_UNKNOWN', attempt: ATTEMPT, mode,
          ...intent, maxCostMicros: '50000', transportProfile: PROFILE, thinkingTokenBudget: 512,
          deltaPromptBytes: DELTA_BYTES, effectiveInputTokensUpperBound, effectiveReservedTokens: effectiveInputTokensUpperBound + 2048,
          reservedCostMicros, tariff: TARIFF, maxCalls: 1, maxPromptBytes: 16384, timeoutMs: 60000 }, key));
        await syncDir(attemptDir);
        result.reservedCostMicros = reservedCostMicros; reserved = true;
        return true;
      } },
      transport: async (url, init) => {
        if (!reserved) fail('MODEL_BUDGET_REJECTED');
        const next = applyProfile(url, init, profile);
        const response = await transport(url, next);
        return observeResponse(response, meta, key);
      },
    });
    const proposal = await provider.propose(fixture());
    if (meta.usage?.reasoning_tokens > 512) fail('NEAR_AI_REASONING_BUDGET_REJECTED');
    // Adapter validation is the authority, not this observer. Only a proven public fixture excerpt is retained.
    const excerpt = proposal.findings[0].excerpt;
    if (!CONTENT.includes(excerpt) || excerpt.includes(key)) fail('MODEL_OUTPUT_REJECTED');
    result.validExcerpt = excerpt;
    result.status = mode === 'live' ? 'LIVE_ADAPTER_PASS' : 'SYNTHETIC_PASS_NOT_LIVE';
  } catch (error) {
    result.refusalCode ??= CODES.has(error?.code) ? error.code : 'QUALIFICATION_INTERNAL_FAILURE';
    if (reserved) result.status = 'ATTEMPT_FAILED_OR_UNKNOWN_NO_RETRY';
  }
  const receipt = done();
  if (reserved) {
    try { await durableJSON(join(attemptDir, 'receipt.json'), receipt); await syncDir(attemptDir); }
    catch { return safeRecord({ ...receipt, status: 'RECEIPT_PERSISTENCE_FAILED_NO_RETRY', refusalCode: 'RECEIPT_PERSISTENCE_FAILED' }, key); }
  }
  return receipt;
}
export async function cli(args = [], { env = process.env, transport = globalThis.fetch, root = DEFAULT_ROOT, now = Date.now } = {}) {
  const blocked = refusalCode => ({ status: 'BLOCKED_NO_HTTP', refusalCode, model: MODEL });
  if (args.length === 0 || (args.length === 1 && ['--preflight', '--offline'].includes(args[0]))) return preflight();
  const allowed = new Set(['--live', '--accept-transport-profile', '--confirm-usd-ceiling', '--confirm-public-fictional-data', '--tariff-confirmed']);
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!allowed.has(name) || flags.has(name)) return blocked('CLI_ARGUMENTS_REJECTED');
    if (name === '--live' || name === '--confirm-public-fictional-data') flags.set(name, true);
    else { const value = args[++i]; if (!value || value.startsWith('--')) return blocked('CLI_ARGUMENTS_REJECTED'); flags.set(name, value); }
  }
  if (flags.size !== 5 || flags.get('--live') !== true || flags.get('--accept-transport-profile') !== PROFILE ||
    flags.get('--confirm-usd-ceiling') !== '0.05' || flags.get('--confirm-public-fictional-data') !== true) return blocked('EXPLICIT_LIVE_BOUNDS_REQUIRED');
  const observed = now(), tariffTime = Date.parse(TARIFF.observedAt);
  if (flags.get('--tariff-confirmed') !== TARIFF.observedAt.slice(0, 10) || !Number.isFinite(observed) ||
    observed < tariffTime || observed - tariffTime > 86400000) return blocked('TARIFF_RECONFIRMATION_REQUIRED');
  return executeAttempt({ env, transport, root, profile: PROFILE, mode: 'live', now });
}
export async function preflight() {
  let count = 0, intent;
  const provider = createModelProvider({ configuration: { protocol: 'chat-completions', endpoint: ENDPOINT,
    model: MODEL, apiKey: 'synthetic-offline-key-not-real' }, authorization: authorization(Date.now()),
    budget: { reserve: async value => { intent = value; return true; } }, transport: async (url, init) => {
      const next = applyProfile(url, init, PROFILE);
      if (JSON.parse(next.body).thinking_token_budget !== 512) fail('TRANSPORT_PROFILE_REJECTED');
      count++;
      return new Response(JSON.stringify({ model: MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: JSON.stringify({ findings: [{ artifactId: fixture().evidence[0].artifactId, excerpt: 'PUBLIC FICTIONAL TEST EVIDENCE ONLY.' }] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }), { headers: { 'content-type': 'application/json' } });
    } });
  await provider.propose(fixture());
  return { status: 'OFFLINE_PASS_LIVE_NOT_RUN', model: MODEL, syntheticAdapterCalls: count,
    reservedCostMicros: String(micros(intent.inputTokensUpperBound + DELTA_BYTES, TARIFF.inputRateMicrosPerMillion) + micros(2048, TARIFF.outputRateMicrosPerMillion)),
    endpoint: ENDPOINT, tariff: TARIFF, maxCostMicros: '50000', timeoutMs: 60000, maxCompletionTokens: 2048,
    effectiveInputTokensUpperBound: intent.inputTokensUpperBound + DELTA_BYTES,
    transportProposal: { profile: PROFILE, delta: { thinking_token_budget: 512 }, addedPromptBytes: DELTA_BYTES,
      acceptance: 'REQUIRES_EXPLICIT_LIVE_FLAG', responseValidation: 'UNCHANGED' },
    remainingGate: 'Parent must supply dedicated application key and explicitly accept bounded transport profile; live compatibility NOT_RUN.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await cli(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = ['OFFLINE_PASS_LIVE_NOT_RUN', 'LIVE_ADAPTER_PASS'].includes(result.status) ? 0 : 1;
  } catch {
    process.stdout.write('{"status":"BLOCKED_NO_HTTP_OR_OUTCOME_UNKNOWN","refusalCode":"QUALIFICATION_INTERNAL_FAILURE"}\n');
    process.exitCode = 1;
  }
}
