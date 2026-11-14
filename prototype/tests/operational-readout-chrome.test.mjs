// Test-only installed-Chrome qualification. Never imported by runtime packaging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { build } from '../node_modules/vite/dist/node/index.js';
import { chromium } from '../node_modules/@playwright/test/index.mjs';
import AxeBuilder from '../node_modules/@axe-core/playwright/dist/index.mjs';
import { fictionalArtifact } from '../../src/vendor/fixture.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.HALDIR_EVIDENCE_DIR;
assert.ok(evidence, 'Explicit private evidence directory required');
const time = 1794564000000;
const digest = data => createHash('sha256').update(data).digest('hex');
const reportPath = new URL('./fixtures/operational-supplier-report.json', import.meta.url);
const sourceFiles = ['src/integration/public-workspace.tsx', 'src/integration/testnet.ts', 'src/index.css', 'src/App.css', 'src/brand-light.css', 'src/integration/public-ui-latest.css', 'vite.config.ts', 'package.json', 'package-lock.json', '../src/vendor/fixture.mjs'];
async function hashes() { return Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, digest(await readFile(root + name))]))); }
async function treeHashes(dir) {
  const result = {};
  async function walk(path, prefix = '') { for (const d of await readdir(path, { withFileTypes: true })) { const name = prefix + d.name; if (d.isDirectory()) await walk(path + '/' + d.name, name + '/'); else result[name] = digest(await readFile(path + '/' + d.name)); } }
  await walk(dir); return result;
}
// Whole HTTP response is explicitly synthetic. The accepted B report and exact
// production Northwind artifact builder retain all findings/indexes/artifact data.
function fixture(acceptedReport, mode) {
  // Only the envelope qualification is adapted to the public parser contract;
  // accepted excerpts, indexes, purchases and exact artifact digests are retained.
  const report = { ...acceptedReport, qualification: 'PUBLIC_TESTNET_FICTIONAL_VENDOR' };
  const jobId = 'job-operational-readout', mandateId = 'two.testnet';
  const orders = report.purchases.map(p => {
    const quote = { networkId: 'testnet', mandateId, vendorId: p.vendorId, amountAtomic: p.amountAtomic, orderId: p.orderId, content: 'Northwind fictional sample: ' + p.sourceId };
    const artifact = fictionalArtifact({ quoteId: p.quoteId, quote });
    const proof = { proofId: p.proofId, transactionHash: '1'.repeat(32), ...quote };
    return { sourceId: p.sourceId, order: { jobId, quoteId: p.quoteId, orderId: p.orderId, quote, lifecycle: 'DELIVERED', proof, artifact, lastCheckCode: null }, payment: { status: 'SUBMITTED', transactionHash: proof.transactionHash } };
  });
  for (const f of report.facts) assert.equal(orders.find(o => o.sourceId === f.sourceId).order.artifact.contentDigest, f.contentDigest);
  const value = { contractVersion: 'haldir.public.v2', job: { jobId, ownerId: 'owner.testnet', scope: { networkId: 'testnet', mandateId, purpose: report.purpose, output: report.output, budgetAtomic: '30', vendorIds: orders.map(o => o.order.quote.vendorId), expiresAt: '2026-11-16T18:00:00.123Z' }, state: 'ACTIVE', qualification: report.qualification, manifestId: 'manifest-operational-readout', ownerCreationRequired: false, schemaVersion: 'haldir.job.two-source.v1', sourceRefs: orders.map(o => ({ sourceId: o.sourceId, quoteId: o.order.quoteId })) }, orders, order: orders[0].order, payment: orders[0].payment, run: { stage: 'COMPLETE', report }, ownerOperations: [], ownerApproval: null, disclosures: { vendorData: 'FICTIONAL_SAMPLE', supplierVerified: false, principalReturn: 'Free balance is not a refund.' }, economics: { schemaVersion: 'haldir.mandate-economics.v1', state: 'known', networkId: 'testnet', ownerId: 'owner.testnet', mandateId, source: { rpcUrl: 'https://rpc.testnet.near.org', method: 'get_status', finality: 'final' }, observation: { blockHash: '1'.repeat(32), blockHeight: 456, blockTimestampNs: String(BigInt(time - 1000) * 1000000n), observedAt: time }, amounts: { capAtomic: '30', spentAtomic: '8', reservedAtomic: '9', availableAtomic: '11', refundedAtomic: '2' }, reason: null } };
  if (mode === 'stale') { value.economics.state = 'stale'; value.economics.reason = 'STALE_BLOCK'; value.economics.observation.blockTimestampNs = String(BigInt(time - 31000) * 1000000n); }
  if (mode === 'unavailable') { value.economics.state = 'unavailable'; value.economics.reason = 'RPC_UNAVAILABLE'; value.economics.observation = value.economics.amounts = null; }
  if (mode === 'absent') delete value.economics;
  if (mode.startsWith('uncertain')) { value.economics.state = 'uncertain'; value.economics.reason = 'OPERATION_UNCERTAIN'; if (mode === 'uncertain-empty') value.economics.observation = value.economics.amounts = null; value.ownerOperations = [{ operationId: 'b'.repeat(64), action: 'withdraw', status: 'UNKNOWN', request: null, transactionHash: null, signerId: 'owner.testnet', receipt: null }]; }
  return value;
}
const entry = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {createPublicTestnetController} from ${JSON.stringify(root + 'src/integration/testnet.ts')};
import {PublicTaskContext,PublicReport,PublicSourceResults} from ${JSON.stringify(root + 'src/integration/public-workspace.tsx')};
import ${JSON.stringify(root + 'src/index.css')}; import ${JSON.stringify(root + 'src/App.css')};
import ${JSON.stringify(root + 'src/integration/public-ui-latest.css')}; import ${JSON.stringify(root + 'src/brand-light.css')};
const origin=location.origin, e=React.createElement, mode=new URL(location.href).searchParams.get('case')||'known';
const principal={sessionId:'a'.repeat(64),accountId:'owner.testnet',publicKey:'ed25519:'+'1'.repeat(32),networkId:'testnet',origin,recipient:location.hostname,expiresAt:1900000000000,authenticationOnly:true};
const values=new Map([['haldir-public-job-v1:'+origin+':owner.testnet','job-operational-readout']]);
window.__transport=[]; window.__rootRenders=0;
const controller=createPublicTestnetController({origin,approvedOrigin:origin,principal:()=>principal,now:Date.now,storage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},transport:(url,init)=>{window.__transport.push({url:String(url),method:init?.method});return fetch(url,{...init,headers:{...init?.headers,'x-qualification-mode':mode}})}});
window.__controller=controller;
await controller.resume(); const snap=controller.getSnapshot(); window.__initial=JSON.stringify(snap.view);
if(snap.error||!snap.view) throw Error('STRICT_PARSER:'+snap.error);
const view=snap.view; window.__mountedView=view;
function ScopedReadout(){window.__rootRenders++;return e('main',{id:'qualified-readout',className:'preview-page','data-public-testnet':true},
 e('h1',null,'Operational component qualification'),e('p',{className:'preview-notice'},'SYNTHETIC HTTP FIXTURE ONLY · Production components and strict controller · Scoped single-flow reader, not full App, wallet, provider or live chain proof.'),
 e('div',{className:'conversation-content journey'},e('section',{'aria-label':'Task context qualification'},e('h2',null,'Task context'),e(PublicTaskContext,{view})),
 e('section',{'aria-label':'Report qualification'},e('h2',null,'Evidence brief'),e(PublicReport,{report:view.run.report})),
 e(PublicSourceResults,{view}),
 e('details',{id:'second-report'},e('summary',null,'Second independently mounted report'),e(PublicReport,{report:view.run.report}))));}
