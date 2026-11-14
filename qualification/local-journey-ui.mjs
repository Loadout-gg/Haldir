// LOCAL SYNTHETIC QUALIFICATION ONLY. No wallet, RPC, signing or financial API.
// Serves the built incumbent UI + exact-origin proxy to the actual backend.
import { createServer, request } from 'node:http';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalApp } from '../src/server/app.mjs';
import { createOrders, openLocalRepository } from '../src/server/orders.mjs';
import { syntheticPayment } from '../src/vendor/fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = join(homedir(), '.hermes/cache/scratch');
const defaultDirectory = join(scratchRoot, 'haldir-local-ui-v1');
const stages = new Set(['unknown', 'unpaid', 'paid']);
const approved = {
  job: { networkId: 'testnet', mandateId: 'local-ui.testnet', purpose: 'Local supplier sample qualification',
    output: 'Fictional supplier artifact', budgetAtomic: '3000000000000000000000000',
    vendorIds: ['vendor.testnet'], expiresAt: '2099-11-13T12:00:00Z' },
  quote: { networkId: 'testnet', mandateId: 'local-ui.testnet', vendorId: 'vendor.testnet',
    amountAtomic: '3000000000000000000000000', orderId: 'local-ui-quote-v1', content: 'Northwind fictional sample' },
};
async function scratchDirectory(directory) {
  const scratch = await realpath(scratchRoot);
  const target = resolve(directory);
  const rel = relative(scratch, target);
  if (!rel || rel.startsWith('..') || rel.startsWith(sep)) throw new Error('STATE_DIRECTORY_MUST_BE_UNDER_SCRATCH');
  await mkdir(target, { recursive: true, mode: 0o700 });
  const actual = await realpath(target);
  if (!actual.startsWith(scratch + sep)) throw new Error('STATE_DIRECTORY_MUST_BE_UNDER_SCRATCH');
  return actual;
}

// Explicit operator-side action, never an HTTP route. Advances only the trusted
// synthetic collector fixture; does not mutate an order, submit proof, or pay.
export async function advanceLocalFixture({ directory = defaultDirectory, stage } = {}) {
  if (!stages.has(stage)) throw new Error('STAGE_MUST_BE_unknown_unpaid_OR_paid');
  directory = await scratchDirectory(directory);
  const path = join(directory, 'receipt-stage');
  const temporary = join(directory, `receipt-stage-${process.pid}.pending`);
  await writeFile(temporary, stage + '\n', { mode: 0o600 });
  await rename(temporary, path);
  if ((await readFile(path, 'utf8')).trim() !== stage) throw new Error('FIXTURE_READBACK_FAILED');
  return { qualification: 'LOCAL_SYNTHETIC_ONLY', directory, stage };
}

export async function startLocalJourneyUi({ directory = defaultDirectory, port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
  directory = await scratchDirectory(directory);
  const dist = await realpath(join(root, 'prototype/dist'));
  await readFile(join(dist, 'index.html')); // fail before listening if build is absent
  const stageFile = join(directory, 'receipt-stage');
  try { await writeFile(stageFile, 'unknown\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const repository = openLocalRepository({ localTestOnly: true, filename: join(directory, 'journey.sqlite') });
  const orders = createOrders({ repository, localTestOnly: true, trustedReceiptCollector: async ({ quote }) => {
    const stage = (await readFile(stageFile, 'utf8')).trim();
    if (!stages.has(stage)) throw new Error('INVALID_OPERATOR_FIXTURE');
    if (stage === 'unknown') return null;
    const evidence = syntheticPayment(quote, 31).evidence;
    if (stage === 'unpaid') evidence.finalTransaction.status = { SuccessValue: Buffer.from('false').toString('base64') };
    return evidence;
  } });
  const backend = createLocalApp({ localTestOnly: true, orders,
    testOnlySession: req => req.headers['x-test-session'] === 'local-ui-synthetic' ? 'local-owner.testnet' : null,
    trustedApprovalLookup: ({ ownerId, approvalId }) => ownerId === 'local-owner.testnet' && approvalId === 'local-ui-v1' ? structuredClone(approved) : null,
  });
  let backendOrigin, origin;
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ttf': 'font/ttf' };
  const frontend = createServer((req, res) => {
    const fail = (status, error) => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error, qualification: 'LOCAL_SYNTHETIC_ONLY' }));
    };
    const handle = async () => {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return fail(403, 'LOCAL_ORIGIN_REQUIRED');
      let url;
      try { url = new URL(req.url, origin); }
      catch { return fail(400, 'INVALID_LOCAL_URL'); }
      if (url.hash) return fail(404, 'NOT_FOUND');
      if (url.pathname.startsWith('/api/')) {
        // Rewrite only AFTER exact incoming Host/Origin validation. Never forward
        // browser identity/cookies/approval terms. Incumbent origin checks remain.
        const headers = { 'x-test-session': 'local-ui-synthetic', ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
          ...(req.headers.origin ? { origin: backendOrigin } : {}) };
        let upstream;
        try {
          upstream = request(backendOrigin + url.pathname + url.search, { method: req.method, headers }, response => {
            res.writeHead(response.statusCode, response.headers); response.pipe(res);
          });
        } catch { return fail(502, 'LOCAL_BACKEND_UNAVAILABLE'); }
        upstream.on('error', () => fail(502, 'LOCAL_BACKEND_UNAVAILABLE'));
        req.on('aborted', () => upstream.destroy());
        req.pipe(upstream);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(404, 'NOT_FOUND');
      if (url.pathname !== '/' && url.pathname !== '/index.html' && !/^\/(assets|fonts)\//.test(url.pathname)) return fail(404, 'NOT_FOUND');
      try {
        const path = await realpath(join(dist, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1)));
        if (!path.startsWith(dist + sep)) return fail(404, 'NOT_FOUND');
        const bytes = await readFile(path);
        res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch { fail(404, 'NOT_FOUND'); }
    };
    // EventEmitter does not consume rejected async request handlers.
    void handle().catch(() => fail(500, 'LOCAL_INTERNAL_ERROR'));
  });
  try {
    ({ origin: backendOrigin } = await backend.listen());
    await new Promise((done, reject) => {
      frontend.once('error', reject);
      frontend.listen({ host: '127.0.0.1', port, exclusive: true }, () => { frontend.off('error', reject); done(); });
    });
    origin = `http://127.0.0.1:${frontend.address().port}`;
  } catch (error) { await backend.close(); repository.close(); throw error; }
  let closed = false;
  return { origin, backendOrigin, directory, qualification: 'LOCAL_SYNTHETIC_ONLY',
    async close() {
      if (closed) return;
      closed = true;
      frontend.closeAllConnections();
      await new Promise((done, reject) => frontend.close(error => error ? reject(error) : done()));
      await backend.close(); repository.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--state-dir=')) options.directory = arg.slice('--state-dir='.length);
    else if (arg.startsWith('--port=') && /^\d+$/.test(arg.slice(7))) options.port = Number(arg.slice(7));
    else if (arg.startsWith('--stage=')) options.stage = arg.slice('--stage='.length);
    else throw new Error(`UNKNOWN_ARGUMENT: ${arg}`);
  }
  if (options.stage) console.log(JSON.stringify(await advanceLocalFixture(options)));
  else {
    const app = await startLocalJourneyUi(options);
    console.log(JSON.stringify({ qualification: app.qualification, url: app.origin + '/?mode=local-qualification', directory: app.directory,
      disclosure: 'Synthetic identity/receipt/sample data; LOCAL only; no wallet or live testnet' }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exitCode = 0; });
  }
}
