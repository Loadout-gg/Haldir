import { createServer } from 'node:http';
import { createWalletSessions, WalletSessionError } from './wallet-session.mjs';

const cookieName = '__Host-haldir_session';
const cookie = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
const routes = Object.freeze({
  '/api/wallet-auth/challenge': ['accountId', 'networkId'],
  '/api/wallet-auth/verify': ['accountId', 'networkId', 'challengeId', 'publicKey', 'signature'],
  '/api/wallet-auth/session': [],
  '/api/wallet-auth/logout': [],
});
class HttpError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
const demand = (ok, code, status = 400) => { if (!ok) throw new HttpError(code, status); };
function headerCount(req, name) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
  return count;
}
function sessionToken(req) {
  if (headerCount(req, 'cookie') !== 1) return undefined;
  const candidates = req.headers.cookie.split(';').map(p => p.trim()).filter(p => p.startsWith(`${cookieName}=`));
  if (candidates.length !== 1) return undefined;
  const value = candidates[0].slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value ? value : undefined;
}
// Flat string-valued objects only. JSON.parse establishes grammar/UTF-8;
// token scanning also rejects duplicate (including escaped) property names.
function exactBody(bytes, keys) {
  let body, text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); body = JSON.parse(text); }
  catch { throw new HttpError('INVALID_JSON', 400); }
  demand(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === keys.length &&
    keys.every(k => Object.hasOwn(body, k) && typeof body[k] === 'string'), 'INVALID_BODY');
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[^\s]/g);
  demand(tokens?.[0] === '{' && tokens.at(-1) === '}', 'INVALID_BODY');
  const seen = new Set();
  for (let i = 1; i < tokens.length - 1;) {
    const key = JSON.parse(tokens[i++]);
    demand(typeof key === 'string' && !seen.has(key) && tokens[i++] === ':', 'INVALID_BODY');
    seen.add(key);
    demand(typeof JSON.parse(tokens[i++]) === 'string', 'INVALID_BODY');
    if (i < tokens.length - 1) demand(tokens[i++] === ',', 'INVALID_BODY');
  }
  demand(seen.size === keys.length, 'INVALID_BODY');
  return body;
}
function readBody(req, timeoutMs) {
  demand(headerCount(req, 'content-type') === 1 &&
    /^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') &&
    !headerCount(req, 'content-encoding'), 'JSON_REQUIRED', 415);
  demand(!req.headers['content-length'] || Number(req.headers['content-length']) <= 4096, 'BODY_TOO_LARGE', 413);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (error, value) => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', aborted); req.off('aborted', aborted);
      if (error) { req.pause(); reject(error); } else resolve(value);
    };
    const data = chunk => {
      size += chunk.length;
      if (size > 4096) return finish(new HttpError('BODY_TOO_LARGE', 413));
      chunks.push(chunk);
    };
    const end = () => finish(null, Buffer.concat(chunks));
    const aborted = () => finish(new HttpError('INVALID_BODY', 400));
    const timer = setTimeout(() => finish(new HttpError('BODY_TIMEOUT', 408)), timeoutMs);
    req.on('data', data); req.on('end', end); req.on('error', aborted); req.on('aborted', aborted);
  });
}

/**
 * REAL authentication adapter composed with the unchanged wallet-session service.
 * No app fallback, ambient config, automatic listen, financial API or revocation
 * route. Factory does not start any transport. handle(req,res) is terminal (404
 * for every other route); it must NOT fall through to createLocalApp/testOnlySession.
 *
 * All four routes are POST JSON with exact flat bodies, exact approved HTTPS
 * Origin/Host and X-Haldir-CSRF: 1. Sec-Fetch-Site, when supplied, must be
 * same-origin. No CORS, redirects, URL normalization or forwarded-header trust.
 * Login token is cookie-only, never JSON. Secure stays enabled on loopback;
 * the local HTTP harness explicitly relays it, not a browser cookie simulation.
 *
 * listen() is LOOPBACK qualification only; public activation/TLS/browser wiring
 * remain separate approval gates. A future HTTPS server may mount handle as-is
 * with the approved authority, without enabling synthetic session fallback.
 */
export function createWalletAuthHttp({ repository, approvedOrigin, approvedRecipient,
  trustedAccessKeyReader, now = Date.now, random, challengeTtlMs, sessionTtlMs,
  keyMaxAgeMs, bodyTimeoutMs = 2_000 } = {}) {
  const service = createWalletSessions({ repository, approvedOrigin, approvedRecipient,
    trustedAccessKeyReader, now, random, challengeTtlMs, sessionTtlMs, keyMaxAgeMs });
  demand(Number.isSafeInteger(bodyTimeoutMs) && bodyTimeoutMs > 0 && bodyTimeoutMs <= 10_000, 'INVALID_CONFIG');
  const approvedHost = new URL(approvedOrigin).host;
  const handle = async (req, res) => {
    const send = (status, body, headers = {}) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', connection: 'close', ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      demand(headerCount(req, 'origin') === 1 && req.headers.origin === approvedOrigin &&
        headerCount(req, 'host') === 1 && req.headers.host === approvedHost &&
        headerCount(req, 'x-haldir-csrf') === 1 && req.headers['x-haldir-csrf'] === '1' &&
        (headerCount(req, 'sec-fetch-site') === 0 || (headerCount(req, 'sec-fetch-site') === 1 &&
          req.headers['sec-fetch-site'] === 'same-origin')), 'ORIGIN_CSRF_REQUIRED', 403);
      demand(req.method === 'POST' && Object.hasOwn(routes, req.url), 'NOT_FOUND', 404);
      const body = exactBody(await readBody(req, bodyTimeoutMs), routes[req.url]);
      const context = { origin: approvedOrigin, networkId: 'testnet' };
      if (req.url === '/api/wallet-auth/challenge') return send(200, await service.issueChallenge({ ...body, origin: approvedOrigin }));
      if (req.url === '/api/wallet-auth/verify') {
        const result = await service.verifyChallenge({ ...body, origin: approvedOrigin });
        const observedAt = now();
        demand(Number.isSafeInteger(observedAt) && observedAt >= 0 && observedAt < result.expiresAt, 'UNAUTHENTICATED', 401);
        return send(200, { principal: result.principal }, { 'set-cookie': cookie(result.token,
          Math.floor((result.expiresAt - observedAt) / 1000)) });
      }
      const token = sessionToken(req);
      if (req.url === '/api/wallet-auth/session') return send(200, { principal: await service.authenticate({ ...context, token }) });
      await service.logout({ ...context, token });
      return send(200, { loggedOut: true }, { 'set-cookie': cookie('', 0) });
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, { error: error.code });
      if (error instanceof WalletSessionError) return send(401, { error: 'UNAUTHENTICATED' });
      return send(500, { error: 'INTERNAL_ERROR' });
    }
  };
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, handle);
  let starting = false;
  return Object.freeze({ handle,
    async listen({ host = '127.0.0.1', port = 0 } = {}) {
      demand(host === '127.0.0.1' || host === '::1', 'LOOPBACK_ONLY', 403);
      demand(Number.isSafeInteger(port) && port >= 0 && port <= 65535, 'INVALID_PORT');
      demand(!server.listening && !starting, 'ALREADY_LISTENING');
      starting = true;
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen({ host, port, exclusive: true }, () => { server.off('error', reject); resolve(); });
        });
        return { origin: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}` };
      } finally { starting = false; }
    },
    async close() {
      if (server.listening) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    },
  });
}
