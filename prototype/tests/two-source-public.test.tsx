import { expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PublicTestnetWorkspace } from '../src/App'
import { createPublicTestnetController } from '../src/integration/testnet'
export const origin = 'https://approved.invalid'
export const principal = { sessionId: 'a'.repeat(64), accountId: 'owner.testnet', publicKey: 'ed25519:' + '1'.repeat(32), networkId: 'testnet', origin, recipient: 'approved.invalid', expiresAt: 1900000000000, authenticationOnly: true } as const
export const config = { contractVersion: 'haldir.public.v1', networkId: 'testnet', financialActions: true, missingConfiguration: [], vendorData: 'FICTIONAL_SAMPLE', maxRunMs: 15000, supportedJobSchemas: ['haldir.job.two-source.v1'] }
test('consumer can prepare a shared anonymous draft in chat and task editor before login', async () => {
  localStorage.clear()
  const snap: any = { principal: null, busy: false, error: null }, auth: any = { subscribe: () => () => {}, getSnapshot: () => snap, resume: vi.fn(), connect: vi.fn(), login: vi.fn(), logout: vi.fn() }
  const h = harness(); const { rerender } = render(<PublicTestnetWorkspace auth={auth} controller={h.client} />)
  await userEvent.type(screen.getByLabelText('Your message'), 'Check a fictional supplier')
  await userEvent.click(screen.getByRole('button',{ name: 'Send message' }))
  await userEvent.click(screen.getByRole('button',{ name: 'Edit details' }))
  expect(screen.getByLabelText('Job')).toHaveValue('Check a fictional supplier')
  snap.principal = principal; rerender(<PublicTestnetWorkspace auth={auth} controller={h.client} />)
  expect(screen.getByLabelText('Job')).toHaveValue('Check a fictional supplier')
  expect(h.requests.some(r => r.path === '/api/public/jobs')).toBe(false)
  expect(auth.login).not.toHaveBeenCalled()
})

