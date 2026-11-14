import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PublicReport } from '../src/integration/public-workspace'
import { createPublicTestnetController, type PublicReportV2 } from '../src/integration/testnet'

const origin = 'https://report-fixture.invalid'
const principal = { sessionId: 'a'.repeat(64), accountId: 'owner.testnet', publicKey: 'ed25519:' + '1'.repeat(32), networkId: 'testnet', origin, recipient: 'report-fixture.invalid', expiresAt: 1900000000000, authenticationOnly: true } as const
const deniedFetch = vi.fn(() => { throw new Error('UNEXPECTED_NETWORK') })
beforeEach(() => { deniedFetch.mockClear(); vi.stubGlobal('fetch', deniedFetch) })
afterEach(() => { expect(deniedFetch).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

// Finite test-owned documents; no backend fixture import or network fallback.
function fixture(partial = false) {
  const scope = { networkId: 'testnet', mandateId: 'mandate.testnet', purpose: 'Review fictional supplier', output: 'Evidence-linked brief', budgetAtomic: '30', vendorIds: ['records.testnet', 'background.testnet'], expiresAt: '2026-11-16T18:00:00.123Z' }
  const documents = [['FICTIONAL SAMPLE: Company name supplied.', 'Registration supplied.'], ['FICTIONAL SAMPLE: Background name supplied.', 'Certification not documented.']]
  const orders = (['company-records', 'background-research'] as const).map((sourceId, i) => {
    const quote = { networkId: 'testnet', mandateId: scope.mandateId, vendorId: scope.vendorIds[i], amountAtomic: i ? '15' : '8', orderId: `order-${i}`, content: `Fictional source ${i}` }
    const quoteId = Buffer.from(JSON.stringify(['haldir-local-v1', quote.networkId, quote.mandateId, quote.orderId])).toString('base64url')
    const content = documents[i].join('\n'), delivered = !partial || i === 0
    const proof = delivered ? { proofId: `proof-${i}`, transactionHash: String(i + 1).repeat(32), networkId: 'testnet', mandateId: scope.mandateId, orderId: quote.orderId, vendorId: quote.vendorId, amountAtomic: quote.amountAtomic } : null
    const artifact = delivered ? { artifactId: 'fictional:' + quoteId, orderId: quote.orderId, vendorId: quote.vendorId, fictionalSample: true, qualification: 'FICTIONAL_SAMPLE', mediaType: 'text/plain', content, contentDigest: createHash('sha256').update(content).digest('hex') } : null
    return { sourceId, order: { jobId: 'job-report', quoteId, orderId: quote.orderId, quote, lifecycle: delivered ? 'DELIVERED' : 'PAYMENT_PENDING', proof, artifact, lastCheckCode: null }, payment: { status: delivered ? 'SUBMITTED' : 'NOT_STARTED', transactionHash: proof?.transactionHash ?? null } }
  })
  // Deliberately interleaved facts: reference positions are not source positions.
  const facts = [0, 1].flatMap(line => orders.flatMap((m, i) => m.order.artifact && m.order.proof ? [{ artifactId: m.order.artifact.artifactId, excerpt: documents[i][line], sourceId: m.sourceId, quoteId: m.order.quoteId, orderId: m.order.orderId, vendorId: m.order.quote.vendorId, amountAtomic: m.order.quote.amountAtomic, proofId: m.order.proof.proofId, contentDigest: m.order.artifact.contentDigest, fictionalSample: true as const }] : []))
  const report: PublicReportV2 = { schemaVersion: 'haldir.report.two-source.v1', purpose: scope.purpose, output: scope.output, status: partial ? 'PARTIAL' : 'EVIDENCE_REVIEW_REQUIRED', supplierVerified: false, fictionalSample: true, qualification: 'PUBLIC_TESTNET_FICTIONAL_VENDOR', purchases: orders.map(m => ({ sourceId: m.sourceId, quoteId: m.order.quoteId, orderId: m.order.orderId, vendorId: m.order.quote.vendorId, amountAtomic: m.order.quote.amountAtomic, lifecycle: m.order.lifecycle, proofId: m.order.proof?.proofId ?? null, artifactId: m.order.artifact?.artifactId ?? null })), facts,
    interpretations: partial ? [] : [{ kind: 'COMPARE_COMPANY_DETAILS', findingIndexes: [2, 0] }, { kind: 'COMPARE_SOURCE_CONSISTENCY', findingIndexes: [3, 0] }], limits: ['FICTIONAL_SAMPLE', 'SOURCE_ACCURACY_NOT_VERIFIED', 'NO_SIGNING_ASSURANCE', ...(partial ? ['INCOMPLETE_EVIDENCE'] : [])], missing: partial ? ['background-research:NOT_STARTED'] : [], nextCheck: { code: partial ? 'RESUME_APPROVED_JOB' : 'COMPARE_SOURCES_WITH_CONTRACT', sourceId: partial ? 'background-research' : null }, ownerActions: { stop: 'OWNER_ACTION_REQUIRED', withdraw: 'OWNER_ACTION_REQUIRED', residual: 'NOT_OBSERVED' } }
  return { contractVersion: 'haldir.public.v2', job: { jobId: 'job-report', ownerId: principal.accountId, scope, state: 'ACTIVE', qualification: 'PUBLIC_TESTNET_FICTIONAL_VENDOR', manifestId: 'manifest-report', ownerCreationRequired: false, schemaVersion: 'haldir.job.two-source.v1', sourceRefs: orders.map(m => ({ sourceId: m.sourceId, quoteId: m.order.quoteId })) }, orders, order: orders[0].order, payment: orders[0].payment, run: { stage: partial ? 'PARTIAL' : 'COMPLETE', report }, ownerOperations: [], ownerApproval: null, disclosures: { vendorData: 'FICTIONAL_SAMPLE', supplierVerified: false, principalReturn: 'Free balance is not a refund.' } }
}

async function parseFixture(value = fixture()) {
  const storage = new Map<string, string>()
  const transport = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(url)).pathname
    if (String(url) !== origin + path) throw new Error('UNEXPECTED_ORIGIN')
    if (path === '/api/public/config') return Response.json({ contractVersion: 'haldir.public.v1', networkId: 'testnet', financialActions: false, missingConfiguration: [], vendorData: 'FICTIONAL_SAMPLE', maxRunMs: 15000 })
    if (path === '/api/public/jobs/job-report') return Response.json(value)
    throw new Error('UNEXPECTED_FIXTURE_REQUEST')
  })
  storage.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, 'job-report')
  const controller = createPublicTestnetController({ origin, approvedOrigin: origin, principal: () => principal, now: () => 1800000000000, storage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v) }, removeItem: k => { storage.delete(k) } }, transport })
  await controller.resume()
  expect(transport.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/public/config', '/api/public/jobs/job-report'])
  return controller.getSnapshot()
}

