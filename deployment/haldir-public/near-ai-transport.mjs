import { Worker } from 'node:worker_threads';
import { NEAR_AI_ENDPOINT, NEAR_AI_MODEL } from './near-ai-policy.mjs';
const unavailable = () => Object.assign(new Error('NEAR_AI_UNAVAILABLE'), { code: 'NEAR_AI_UNAVAILABLE' });

// Constructor injection is trusted test context, never a request/configuration field.
export function runSdkWorker(input, signal, { timeoutMs = 20000, workerFactory } = {}) {
  if (signal?.aborted) return Promise.reject(unavailable());
  const deadline = performance.now() + Math.min(timeoutMs, 20000);
  const create = workerFactory ?? ((url, options) => new Worker(url, options));
  return new Promise((resolve, reject) => {
    let worker, timer, finishing = false;
    const finish = async (error, value) => {
      if (finishing) return; finishing = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { await worker?.terminate(); } catch { error = unavailable(); }
      if (error || signal?.aborted || performance.now() >= deadline) reject(unavailable()); else resolve(value);
    };
    const abort = () => { void finish(unavailable()); };
    try {
      worker = create(new URL('./near-ai-worker.mjs', import.meta.url), {
        workerData: input, env: {}, execArgv: [], stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
      });
      // Drain/discard diagnostics; raw SDK/native messages must not reach logs.
      worker.stdout?.resume(); worker.stderr?.resume();
      worker.once('message', message => { void finish(message?.ok === true ? null : unavailable(), message); });
      worker.on('error', () => { void finish(unavailable()); });
      worker.once('exit', () => { if (!finishing) void finish(unavailable()); });
      timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch { void finish(unavailable()); }
  });
}
export function createNearAiTransport({ apiKey, signal, run = runSdkWorker }) {
  let receipt = null, pending, active = false;
  return Object.freeze({
    getReceipt: () => structuredClone(receipt),
    drain: async () => { await pending?.catch(() => {}); },
    async transport(url, init) {
      if (active) throw unavailable();
      active = true;
      receipt = null;
      try {
        const body = JSON.parse(init.body);
        if (url !== NEAR_AI_ENDPOINT || init.method !== 'POST' || body.model !== NEAR_AI_MODEL ||
          body.stream !== false || body.thinking_token_budget !== 512) throw unavailable();
        const signals = [signal, init.signal].filter(s => s !== undefined);
        const combined = signals.length ? AbortSignal.any(signals) : undefined;
        if (combined?.aborted) throw unavailable();
        pending = Promise.resolve().then(() => run({ apiKey, body }, combined));
        const result = await pending;
        if (combined?.aborted || result?.ok !== true || result.receipt?.signatureKind !== 'provider_tee' ||
          result.receipt.model !== NEAR_AI_MODEL || result.receipt.e2ee !== true ||
          result.receipt.sdkVersion !== '0.3.0' || result.receipt.httpStatus !== 200) throw unavailable();
        receipt = structuredClone(result.receipt);
        return Response.json(result.envelope);
      } catch { receipt = null; throw unavailable(); }
      finally { active = false; }
    },
  });
}