export function twoView(): any {
  const scope = { networkId: 'testnet', mandateId: 'mandate.testnet', purpose: 'Review fictional supplier', output: 'Evidence-linked brief', budgetAtomic: '30', vendorIds: ['records.testnet', 'background.testnet'], expiresAt: '2026-11-16T18:00:00.123Z' }
  const orders = ['company-records', 'background-research'].map((sourceId, i) => {
    const quote = { networkId: 'testnet', mandateId: scope.mandateId, vendorId: scope.vendorIds[i], amountAtomic: i ? '15' : '8', orderId: 'order-' + i, content: i ? 'Background research sample' : 'Company records sample' }
    const quoteId = Buffer.from(JSON.stringify(['haldir-local-v1', quote.networkId, quote.mandateId, quote.orderId])).toString('base64url')
    return { sourceId, order: { jobId: 'job-two', quoteId, orderId: quote.orderId, quote, lifecycle: 'PAYMENT_PENDING', proof: null, artifact: null, lastCheckCode: null }, payment: { status: 'NOT_STARTED', transactionHash: null } }
  })
  return { contractVersion: 'haldir.public.v2', job: { jobId: 'job-two', ownerId: principal.accountId, scope, state: 'ACTIVE', qualification: 'PUBLIC_TESTNET_FICTIONAL_VENDOR', manifestId: 'manifest-two', ownerCreationRequired: false, schemaVersion: 'haldir.job.two-source.v1', sourceRefs: orders.map(m => ({ sourceId: m.sourceId, quoteId: m.order.quoteId })) }, orders, order: orders[0].order, payment: orders[0].payment, run: null, ownerOperations: [], ownerApproval: null, disclosures: { vendorData: 'FICTIONAL_SAMPLE', supplierVerified: false, principalReturn: 'Free balance is not a refund.' } }
}
export function harness() {
  let current = twoView(), p: any = principal
  const values = new Map<string,string>(), requests: { path: string; body: any }[] = []
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string,v: string) => { values.set(k,v) }, removeItem: (k: string) => { values.delete(k) } }
  const preview = () => ({ contractVersion: 'haldir.public.v2', approvalId: 'operator-two', manifestId: 'manifest-two', ownerId: principal.accountId, approved: { schemaVersion: 'haldir.approved.two-source.v1', job: current.job.scope, sources: current.orders.map((m: any) => ({ sourceId: m.sourceId, quote: m.order.quote })) }, ownerCreationRequired: false })
  const transport = vi.fn(async (url: any, init: any) => { const path = new URL(url).pathname; requests.push({ path, body: JSON.parse(init.body) }); return Response.json(path.endsWith('/config') ? config : path.endsWith('/approvals/read') ? preview() : current) })
  const client = createPublicTestnetController({ origin, approvedOrigin: origin, principal: () => p, storage, transport })
  return { client, values, storage, requests, transport, preview, setView: (v: any) => { current = v }, setPrincipal: (v: any) => { p = v } }
}
test('TS1 decodes both ordered members, never treats primary alias as the entire job', async () => {
  const h = harness(); await h.client.resume(); await h.client.open('operator-two','admission-two')
  expect(h.client.getSnapshot().error).toBeNull()
  expect(h.client.getSnapshot().view).toEqual(twoView())
})
export function deliver(v: any, index: number) {
  const m = v.orders[index], o = m.order, content = `FICTIONAL SAMPLE: ${m.sourceId}.`
  o.lifecycle = 'DELIVERED'; o.proof = { proofId: 'proof-' + index, transactionHash: String(index + 1).repeat(32), networkId: 'testnet', mandateId: o.quote.mandateId, orderId: o.orderId, vendorId: o.quote.vendorId, amountAtomic: o.quote.amountAtomic }
  o.artifact = { artifactId: 'fictional:' + o.quoteId, orderId: o.orderId, vendorId: o.quote.vendorId, fictionalSample: true, qualification: 'FICTIONAL_SAMPLE', mediaType: 'text/plain', content, contentDigest: createHash('sha256').update(content).digest('hex') }
  m.payment = { status: 'SUBMITTED', transactionHash: o.proof.transactionHash }
  v.order = v.orders[0].order; v.payment = v.orders[0].payment
}
test('trusted preview and core review gate re-read exact operator terms before ID-only admission', async () => {
  const h = harness(), c: any = h.client; await c.resume()
  // UI-facing methods are optional here only to observe the missing behavior.
  await c.readApproval?.('operator-two')
  expect(c.getSnapshot().preview).toEqual(h.preview())
  expect(h.requests.filter(r => r.path === '/api/public/jobs')).toHaveLength(0)
  const draft = { purpose: h.preview().approved.job.purpose, output: h.preview().approved.job.output, budgetAtomic: '30', expiresAt: h.preview().approved.job.expiresAt, sourceIds: ['company-records','background-research'] }
  await c.reviewDraft(draft)
  expect(c.getSnapshot().reviewed).toBe(true)
  await c.admitReviewed('admission-two',draft)
  expect(c.getSnapshot().error).toBeNull()
  expect(h.requests.filter(r => r.path === '/api/public/approvals/read')).toHaveLength(3)
  expect(h.requests.at(-1)).toEqual({ path: '/api/public/jobs', body: { approvalId: 'operator-two', admissionKey: 'admission-two' } })
  expect(c.getSnapshot().wallet).toBeNull()
})
test('an edit during pending review cannot restore review eligibility from the late preview', async () => {
  const h = harness(); let release!: () => void
  const held = new Promise<void>(r => {release=r})
  const original = h.transport.getMockImplementation()!
  let hold = false
  h.transport.mockImplementation(async (...args: Parameters<typeof original>) => { if (hold && String(args[0]).endsWith('/approvals/read')) await held; return original(...args) })
  await h.client.resume(); await h.client.readApproval('operator-two')
  const j = h.preview().approved.job, draft = {purpose:j.purpose,output:j.output,budgetAtomic:j.budgetAtomic,expiresAt:j.expiresAt,sourceIds:['company-records','background-research'] as ['company-records','background-research']}
  hold = true; const pending = h.client.reviewDraft(draft); h.client.invalidateReview(); release(); await pending
  expect(h.client.getSnapshot().reviewed).toBe(false)
  await h.client.admitReviewed('admission-two',draft)
  expect(h.requests.filter(r => r.path === '/api/public/jobs')).toHaveLength(0)
})
test('admission binds both complete approved quotes, not only shared scope', async () => {
  const h = harness(); await h.client.resume(); await h.client.readApproval('operator-two')
  const j=h.preview().approved.job,draft={purpose:j.purpose,output:j.output,budgetAtomic:j.budgetAtomic,expiresAt:j.expiresAt,sourceIds:['company-records','background-research'] as ['company-records','background-research']}
  await h.client.reviewDraft(draft)
  const original = h.transport.getMockImplementation()!
  h.transport.mockImplementation(async (...args: Parameters<typeof original>) => { const res = await original(...args); if (new URL(String(args[0])).pathname === '/api/public/jobs') {const v = await res.json(); v.orders[1].order.quote.content='Changed second approved description'; return Response.json(v)} return res })
  await h.client.admitReviewed('admission-two',draft)
  expect(h.client.getSnapshot().error).toBe('APPROVED_TERMS_CHANGED')
  expect(h.client.getSnapshot().view).toBeNull()
})
test('consumer review shows both sources, exact sum and unresolved costs before explicit admission', async () => {
  localStorage.clear(); const h = harness()
  const authSnapshot = { principal, busy:false,error:null }, auth: any = { subscribe:() => () => {}, getSnapshot:() => authSnapshot, resume:async () => {}, connect:vi.fn(),login:vi.fn(),logout:vi.fn() }
  render(<PublicTestnetWorkspace auth={auth} controller={h.client} />)
  await userEvent.type(screen.getByLabelText('Approved terms ID'),'operator-two')
  await userEvent.click(screen.getByRole('button',{ name:'Load operator-approved terms' }))
  await screen.findByText('Company records sample')
  expect(screen.getByText('Background research sample')).toBeVisible()
  await userEvent.click(screen.getByRole('button',{ name:'Use these approved terms in my draft' }))
  await userEvent.click(screen.getByRole('button',{ name:'Review spending limits' }))
  expect(await screen.findByRole('heading',{ name:'Proposed spending mandate' })).toBeVisible()
  expect(screen.getByTestId('two-source-sum')).toHaveTextContent('23')
  expect(screen.getByText(/Operating float, storage and network costs are not exposed by this preview/)).toBeVisible()
  expect(h.requests.some(r => r.path === '/api/public/jobs')).toBe(false)
})
test('v2 consumer results render second order and evidence-linked limits/advice, not primary alias only', async () => {
  const v = twoView(); deliver(v,0); deliver(v,1); v.run = { stage:'COMPLETE',report:report(v,true) }
  const authSnapshot = { principal,busy:false,error:null }, auth: any = { subscribe:() => () => {},getSnapshot:() => authSnapshot,resume:async () => {} }
  const snapshot = { view:v,busy:false,error:null,config }, controller: any = { subscribe:() => () => {},getSnapshot:() => snapshot,resume:async () => {},ownerApprovalAvailable:false }
  render(<PublicTestnetWorkspace auth={auth} controller={controller} />)
  expect(screen.getByText('Shared purchase cap · yoctoNEAR')).toBeVisible()
  expect(screen.getByRole('region',{ name:'Background research source' })).toBeVisible()
  await userEvent.click(within(screen.getByRole('region',{ name:'Background research source' })).getByText('Evidence and purchase receipt'))
  expect(within(screen.getByRole('region',{ name:'Background research source' })).getByText('proof-1')).toBeVisible()
  expect(screen.getByText('Compare the two sources for consistency; agreement does not verify accuracy.')).toBeVisible()
  expect(screen.getByText('Source accuracy has not been verified.')).toBeVisible()
  expect(screen.getByRole('heading',{ name:'Next check' })).toBeVisible()
})
for (const configured of [false,true]) test(`v2 creation requires authoritative separate cost review (${configured}) before wallet control`, async () => {
  const v = twoView(); v.job.ownerCreationRequired = true
  if (configured) v.ownerApproval = { manifestId:v.job.manifestId, jobId:v.job.jobId, ownerId:principal.accountId, mandateId:'mandate.testnet', actions: { create: { network:'testnet',owner:principal.accountId,mandate:'mandate.testnet',kind:'create',cap:'30',allowlist:v.job.scope.vendorIds,deadline_ns:String(BigInt(Date.parse(v.job.scope.expiresAt))*1000000n),operating_float:'10',gas:'250000000000000' } } }
  const snap = { view:v,busy:false,error:null,config }, authSnapshot = { principal,busy:false,error:null }
  const approve = vi.fn(), controller: any = { subscribe:() => () => {},getSnapshot:() => snap,resume:async () => {},ownerApprovalAvailable:true,approve }, auth: any = { subscribe:() => () => {},getSnapshot:() => authSnapshot,resume:async () => {} }
  render(<PublicTestnetWorkspace auth={auth} controller={controller} />)
  const button = screen.getByRole('button',{ name:'Approve owner creation in wallet' })
  expect(button).toBeDisabled(); expect(approve).not.toHaveBeenCalled()
  if (configured) {
    expect(screen.getByTestId('creation-float')).toHaveTextContent('10')
    expect(screen.getByTestId('creation-deposit')).toHaveTextContent('40')
    await userEvent.click(screen.getByRole('button',{ name:'I reviewed creation costs' }))
    expect(button).toBeEnabled(); expect(approve).not.toHaveBeenCalled()
    await userEvent.click(button); expect(approve).toHaveBeenCalledExactlyOnceWith('create')
  } else expect(screen.getByText('Authoritative creation costs unavailable. Wallet creation is not ready.')).toBeVisible()
})
function withCosts(v = twoView()) {
  v.job.ownerCreationRequired = true
  v.ownerApproval = { manifestId:v.job.manifestId,jobId:v.job.jobId,ownerId:principal.accountId,mandateId:'mandate.testnet',actions:{create:{network:'testnet',owner:principal.accountId,mandate:'mandate.testnet',kind:'create',cap:'30',allowlist:v.job.scope.vendorIds,deadline_ns:String(BigInt(Date.parse(v.job.scope.expiresAt))*1000000n),operating_float:'10',gas:'250000000000000'}} }
  return v
}
for (const change of ['unreviewed','session','manifest','cost','missing'] as const) test(`controller fences creation costs: ${change}`, async () => {
  const h = harness(), v = withCosts(); h.setView(v)
  const wallet = { approve:vi.fn() }, reviewOwnerOperation = vi.fn()
  let p: any = principal
  const c = createPublicTestnetController({origin,approvedOrigin:origin,principal:() => p,storage:h.storage,transport:h.transport,wallet,reviewOwnerOperation})
  await c.resume(); await c.open('operator-two','admission-two')
  if (change !== 'unreviewed') await (c as any).reviewCreationCosts?.()
  if (change === 'session') p = {...principal,sessionId:'b'.repeat(64)}
  if (change === 'manifest') { v.job.manifestId = 'changed'; h.setView(v); await c.refresh() }
  if (change === 'cost') { v.ownerApproval.actions.create.operating_float = '11'; h.setView(v); await c.refresh() }
  if (change === 'missing') { v.ownerApproval = null; h.setView(v); await c.refresh() }
  const count = h.requests.length
  await c.approve('create')
  expect(h.requests.slice(count).filter(r => r.path.endsWith('/owner/prepare'))).toHaveLength(0)
  expect(c.getSnapshot().error).toBe('CREATION_COST_REVIEW_REQUIRED')
  expect(wallet.approve).not.toHaveBeenCalled(); expect(reviewOwnerOperation).not.toHaveBeenCalled()
})
test('returning to old session or terms does not resurrect creation-cost eligibility', async () => {
  const h=harness(), original=withCosts(); h.setView(original)
  const c=createPublicTestnetController({origin,approvedOrigin:origin,principal:()=>principal,storage:h.storage,transport:h.transport,reviewOwnerOperation:vi.fn()})
  await c.resume(); await c.open('operator-two','admission-two'); await c.reviewCreationCosts()
  const changed=structuredClone(original); changed.ownerApproval.actions.create.operating_float='11';h.setView(changed);await c.refresh()
  h.setView(original);await c.refresh();const count=h.requests.length;await c.approve('create')
  expect(c.getSnapshot().error).toBe('CREATION_COST_REVIEW_REQUIRED');expect(h.requests).toHaveLength(count)
})
test('creation-cost review is explicit and permits only a later create preparation', async () => {
  const h = harness(); h.setView(withCosts())
  const c = createPublicTestnetController({origin,approvedOrigin:origin,principal:() => principal,storage:h.storage,transport:h.transport,reviewOwnerOperation:vi.fn()})
  await c.resume(); await c.open('operator-two','admission-two'); const count = h.requests.length
  await (c as any).reviewCreationCosts?.()
  expect(h.requests).toHaveLength(count)
  await c.approve('create')
  expect(h.requests.at(-1)?.path).toMatch(/\/owner\/prepare$/)
})
export function report(v: any, complete = false): any {
  return { schemaVersion: 'haldir.report.two-source.v1', purpose: v.job.scope.purpose, output: v.job.scope.output, status: complete ? 'EVIDENCE_REVIEW_REQUIRED' : 'PARTIAL', supplierVerified: false, fictionalSample: true, qualification: v.job.qualification,
    purchases: v.orders.map((m: any) => ({ sourceId: m.sourceId, quoteId: m.order.quoteId, orderId: m.order.orderId, vendorId: m.order.quote.vendorId, amountAtomic: m.order.quote.amountAtomic, lifecycle: m.order.lifecycle, proofId: m.order.proof?.proofId ?? null, artifactId: m.order.artifact?.artifactId ?? null })),
    facts: v.orders.filter((m: any) => m.order.artifact).map((m: any) => ({ artifactId: m.order.artifact.artifactId, excerpt: m.order.artifact.content, sourceId: m.sourceId, quoteId: m.order.quoteId, orderId: m.order.orderId, vendorId: m.order.quote.vendorId, amountAtomic: m.order.quote.amountAtomic, proofId: m.order.proof.proofId, contentDigest: m.order.artifact.contentDigest, fictionalSample: true })),
    interpretations: complete ? [{ kind: 'COMPARE_SOURCE_CONSISTENCY', findingIndexes: [0,1] }] : [], limits: ['FICTIONAL_SAMPLE','SOURCE_ACCURACY_NOT_VERIFIED','NO_SIGNING_ASSURANCE', ...(!complete ? ['INCOMPLETE_EVIDENCE'] : [])], missing: complete ? [] : ['background-research:NOT_STARTED'], nextCheck: complete ? { code: 'COMPARE_SOURCES_WITH_CONTRACT', sourceId: null } : { code: 'RESUME_APPROVED_JOB', sourceId: 'background-research' }, ownerActions: { stop: 'OWNER_ACTION_REQUIRED', withdraw: 'OWNER_ACTION_REQUIRED', residual: 'NOT_OBSERVED' } }
}
for (const complete of [false,true]) test(`TS1 decodes source-bound ${complete ? 'review-required' : 'partial'} report without invented findings alias`, async () => {
  const h = harness(), v = twoView(); deliver(v,0); if (complete) deliver(v,1)
  v.run = { stage: complete ? 'COMPLETE' : 'PARTIAL', report: report(v,complete) }; h.setView(v)
  await h.client.resume(); await h.client.open('operator-two','admission-two')
  expect(h.client.getSnapshot().error).toBeNull(); expect(h.client.getSnapshot().view).toEqual(v)
})
for (const corruption of ['source-order','alias','sum','owner','proof-amount','proof-vendor','artifact-vendor','digest','duplicate-proof','payment-hash','extra-key']) test(`TS1 rejects ${corruption} while retaining last valid observation`, async () => {
  const h = harness(); await h.client.resume(); await h.client.open('operator-two','admission-two')
  const before = h.client.getSnapshot().view, v = twoView(); deliver(v,0); deliver(v,1)
  if (corruption === 'source-order') v.orders.reverse()
  if (corruption === 'alias') v.order = v.orders[1].order
  if (corruption === 'sum') v.job.scope.budgetAtomic = '22'
  if (corruption === 'owner') v.job.ownerId = 'foreign.testnet'
  if (corruption === 'proof-amount') v.orders[1].order.proof.amountAtomic = '1'
  if (corruption === 'proof-vendor') v.orders[1].order.proof.vendorId = 'foreign.testnet'
  if (corruption === 'artifact-vendor') v.orders[1].order.artifact.vendorId = 'foreign.testnet'
  if (corruption === 'digest') v.orders[1].order.artifact.content += 'tampered'
  if (corruption === 'duplicate-proof') v.orders[1].order.proof.proofId = v.orders[0].order.proof.proofId
  if (corruption === 'payment-hash') v.orders[1].payment.transactionHash = '3'.repeat(32)
  if (corruption === 'extra-key') v.trusted = true
  h.setView(v); await h.client.refresh()
  expect(h.client.getSnapshot().error).toBe('INVALID_PUBLIC_RESPONSE')
  expect(h.client.getSnapshot().view).toBe(before)
})
for (const change of ['scope','second-quote','manifest'] as const) test(`refresh cannot relabel admitted immutable terms: ${change}`,async()=>{
 const h=harness();await h.client.resume();await h.client.open('operator-two','admission-two');const before=h.client.getSnapshot().view
 const v=twoView();if(change==='scope')v.job.scope.purpose='Changed job';if(change==='second-quote')v.orders[1].order.quote.content='Changed second sample';if(change==='manifest')v.job.manifestId='changed'
 h.setView(v);await h.client.refresh();expect(h.client.getSnapshot().error).toBe('APPROVED_TERMS_CHANGED');expect(h.client.getSnapshot().view).toBe(before)
})
test('TS1 accepts separately bound delivered samples and preserves both digests', async () => {
  const h = harness(), v = twoView(); deliver(v,0); deliver(v,1); h.setView(v)
  await h.client.resume(); await h.client.open('operator-two','admission-two')
  expect(h.client.getSnapshot().error).toBeNull(); expect(h.client.getSnapshot().view).toEqual(v)
})