test('each advisory links only its exact validated nonconsecutive facts and their evidence', async () => {
  const snapshot = await parseFixture()
  expect(snapshot.error).toBeNull()
  const report = snapshot.view!.run!.report as PublicReportV2
  render(<PublicReport report={report} />)
  const article = screen.getByRole('article', { name: 'Source-linked report' })
  const advisories = ['Compare the supplied company details with the contract', 'Compare the two sources for consistency; agreement does not verify accuracy.']
  for (const [advisoryIndex, copy] of advisories.entries()) {
    const advisory = within(article).getByText(copy).parentElement!
    const links = within(advisory).getAllByRole('link')
    expect(links.map(link => link.textContent)).toEqual(report.interpretations[advisoryIndex].findingIndexes.map(i => `Evidence ${i + 1}`))
    for (const [linkIndex, link] of links.entries()) {
      expect(link.tagName).toBe('A')
      const href = link.getAttribute('href')!
      expect(href).toMatch(/^#.+/)
      const target = document.getElementById(href.slice(1))!
      expect(article).toContainElement(target)
      expect(target).toHaveAttribute('tabindex', '-1')
      const fact = report.facts[report.interpretations[advisoryIndex].findingIndexes[linkIndex]]
      expect(within(target).getByRole('blockquote')).toHaveTextContent(fact.excerpt)
      expect(target).toHaveTextContent(`${fact.amountAtomic} yoctoNEAR`)
      expect(target).toHaveTextContent(fact.vendorId)
      const disclosure = within(target).getByText('Linked evidence').closest('details')!
      if (!disclosure.open) await userEvent.click(within(target).getByText('Linked evidence'))
      expect(disclosure).toHaveAttribute('open')
      for (const value of [fact.artifactId, fact.orderId, fact.proofId, fact.contentDigest]) expect(disclosure).toHaveTextContent(value)
    }
  }
  // Native anchors remain in sequential keyboard navigation; no custom click handler.
  const firstLink = within(article).getAllByRole('link')[0]
  ;(within(article).getAllByText('Linked evidence').at(-1) as HTMLElement).focus()
  await userEvent.tab()
  expect(firstLink).toHaveFocus()
  expect(article).toHaveTextContent('Source accuracy has not been verified.')
  expect(article).toHaveTextContent('Returned principal is established only by a separate confirmed withdrawal receipt.')
})

test('partial fallback preserves retained evidence and the same-job next check with readable missing evidence', async () => {
  const snapshot = await parseFixture(fixture(true))
  expect(snapshot.error).toBeNull()
  render(<PublicReport report={snapshot.view!.run!.report as PublicReportV2} />)
  const article = screen.getByRole('article', { name: 'Source-linked report' })
  expect(article).toHaveTextContent('Partial brief · PARTIAL')
  expect(article).toHaveTextContent('Background research · Not started')
  expect(article).toHaveTextContent('Evidence is incomplete; this is a partial brief.')
  expect(article).toHaveTextContent('Explicitly resume the same approved job when ready.')
  expect(within(article).getAllByRole('blockquote')).toHaveLength(2)
  expect(within(article).queryByRole('link')).toBeNull()
  await userEvent.click(within(article).getAllByText('Linked evidence')[0])
  expect(within(article).getAllByText(/Artifact:/)[0]).toBeVisible()
})

for (const [code, copy] of [
  ['PAYMENT_EVIDENCE_UNAVAILABLE', 'Payment evidence unavailable'],
  ['DELIVERY_EVIDENCE_UNAVAILABLE', 'Delivery evidence unavailable'],
  ['OWNER_STOPPED', 'Owner stopped the job'],
  ['DEADLINE_EXPIRED', 'Permission expired'],
] as const) test(`known missing reason remains source-bound: ${code}`, async () => {
  const value = fixture(true)
  value.run.report.missing = [`background-research:${code}`]
  const snapshot = await parseFixture(value)
  expect(snapshot.error).toBeNull()
  render(<PublicReport report={snapshot.view!.run!.report as PublicReportV2} />)
  expect(screen.getByRole('article')).toHaveTextContent(`Background research · ${copy}`)
})

for (const [code, copy] of [['MODEL_REPORT_UNAVAILABLE', 'Full report unavailable'], ['MODEL_REPORT_PENDING', 'Full report pending']] as const) test(`report fallback keeps existing evidence and no-repurchase next check: ${code}`, async () => {
  const value = fixture()
  value.run.stage = 'PARTIAL'
  value.run.report.status = 'PARTIAL'
  value.run.report.interpretations = []
  value.run.report.missing = [code]
  if (code === 'MODEL_REPORT_UNAVAILABLE') value.run.report.limits.push(code)
  value.run.report.nextCheck = { code: 'REVIEW_REPORT_AVAILABILITY', sourceId: null }
  const snapshot = await parseFixture(value)
  expect(snapshot.error).toBeNull()
  render(<PublicReport report={snapshot.view!.run!.report as PublicReportV2} />)
  const article = screen.getByRole('article')
  expect(within(article).getByText(copy, { exact: true })).toBeVisible()
  expect(article).toHaveTextContent('Review report availability; do not repeat purchases.')
  expect(within(article).getAllByRole('blockquote')).toHaveLength(4)
  expect(within(article).queryByRole('link')).toBeNull()
})

for (const reason of ['opaque-fixture-reason', 'constructor', 'background-research:constructor', 'foreign-source:NOT_STARTED', 'background-research:NOT_STARTED:extra']) test(`unrecognized missing evidence is retained literally, not guessed: ${reason}`, async () => {
  const value = fixture(true)
  value.run.report.missing = [reason]
  const snapshot = await parseFixture(value)
  expect(snapshot.error).toBeNull()
  render(<PublicReport report={snapshot.view!.run!.report as PublicReportV2} />)
  expect(screen.getByRole('article')).toHaveTextContent(reason)
})

for (const indexes of [[-1], [4], [0.5], [0, 0]]) test(`parser still rejects invalid finding indexes ${JSON.stringify(indexes)}`, async () => {
  const value = fixture()
  value.run.report.interpretations[0].findingIndexes = indexes
  const snapshot = await parseFixture(value)
  expect(snapshot.error).toBe('INVALID_PUBLIC_RESPONSE')
  expect(snapshot.view).toBeNull()
})

test('separately mounted reports do not cross-link their source evidence', async () => {
  const snapshot = await parseFixture()
  expect(snapshot.error).toBeNull()
  const report = snapshot.view!.run!.report as PublicReportV2
  render(<><PublicReport report={report} /><PublicReport report={report} /></>)
  const reports = screen.getAllByRole('article', { name: 'Source-linked report' })
  for (const article of reports) for (const link of within(article).getAllByRole('link')) {
    const target = document.getElementById(link.getAttribute('href')!.slice(1))!
    expect(article).toContainElement(target)
    expect(reports.find(other => other !== article)).not.toContainElement(target)
  }
})
