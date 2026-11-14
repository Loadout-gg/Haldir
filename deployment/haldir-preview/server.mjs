import { createServer } from 'node:http';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletAuthHttp } from '../../src/server/wallet-auth-http.mjs';

const mime = Object.freeze({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.pb': 'text/plain; charset=utf-8' });
function demand(ok, code) { if (!ok) throw new Error(code); }
async function uiFiles(uiDir) {
  const root = uiDir instanceof URL ? fileURLToPath(uiDir) : uiDir;
  const files = new Map();
  async function add(relative) {
    const path = join(root, relative);
    const stat = await lstat(path);
    demand(!stat.isSymbolicLink(), 'UI_SYMLINK_FORBIDDEN');
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        demand(/^[A-Za-z0-9_-][A-Za-z0-9_.\[\]-]*$/.test(name), 'UI_FILENAME_FORBIDDEN');
        await add(`${relative}/${name}`);
      }
    } else {
      demand(stat.isFile() && Object.hasOwn(mime, extname(path)), 'UI_FILE_FORBIDDEN');
      const file = { bytes: await readFile(path), type: mime[extname(path)] };
      files.set(`/${relative}`, file);
      files.set('/' + relative.split('/').map(encodeURIComponent).join('/'), file);
    }
  }
  await add('index.html'); await add('assets'); await add('fonts');
  return files;
}
// Trusted composition seam only; HTTP inputs can never select adapters or identities.
// No automatic listener, synthetic principal, orders/SQLite import or financial route.
export async function createPreviewServer({ uiDir, approvedOrigin, repository, trustedAccessKeyReader } = {}) {
  let origin;
  try { origin = new URL(approvedOrigin); } catch { /* rejected below */ }
  demand(origin?.protocol === 'https:' && origin.origin === approvedOrigin &&
    !origin.username && !origin.password, 'EXACT_HTTPS_ORIGIN_REQUIRED');
  demand(typeof repository?.runTransaction === 'function' && typeof trustedAccessKeyReader === 'function', 'AUTH_ADAPTERS_REQUIRED');
  const files = await uiFiles(uiDir);
  const auth = createWalletAuthHttp({ repository, approvedOrigin, approvedRecipient: origin.hostname, trustedAccessKeyReader });
  return createServer({ requestTimeout: 15_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8', headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    // Liveness only, no authority or DB readiness assertion; Cloud Run probes use an internal Host.
    if (req.url === '/healthz' && req.method === 'GET') return send(200, '{"alive":true,"financialActions":false}');
    const hosts = req.rawHeaders.filter((x, i) => i % 2 === 0 && x.toLowerCase() === 'host');
    if (hosts.length !== 1 || req.headers.host !== origin.host) return send(403, '{"error":"HOST_REQUIRED"}');
    if (req.url.startsWith('/api/wallet-auth/')) return auth.handle(req, res);
    if (!['GET', 'HEAD'].includes(req.method)) return send(404, '{"error":"NOT_FOUND"}');
    if (req.url === '/') return send(302, '', 'text/plain', { location: '/?mode=wallet-auth-qualification' });
    const file = req.url === '/?mode=wallet-auth-qualification' ? files.get('/index.html') :
      /^\/(assets|fonts)\//.test(req.url) ? files.get(req.url) : undefined;
    if (!file) return send(404, '{"error":"NOT_FOUND"}');
    return send(200, file.bytes, file.type);
  });
}
