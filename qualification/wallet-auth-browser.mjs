// LOCAL qualification composition only. No public RPC, wallet prompts, financial
// routes or auth fallback. HTTPS requires caller-supplied ALREADY browser-trusted
// TLS material. HTTP probe deliberately preserves the HTTPS-origin mismatch.
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletAuthHttp } from '../src/server/wallet-auth-http.mjs';
import { openLocalRepository } from '../src/server/orders.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ttf': 'font/ttf' };

export async function startWalletAuthBrowser({ tls, httpProbe = false, trustedAccessKeyReader, extraAssets = {} } = {}) {
  if ((!tls?.key || !tls?.cert) && !httpProbe) throw new Error('BROWSER_TRUSTED_LOCAL_TLS_REQUIRED');
  if (httpProbe && tls) throw new Error('SELECT_HTTPS_OR_HTTP_PROBE');
  if (typeof trustedAccessKeyReader !== 'function') throw new Error('EXPLICIT_TRUSTED_READER_REQUIRED');
  const dist = await realpath(resolve(root, 'prototype/dist'));
  await readFile(resolve(dist, 'index.html'));
  const repository = openLocalRepository({ localTestOnly: true, filename: ':memory:' });
  let auth, origin;
  const receipts = [];
  const handler = (req, res) => {
    const fail = status => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: 'LOCAL_QUALIFICATION_REJECTED' })); };
    const run = async () => {
      if (!origin || req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return fail(403);
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) return fail(404);
      if (req.url.startsWith('/api/')) {
        res.once('finish', () => receipts.push({ route: req.url, method: req.method, status: res.statusCode }));
        // Exact unchanged handler: no Origin/Host rewriting, no cookie relay,
        // no testOnlySession, no fall-through after an auth rejection.
        return auth.handle(req, res);
      }
      if (req.method !== 'GET') return fail(404);
      const url = new URL(req.url, origin);
      if (url.pathname === '/qualification/cookie-policy') {
        // Marker only, NOT an authentication cookie or alternate login route.
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': '__Host-haldir_policy_probe=marker; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60' });
        return res.end(JSON.stringify({ qualification: 'COOKIE_POLICY_MARKER_ONLY' }));
      }
      if (Object.hasOwn(extraAssets, url.pathname)) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(extraAssets[url.pathname]);
      }
      if (url.pathname !== '/' && url.pathname !== '/index.html' && !/^\/(assets|fonts)\//.test(url.pathname)) return fail(404);
      try {
        const path = await realpath(resolve(dist, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1)));
        if (!path.startsWith(dist + sep)) return fail(404);
        const bytes = await readFile(path);
        res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(bytes);
      } catch { return fail(404); }
    };
    void run().catch(() => { if (!res.headersSent) fail(500); else res.destroy(); });
  };
  const server = httpProbe ? httpServer(handler) : httpsServer(tls, handler);
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.off('error', reject); done(); }); });
    const port = server.address().port;
    origin = `${httpProbe ? 'http' : 'https'}://localhost:${port}`;
    auth = createWalletAuthHttp({ repository, approvedOrigin: `https://localhost:${port}`, approvedRecipient: 'localhost', trustedAccessKeyReader });
  } catch (error) { server.closeAllConnections(); await new Promise(done => server.close(done)); repository.close(); throw error; }
  return { origin, approvedOrigin: `https://localhost:${server.address().port}`, receipts, qualification: httpProbe ? 'HTTP_BLOCKER_PROBE_NOT_AUTH_PASS' : 'LOCAL_HTTPS_SYNTHETIC_READER',
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); await auth.close(); repository.close(); },
  };
}
