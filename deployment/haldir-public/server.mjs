import { createServer } from 'node:http';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, extname, resolve, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletAuthHttp } from '../../src/server/wallet-auth-http.mjs';
import { createPublicJourney } from '../../src/server/public-journey.mjs';

const mime = Object.freeze({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.pb': 'text/plain; charset=utf-8' });
const demand = (ok, code) => { if (!ok) throw new Error(code); };
async function uiFiles(uiDir) {
  const root = uiDir instanceof URL ? fileURLToPath(uiDir) : uiDir;
  const files = new Map();
  demand(typeof root === 'string', 'UI_ROOT_INVALID');
  const absolute = resolve(root);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep)) {
    current = join(current, part);
    demand(!(await lstat(current)).isSymbolicLink(), 'UI_SYMLINK_FORBIDDEN');
  }
  async function add(relative) {
    const path = join(root, relative), stat = await lstat(path);
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

/** Successor factory; import never listens or discovers environment/credentials.
 * Static content is supplied by trusted assembly, not synthesized or built here.
 */
export async function createPublicServer(options = {}) {
  const allowed = ['uiDir', 'approvedOrigin', 'repository', 'trustedAccessKeyReader',
    'trustedManifestProvider', 'trustedSignerProvider', 'trustedMandateStatusReader', 'model', 'ownerOperations',
    'capabilities', 'maxRunMs', 'bodyTimeoutMs'];
  demand(options && typeof options === 'object' && !Array.isArray(options) &&
    Object.keys(options).every(key => allowed.includes(key)), 'PUBLIC_HOST_CONFIGURATION_INVALID');
  const { uiDir, approvedOrigin, repository, trustedAccessKeyReader,
    trustedManifestProvider, trustedSignerProvider, trustedMandateStatusReader, model, ownerOperations, capabilities,
    maxRunMs, bodyTimeoutMs } = options;
  let origin;
  try { origin = new URL(approvedOrigin); } catch { /* rejected below */ }
  demand(origin?.protocol === 'https:' && origin.origin === approvedOrigin &&
    !origin.username && !origin.password, 'EXACT_HTTPS_ORIGIN_REQUIRED');
  demand(typeof repository?.runTransaction === 'function' && typeof trustedAccessKeyReader === 'function', 'AUTH_ADAPTERS_REQUIRED');
  const files = await uiFiles(uiDir);
  // Both services share exactly this repository and current owner-key reader.
  // No host-owned admission/lifecycle gates: the delivered public handler owns them.
  const auth = createWalletAuthHttp({ repository, approvedOrigin, approvedRecipient: origin.hostname,
    trustedAccessKeyReader, bodyTimeoutMs });
  const journey = createPublicJourney({ repository, approvedOrigin, approvedRecipient: origin.hostname,
    trustedAccessKeyReader, trustedManifestProvider, trustedSignerProvider, trustedMandateStatusReader, model, ownerOperations,
    capabilities, maxRunMs, bodyTimeoutMs });
  return createServer({ requestTimeout: 15_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8', headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    // Liveness only; deliberately not database, model, signer or financial readiness.
    if (req.url === '/healthz' && req.method === 'GET') return send(200, '{"alive":true}');
    const hosts = req.rawHeaders.filter((x, i) => i % 2 === 0 && x.toLowerCase() === 'host');
    if (hosts.length !== 1 || req.headers.host !== origin.host) return send(403, '{"error":"HOST_REQUIRED"}');
    if (req.url.startsWith('/api/wallet-auth/')) return auth.handle(req, res);
    if (req.url.startsWith('/api/public/')) return journey.handle(req, res);
    if (!['GET', 'HEAD'].includes(req.method)) return send(404, '{"error":"NOT_FOUND"}');
    // Match raw origin-form paths. Do not normalize dot segments or encoded routes.
    const queryAt = req.url.indexOf('?');
    const pathname = queryAt < 0 ? req.url : req.url.slice(0, queryAt);
    const search = queryAt < 0 ? '' : req.url.slice(queryAt + 1);
    const modes = new URLSearchParams(search).getAll('mode');
    const documentRoute =
      (pathname === '/' && (modes.length === 0 ||
        modes.length === 1 && ['public-testnet', 'simulation'].includes(modes[0]))) ||
      (['/app', '/demo'].includes(pathname) && modes.length === 0);
    const file = documentRoute ? files.get('/index.html') :
      /^\/(assets|fonts)\//.test(pathname) ? files.get(pathname) : undefined;
    if (!file) return send(404, '{"error":"NOT_FOUND"}');
    return send(200, file.bytes, file.type);
  });
}