createRoot(document.getElementById('root')).render(e(ScopedReadout));
`;

test('production report links and economic readout in installed Chrome (scoped synthetic HTTP qualification)', { timeout: 180000 }, async () => {
  await mkdir(evidence, { recursive: true });
  assert.equal((await readdir(evidence)).length, 0, 'EVIDENCE_DIR_NOT_EMPTY: use a fresh explicit evidence directory');
  const startedAt = new Date().toISOString(), before = await hashes(), distBefore = await treeHashes(root + 'dist');
  assert.equal(before['src/integration/public-workspace.tsx'], '1fad1ca4f2a5236d416729a5ce594dd28fbbe1f4e1e7d09be8323a7fca3dbd2e');
  assert.equal(before['src/integration/testnet.ts'], 'af5cd7fbab587e1822124cc3f3d9f38d6e96c24b58ec33f69848c8051cf263ff');
  const reportBytes = await readFile(reportPath), report = JSON.parse(reportBytes);
  assert.deepEqual(report.interpretations.map(v => v.findingIndexes), [[0,1],[0,2,3]]);
  await writeFile(evidence + '/input-report.json', reportBytes);
  await writeFile(evidence + '/source-before.json', JSON.stringify(before, null, 2));
  const output = await build({ root, configFile: root + 'vite.config.ts', configLoader: 'native', cacheDir: evidence + '/vite-cache', logLevel: 'warn', plugins: [{ name: 'test-only-operational-readout', resolveId: id => id === 'virtual:operational-readout' ? '\0operational-readout' : undefined, load: id => id === '\0operational-readout' ? entry : undefined }], build: { write: false, outDir: evidence + '/private-bundle', rollupOptions: { input: 'virtual:operational-readout' } } });
  assert.ok(!Array.isArray(output));
  const importedSourceFiles=[...new Set(output.output.filter(a=>a.type==='chunk').flatMap(a=>a.moduleIds??Object.keys(a.modules??{})).map(id=>id.split('?')[0]).filter(id=>id.startsWith(root+'src/')))];
  assert.ok(importedSourceFiles.length>0,'Actual bundled source graph captured');
  assert.ok(importedSourceFiles.every(id=>!id.includes('/landing/')),'No landing modules admitted');
  const importedSourceBefore=Object.fromEntries(await Promise.all(importedSourceFiles.map(async id=>[id,digest(await readFile(id))])));
  const assets = new Map(), outputHashes = {};
  for (const a of output.output) { const data = a.type === 'chunk' ? a.code : a.source; assets.set('/' + a.fileName, data); outputHashes[a.fileName] = digest(data); }
  const chunk = output.output.find(a => a.type === 'chunk' && a.isEntry);
  const css = output.output.filter(a => a.fileName.endsWith('.css')).map(a => `<link rel="stylesheet" href="/${a.fileName}">`).join('');
  assets.set('/', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test-only operational readout</title>${css}</head><body><div id="root"></div><script type="module" src="/${chunk.fileName}"></script></body></html>`);
  assets.set('/fonts/manrope/Manrope[wght].ttf', await readFile(root + 'public/fonts/manrope/Manrope[wght].ttf'));
  const requests = [], denied = [], errors = [], cases = [], screenshots = [], axe = [];
  let mode = 'known', browser, server, port, closed = false;
  const check = async (id, fn) => { try { const detail = await fn(); cases.push({ id, status: 'PASS', detail }); } catch(e) { cases.push({ id, status: 'FAIL', error: e.stack }); } };
  const config = { contractVersion: 'haldir.public.v1', networkId: 'testnet', financialActions: false, missingConfiguration: [], vendorData: 'FICTIONAL_SAMPLE', maxRunMs: 15000 };
  try {
    execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',evidence+'/.tls.key','-out',evidence+'/.tls.crt','-days','1','-subj','/CN=127.0.0.1'],{stdio:'ignore'});
    const tls={key:await readFile(evidence+'/.tls.key'),cert:await readFile(evidence+'/.tls.crt')};
    await rm(evidence+'/.tls.key'); await rm(evidence+'/.tls.crt');
    server = createServer(tls,(req,res) => {
      const row = { path:req.url, method:req.method, mode:req.headers['x-qualification-mode']??null }; requests.push(row);
      const pathname = decodeURI(new URL(req.url,'http://127.0.0.1').pathname);
      let data, type;
      if (req.method === 'POST' && pathname === '/api/public/config') { data = JSON.stringify(config); type = 'application/json'; }
      else if (req.method === 'POST' && pathname === '/api/public/jobs/job-operational-readout') { data = JSON.stringify(fixture(report,req.headers['x-qualification-mode'])); type = 'application/json'; }
      else if (req.method === 'GET' && assets.has(pathname)) { data = assets.get(pathname); type = pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':pathname.endsWith('.ttf')?'font/ttf':'text/html'; }
      else { row.status=404; res.writeHead(404); res.end('Unowned route'); return; }
      row.status=200; res.writeHead(200,{'content-type':type,'cache-control':'no-store','content-security-policy':"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; object-src 'none'; worker-src 'none'"}); res.end(data);
    });
    await new Promise(r => server.listen(0,'127.0.0.1',r)); port=server.address().port;
    const origin='https://127.0.0.1:'+port;
    browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking','--disable-component-update','--no-first-run']});
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',ignoreHTTPSErrors:true});
    await context.route('**/*',route => {const u=new URL(route.request().url());if(u.origin===origin)return route.continue();denied.push(route.request().url());return route.abort('blockedbyclient');});
    await context.routeWebSocket('**/*',socket=>{denied.push(socket.url());socket.close();});
    await context.addInitScript(()=>{window.open=()=>{throw Error('EXTERNAL_WINDOW_FORBIDDEN')};});
    const page=await context.newPage(); page.setDefaultTimeout(5000); page.on('pageerror',e=>errors.push(e.message));
    await page.clock.install({time:new Date(time)}); await page.clock.pauseAt(new Date(time));
    const load=async value=>{mode=value;await page.goto(origin+'/?case='+value);await page.getByRole('region',{name:'Spending',exact:true}).waitFor();await page.evaluate(()=>document.fonts.ready);};
    const spending=()=>page.getByRole('region',{name:'Spending',exact:true});
    const shot=async name=>{await page.screenshot({path:evidence+'/'+name});screenshots.push(name);};
    await load('known');
    await check('literal-amounts-and-provenance',async()=>{
      for(const text of ['Spent · 8 yoctoNEAR','Reserved · 9 yoctoNEAR','Available · 11 yoctoNEAR','Known · Fresh observation','Purchase cap · 30 yoctoNEAR']) assert.ok((await spending().innerText()).includes(text));
      await spending().getByText('Observation provenance',{exact:true}).click();
      const text=await spending().innerText();for(const s of ['https://rpc.testnet.near.org · get_status · final · testnet','Block · 456 · '+'1'.repeat(32),'Block timestamp · '+String(BigInt(time-1000)*1000000n)+' ns','Observed at · '+time+' ms since Unix epoch'])assert.ok(text.includes(s),s);
      assert.equal(await spending().getByRole('button').count(),0); await spending().scrollIntoViewIfNeeded(); await shot('desktop-spending.png');return {text};
    });
    await check('idle-staleness-exact-boundary-no-request-or-root-rerender',async()=>{
      const before=await page.evaluate(()=>({transport:window.__transport.length,root:window.__rootRenders,view:JSON.stringify(window.__mountedView)})), requestCount=requests.length;
      await page.clock.runFor(29000);assert.ok((await spending().innerText()).includes('Known · Fresh observation'));
      await page.clock.runFor(1);assert.ok((await spending().innerText()).includes('Stale · Last observed amounts'));assert.ok((await spending().innerText()).includes('not current spend permission'));
      assert.ok((await spending().innerText()).includes('Observed at · '+time+' ms since Unix epoch'));
      const after=await page.evaluate(()=>({transport:window.__transport.length,root:window.__rootRenders,view:JSON.stringify(window.__mountedView)}));assert.deepEqual(after,before);assert.equal(requests.length,requestCount);return {before,after,requestCount};
    });
    // Axe schedules ordinary browser timers. Resume only after the exact idle
    // boundary assertions; keeping time paused would deadlock the audit itself.
    await page.clock.resume();
    await check('native-advisory-click-and-keyboard-focus-exact-excerpts',async()=>{
      const article=page.getByRole('article',{name:'Source-linked report'}).first(), links=article.getByRole('link');
      assert.deepEqual(await links.allTextContents(),['Evidence 1','Evidence 2','Evidence 1','Evidence 3','Evidence 4']);
      await article.getByText('Linked evidence',{exact:true}).last().focus();await page.keyboard.press('Tab');
      assert.equal(await links.first().evaluate(e=>document.activeElement===e),true,'Native anchors reachable with actual Tab');
      const indexes=report.interpretations.flatMap(v=>v.findingIndexes), results=[];
      for(let i=0;i<indexes.length;i++)for(const action of ['click','Enter']){
        const link=links.nth(i),href=await link.getAttribute('href');if(action==='click')await link.click();else{await link.focus();await page.keyboard.press('Enter');}
        await page.waitForFunction(id=>document.activeElement?.id===id,href.slice(1),{timeout:1500});

        const observed=await page.evaluate(id=>{const t=document.getElementById(id),r=t.getBoundingClientRect();return {id:t.id,excerpt:t.querySelector('blockquote').textContent,focused:document.activeElement===t,top:r.top,bottom:r.bottom,visible:r.top>=0&&r.top<innerHeight};},href.slice(1));
        assert.equal(observed.excerpt,report.facts[indexes[i]].excerpt);assert.equal(observed.focused,true);assert.equal(observed.visible,true);

        const summary=page.locator('summary').filter({hasText:'Linked evidence'}).nth(indexes[i]);
        if(!await summary.evaluate(s=>s.parentElement.open)) {await summary.focus();await page.keyboard.press('Enter');}
        assert.equal(await summary.evaluate(s=>s.parentElement.open),true);
        const text=await summary.evaluate(s=>s.parentElement.innerText);for(const key of ['artifactId','orderId','proofId','contentDigest'])assert.ok(text.includes(report.facts[indexes[i]][key]),key);
        results.push({i,index:indexes[i],action,...observed});
      }
      await links.last().scrollIntoViewIfNeeded();await shot('desktop-report-links.png');return results;
    });
    await check('multiple-mounted-report-ids-no-cross-link',async()=>{
      const rows=await page.getByRole('article',{name:'Source-linked report',includeHidden:true}).evaluateAll(articles=>articles.map(a=>[...a.querySelectorAll('a')].map(l=>({href:l.getAttribute('href'),own:a.contains(document.getElementById(l.hash.slice(1)))}))));
      assert.equal(rows.length,2);assert.ok(rows.flat().every(r=>r.own));assert.equal(new Set(rows.flat().map(r=>r.href)).size,8);
      const ids=await page.locator('[id]').evaluateAll(nodes=>nodes.map(n=>n.id));assert.equal(new Set(ids).size,ids.length);return rows;
    });
    await check('task-source-links-native-focus-and-existing-evidence',async()=>{
      for(const [i,source] of ['company-records','background-research'].entries()){
        const link=page.getByRole('link',{name:'View evidence and receipt'}).nth(i);await link.focus();await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(()=>document.activeElement.id),'public-source-'+source);
        const section=page.getByRole('region',{name:i?'Background research source':'Company records source',exact:true});await section.getByText('Evidence and purchase receipt',{exact:true}).click();assert.ok((await section.innerText()).includes(report.purchases[i].proofId));
      }
    });
    for(const width of [1440,390,320])await check('readability-controls-axe-'+width,async()=>{
      await page.setViewportSize({width,height:1000});
      const overflow=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('#qualified-readout *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.left<-.5||r.right>innerWidth+.5)}).map(e=>({tag:e.tagName,cls:e.className,text:e.textContent.slice(0,70)}))}));assert.equal(overflow.width,width);assert.ok(overflow.scrollWidth<=width,JSON.stringify(overflow));assert.deepEqual(overflow.offenders,[]);
      for(const selector of ['[aria-label="Spending"] summary','article[aria-label="Source-linked report"] summary']){
        const control=page.locator(selector).first();await control.scrollIntoViewIfNeeded();await control.focus();assert.equal(await control.evaluate(e=>document.activeElement===e),true);await page.keyboard.press('Enter');await page.keyboard.press('Enter');
      }
      await spending().scrollIntoViewIfNeeded();await shot('readout-spending-'+width+'.png');
      const article=page.getByRole('article',{name:'Source-linked report'}).first();await article.locator('h3').scrollIntoViewIfNeeded();await shot('readout-report-'+width+'.png');
      await article.getByRole('link').last().scrollIntoViewIfNeeded();await shot('readout-advisories-'+width+'.png');
      const a=await new AxeBuilder({page}).include('#qualified-readout').analyze();axe.push({width,violations:a.violations,incomplete:a.incomplete,passes:a.passes.map(p=>p.id)});assert.deepEqual(a.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)})),[]);return overflow;
    });
    for(const state of ['stale','unavailable','absent','uncertain','uncertain-empty'])await check('state-'+state,async()=>{
      await load(state);const text=await spending().innerText();
      if(['unavailable','absent','uncertain-empty'].includes(state))for(const label of ['Spent','Reserved','Available'])assert.ok(text.includes(label+' · Unavailable'));
      else for(const s of ['Spent · 8 yoctoNEAR','Reserved · 9 yoctoNEAR','Available · 11 yoctoNEAR'])assert.ok(text.includes(s));
      assert.doesNotMatch(text,/(Spent|Reserved|Available) · 0 yoctoNEAR|Recovered|Returned|Refunded|2 yoctoNEAR/);
      if(state==='stale'){assert.ok(text.includes('not current spend permission'));await spending().getByText('Observation provenance',{exact:true}).click();assert.ok((await spending().innerText()).includes(String(BigInt(time-31000)*1000000n)));}
      if(state.startsWith('uncertain')){assert.ok(text.includes('Uncertain · Observations only'));assert.ok(text.includes('not confirmation of its outcome'));assert.ok((await page.getByRole('region',{name:'Activity',exact:true}).innerText()).includes('Owner withdrawal · UNKNOWN'));assert.equal(await page.evaluate(()=>window.__controller.getSnapshot().view.ownerOperations[0].receipt),null);}
      await spending().scrollIntoViewIfNeeded();await shot('state-'+state+'-320.png');return {text,transport:await page.evaluate(()=>window.__transport)};
    });
    await check('fresh-direct-mobile-load-390',async()=>{await page.setViewportSize({width:390,height:1000});await load('unavailable');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await spending().scrollIntoViewIfNeeded();await shot('direct-mobile-unavailable-390.png');});
    await check('isolated-transport-and-pageerrors',async()=>{assert.deepEqual(denied,[]);assert.deepEqual(errors,[]);assert.equal(await context.cookies().then(x=>x.length),0);assert.ok(requests.filter(r=>r.method!=='GET').every(r=>r.method==='POST'&&['/api/public/config','/api/public/jobs/job-operational-readout'].includes(r.path)));return {requests:requests.length,denied,errors,browserVersion:browser.version()};});
  } catch(error) {
    cases.push({id:'harness-fatal',status:'FAIL',error:error.stack});throw error;
  } finally {
    if(browser)await browser.close();
    if(server){server.closeAllConnections();await new Promise(r=>server.close(r));closed=await new Promise(resolve=>{const s=connect(port,'127.0.0.1');s.once('error',e=>resolve(e.code==='ECONNREFUSED'));s.once('connect',()=>{s.destroy();resolve(false)});});}
    const after=await hashes(),distAfter=await treeHashes(root+'dist');
    const importedSourceAfter=Object.fromEntries(await Promise.all(importedSourceFiles.map(async id=>[id,digest(await readFile(id))])));
    cases.push({id:'actual-imported-source-graph-unchanged-no-landing',status:JSON.stringify(importedSourceBefore)===JSON.stringify(importedSourceAfter)?'PASS':'FAIL',detail:{before:importedSourceBefore,after:importedSourceAfter}});
    cases.push({id:'source-dist-unchanged-and-private-assets-not-packaged',status:JSON.stringify(before)===JSON.stringify(after)&&JSON.stringify(distBefore)===JSON.stringify(distAfter)?'PASS':'FAIL',detail:{before,after,distBefore,distAfter,privateAssetNames:[...assets.keys()]}});
    cases.push({id:'server-shutdown-port-closed',status:closed?'PASS':'FAIL',port});
    await writeFile(evidence+'/source-after.json',JSON.stringify(after,null,2));await writeFile(evidence+'/axe.json',JSON.stringify(axe,null,2));
    const totals={pass:cases.filter(x=>x.status==='PASS').length,fail:cases.filter(x=>x.status==='FAIL').length,total:cases.length};
    const screenshotHashes=Object.fromEntries(await Promise.all(screenshots.map(async name=>[name,digest(await readFile(evidence+'/'+name))])));
    await writeFile(evidence+'/receipt.json',JSON.stringify({startedAt,endedAt:new Date().toISOString(),scope:'SCOPED_PRODUCTION_COMPONENTS_ACTUAL_CONTROLLER_SYNTHETIC_HTTP_NOT_FULL_APP_OR_LIVE_PROOF',runtime:process.version,argv:process.argv,scriptSHA256:digest(await readFile(fileURLToPath(import.meta.url))),reportSHA256:digest(reportBytes),entrySHA256:digest(entry),outputHashes,cases,totals,requests,denied,errors,screenshots,screenshotHashes,portClosed:closed},null,2));
    console.log(JSON.stringify({totals,evidence,denied:denied.length,pageerrors:errors.length,portClosed:closed}));
  }
  assert.equal(cases.filter(x=>x.status==='FAIL').length,0,JSON.stringify(cases.filter(x=>x.status==='FAIL')));
});
