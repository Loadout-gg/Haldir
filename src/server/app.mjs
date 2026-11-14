import { createServer } from 'node:http';
import { JourneyError } from './orders.mjs';

const demand = (condition, code, status = 400) => { if (!condition) throw new JourneyError(code, status); };
const token = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s);
function bodyShape(body, keys) {
  demand(body && typeof body === 'object' && !Array.isArray(body) &&
    Object.keys(body).sort().join(' ') === [...keys].sort().join(' '), 'INVALID_BODY');
}
async function jsonBody(req) {
  demand(/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? ''), 'JSON_REQUIRED', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    demand(size <= 64 * 1024, 'BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new JourneyError('INVALID_JSON', 400); }
}

/**
 * LOOPBACK LOCAL TEST ONLY. No automatic startup or ambient configuration.
 * testOnlySession(req) -> synthetic owner ID|null is injected by a local harness;
 * it is deliberately NOT wallet authentication and must never be exposed online.
 * trustedApprovalLookup({ownerId, approvalId}) -> independently reviewed snapshot
 * or null. Neither browser terms nor browser payment evidence are accepted.
 * All adapter operations are awaited; no detached/background work/polling.
 */
export function createLocalApp({ localTestOnly, orders, testOnlySession, trustedApprovalLookup } = {}) {
  demand(localTestOnly === true, 'LOCAL_TEST_ONLY', 503);
  demand(typeof testOnlySession === 'function', 'TEST_SESSION_REQUIRED', 503);
  demand(typeof trustedApprovalLookup === 'function', 'TRUSTED_APPROVAL_LOOKUP_REQUIRED', 503);
  let origin;
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, async (req, res) => {
    function send(status, body) {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    }
    try {
      demand(req.headers.host === new URL(origin).host, 'LOCAL_ORIGIN_REQUIRED', 403);
      demand(!req.headers.origin || req.headers.origin === origin, 'LOCAL_ORIGIN_REQUIRED', 403);
      const ownerId = await testOnlySession(req);
      demand(typeof ownerId === 'string' && ownerId.length > 0, 'UNAUTHENTICATED', 401);
      const url = new URL(req.url, origin);
      demand(!url.search && !url.hash, 'NOT_FOUND', 404);
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const body = await jsonBody(req);
        bodyShape(body, ['approvalId', 'admissionKey']);
        demand(token(body.approvalId) && token(body.admissionKey), 'INVALID_BODY');
        const approved = await trustedApprovalLookup({ ownerId, approvalId: body.approvalId });
        demand(approved, 'APPROVAL_NOT_AVAILABLE', 403);
        return send(201, await orders.createJob({ ownerId, admissionKey: body.admissionKey, approved }));
      }
      const route = /^\/api\/jobs\/([a-zA-Z0-9_-]{1,64})(?:\/(order)(?:\/(check|delivery))?)?$/.exec(url.pathname);
      demand(route, 'NOT_FOUND', 404);
      const jobId = route[1];
      if (req.method === 'GET' && !route[3]) {
        return send(200, await (route[2] ? orders.getOrder({ ownerId, jobId }) : orders.getJob({ ownerId, jobId })));
      }
      demand(req.method === 'POST' && route[3], 'NOT_FOUND', 404);
      bodyShape(await jsonBody(req), []);
      const result = route[3] === 'check' ? await orders.checkPayment({ ownerId, jobId }) :
        await orders.retrieveDelivery({ ownerId, jobId });
      send(200, result);
    } catch (error) {
      send(error instanceof JourneyError ? error.status : 500,
        { error: error instanceof JourneyError ? error.code : 'LOCAL_INTERNAL_ERROR', qualification: 'LOCAL_SYNTHETIC_ONLY' });
    }
  });
  return {
    async listen({ host = '127.0.0.1', port = 0 } = {}) {
      demand(host === '127.0.0.1' || host === '::1', 'LOOPBACK_ONLY', 403);
      demand(Number.isInteger(port) && port >= 0 && port <= 65535, 'INVALID_PORT');
      demand(!server.listening, 'ALREADY_LISTENING');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host, port, exclusive: true }, () => { server.off('error', reject); resolve(); });
      });
      origin = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
      return { origin, qualification: 'LOCAL_SYNTHETIC_ONLY' };
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
