import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { NEAR_AI_ENDPOINT, NEAR_AI_MODEL } from './near-ai-policy.mjs';
const unavailable = () => Object.assign(new Error('NEAR_AI_UNAVAILABLE'), { code: 'NEAR_AI_UNAVAILABLE' });
const demand = ok => { if (!ok) throw unavailable(); };
// Compare actual string leaves, not a differently escaped JSON representation.
const containsCredential = (value, key) => typeof key === 'string' && key.length > 0 &&
  (typeof value === 'string' ? value.includes(key) : value && typeof value === 'object'
    ? Object.entries(value).some(([name, child]) => name.includes(key) || containsCredential(child, key)) : false);


async function installedRuntime(options) {
  const sdk = await import('@nearai/inference-sdk/node');
  const entry = createRequire(import.meta.url).resolve('@nearai/inference-sdk/node');
  const metadata = JSON.parse(await readFile(new URL('../package.json', pathToFileURL(entry)), 'utf8'));
  demand(metadata.name === '@nearai/inference-sdk' && metadata.version === '0.3.0');
  return { client: new sdk.InferenceClient(options), sdkVersion: metadata.version,
    getSdkError: sdk.getSdkError, pause };
}

export async function verifiedCompletion({ apiKey, body }, makeRuntime = installedRuntime) {
  let client;
  try {
    // Official Chat Completions precedence; preserve the caller's exact body.
    const completionLimit = body?.max_completion_tokens ?? body?.max_tokens;
    demand(body?.model === NEAR_AI_MODEL && body.stream === false && body.thinking_token_budget === 512 &&
      Number.isSafeInteger(completionLimit) && completionLimit > 0 && completionLimit <= 2048);
    const runtime = await makeRuntime({ baseUrl: 'https://cloud-api.near.ai/v1', apiKey, e2ee: true });
    client = runtime.client;
    const { sdkVersion, getSdkError, pause: wait } = runtime;
    demand(sdkVersion === '0.3.0');
    const response = await client.fetch(NEAR_AI_ENDPOINT, {
      method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    demand(response.status === 200 && !response.redirected &&
      /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''));
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; demand(size <= 131072); chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    demand(typeof envelope.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(envelope.id));
    demand(envelope.model === NEAR_AI_MODEL);
    let verified, signatureLookups = 0;
    const delays = [250, 500, 1000];
    for (;;) {
      signatureLookups++;
      try { verified = await client.verifyResponse(envelope.id); break; }
      catch (error) {
        const cause = getSdkError(error);
        const retryableLookup = cause?.name === 'ApiError' &&
          (cause.failure?.code === 'api.completion_signature_unavailable' || cause.retryable === true);
        if (!retryableLookup || signatureLookups > delays.length) throw error;
        await wait(delays[signatureLookups - 1]);
      }
    }
    demand(verified.id === envelope.id && verified.signatureKind === 'provider_tee');
    const choices = envelope.choices?.map(c => ({ finish_reason: c.finish_reason,
      message: { role: c.message?.role, content: c.message?.content,
        tool_calls: c.message?.tool_calls, function_call: c.message?.function_call,
        refusal: c.message?.refusal } }));
    const u = envelope.usage;
    demand([u?.prompt_tokens, u?.completion_tokens, u?.total_tokens].every(n => Number.isSafeInteger(n) && n >= 0));
    demand(u.total_tokens === u.prompt_tokens + u.completion_tokens &&
      u.completion_tokens <= completionLimit && u.total_tokens <= 210000);
    const reasoning = u.completion_tokens_details?.reasoning_tokens;
    demand(reasoning === undefined || (Number.isSafeInteger(reasoning) && reasoning >= 0 && reasoning <= u.completion_tokens));
    const usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens };
    const inference = response.headers.get('inference-id');
    const receipt = { provider: 'near-ai-cloud', model: envelope.model, sdkVersion,
      httpStatus: response.status, id: envelope.id, completionId: envelope.id, signatureKind: verified.signatureKind,
      signatureLookups, e2ee: true, usage, reasoningTokens: reasoning ?? null,
      reasoningBudgetExceeded: reasoning !== undefined && reasoning > body.thinking_token_budget,
      inferenceId: typeof inference === 'string' && /^[a-f0-9-]{36}$/i.test(inference) ? inference : null };
    const result = { envelope: { id: envelope.id, model: envelope.model, choices, usage }, receipt };
    demand(typeof apiKey === 'string' && apiKey.length > 0 &&
      !JSON.stringify(result).includes(JSON.stringify(apiKey).slice(1, -1)) && !containsCredential(result, apiKey));
    // Completion content is itself JSON text. Inspect that one parsed proposal
    // layer too; generic adapter validation still owns its exact output schema.
    for (const choice of choices ?? []) {
      let proposed;
      try { proposed = JSON.parse(choice.message?.content); } catch { continue; }
      demand(!containsCredential(proposed, apiKey));
    }
    return result;
  } catch { throw unavailable(); }
  finally {
    try { client?.clearResponseCache(); } catch { throw unavailable(); }
  }
}

if (!isMainThread) {
  try { parentPort.postMessage({ ok: true, ...await verifiedCompletion(workerData) }); }
  catch { parentPort.postMessage({ ok: false }); }
  finally { parentPort.close(); }
}
