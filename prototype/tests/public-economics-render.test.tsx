import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { PublicTaskContext } from '../src/integration/public-workspace'
import { createPublicTestnetController, type MandateEconomics } from '../src/integration/testnet'

const time = 1794564000000, origin = 'https://economics-fixture.invalid'
const principal = { sessionId: 'a'.repeat(64), accountId: 'owner.testnet', publicKey: 'ed25519:' + '1'.repeat(32), networkId: 'testnet', origin, recipient: 'economics-fixture.invalid', expiresAt: 1900000000000, authenticationOnly: true } as const
const deniedFetch = vi.fn(() => { throw new Error('UNEXPECTED_NETWORK') })
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(time); deniedFetch.mockClear(); vi.stubGlobal('fetch', deniedFetch) })
afterEach(() => { cleanup(); expect(deniedFetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers() })
function economics(): MandateEconomics {
  return { schemaVersion: 'haldir.mandate-economics.v1', state: 'known', networkId: 'testnet', ownerId: principal.accountId, mandateId: 'mandate.testnet', source: { rpcUrl: 'https://rpc.testnet.near.org', method: 'get_status', finality: 'final' }, observation: { blockHash: '11111111111111111111111111111111', blockHeight: 456, blockTimestampNs: String(BigInt(time - 1000) * 1000000n), observedAt: time }, amounts: { capAtomic: '30', spentAtomic: '8', reservedAtomic: '9', availableAtomic: '11', refundedAtomic: '2' }, reason: null }
}
// Test-owned whole response, admitted through the actual strict controller parser.
// No sibling test import, backend fixture, remote request or network fallback.
function fixture(): any {
  const scope = { networkId: 'testnet', mandateId: 'mandate.testnet', purpose: 'Fictional research', output: 'Evidence brief', budgetAtomic: '30', vendorIds: ['records.testnet', 'background.testnet'], expiresAt: '2026-11-16T18:00:00.123Z' }
  const orders = ['company-records', 'background-research'].map((sourceId, i) => {
    const quote = { networkId: 'testnet', mandateId: scope.mandateId, vendorId: scope.vendorIds[i], amountAtomic: i ? '9' : '8', orderId: 'order-' + i, content: 'Fictional sample ' + i }
    const quoteId = Buffer.from(JSON.stringify(['haldir-local-v1', quote.networkId, quote.mandateId, quote.orderId])).toString('base64url')
    return { sourceId, order: { jobId: 'job-economics', quoteId, orderId: quote.orderId, quote, lifecycle: 'PAYMENT_PENDING', proof: null, artifact: null, lastCheckCode: null }, payment: { status: 'NOT_STARTED', transactionHash: null } }
  })
  return { contractVersion: 'haldir.public.v2', job: { jobId: 'job-economics', ownerId: principal.accountId, scope, state: 'ACTIVE', qualification: 'PUBLIC_TESTNET_FICTIONAL_VENDOR', manifestId: 'manifest-economics', ownerCreationRequired: false, schemaVersion: 'haldir.job.two-source.v1', sourceRefs: orders.map(m => ({ sourceId: m.sourceId, quoteId: m.order.quoteId })) }, orders, order: orders[0].order, payment: orders[0].payment, run: null, ownerOperations: [], ownerApproval: null, disclosures: { vendorData: 'FICTIONAL_SAMPLE', supplierVerified: false, principalReturn: 'Free principal is not a refund.' }, economics: economics() }
}
async function parse(value = fixture()) {
  const values = new Map([[`haldir-public-job-v1:${origin}:${principal.accountId}`, 'job-economics']])
  const transport = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
    if (String(url) === origin + '/api/public/config') return Response.json({ contractVersion: 'haldir.public.v1', networkId: 'testnet', financialActions: false, missingConfiguration: [], vendorData: 'FICTIONAL_SAMPLE', maxRunMs: 20000 })
    if (String(url) === origin + '/api/public/jobs/job-economics') return Response.json(value)
    throw new Error('UNEXPECTED_FIXTURE_REQUEST')
  })
  const controller = createPublicTestnetController({ origin, approvedOrigin: origin, principal: () => principal, now: Date.now, storage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v) }, removeItem: k => { values.delete(k) } }, transport })
  await controller.resume()
  expect(controller.getSnapshot().error).toBeNull()
  expect(transport).toHaveBeenCalledTimes(2)
  return { view: controller.getSnapshot().view!, transport }
}
const spending = () => screen.getByRole('region', { name: 'Spending' })

test('mounted known economics shows literal spent, nonzero reserved, available and exact provenance', async () => {
  const { view, transport } = await parse()
  render(<PublicTaskContext view={view} />)
  const s = spending()
  expect(within(s).getByText('Spent · 8 yoctoNEAR')).toBeVisible()
  expect(within(s).getByText('Reserved · 9 yoctoNEAR')).toBeVisible()
  expect(within(s).getByText('Available · 11 yoctoNEAR')).toBeVisible()
  expect(s).toHaveTextContent('Known · Fresh observation')
  expect(s).toHaveTextContent('https://rpc.testnet.near.org · get_status · final · testnet')
  expect(s).toHaveTextContent('Block · 456 · 11111111111111111111111111111111')
  expect(s).toHaveTextContent(`Block timestamp · ${view.economics!.observation!.blockTimestampNs} ns`)
  expect(s).toHaveTextContent(`Observed at · ${time} ms since Unix epoch`)
  expect(s).toHaveTextContent('Purchase cap · 30 yoctoNEAR')
  expect(within(s).queryByRole('button')).toBeNull()
  expect(transport).toHaveBeenCalledTimes(2)
})

test('idle known observation becomes stale only after the exact 30-second block boundary without reads or polling', async () => {
  const { view, transport } = await parse()
  const original = structuredClone(view.economics)
  render(<PublicTaskContext view={view} />)
  act(() => { vi.advanceTimersByTime(29000) })
  expect(spending()).toHaveTextContent('Known · Fresh observation')
  act(() => { vi.advanceTimersByTime(1) })
  expect(spending()).toHaveTextContent('Stale · Last observed amounts')
  expect(spending()).toHaveTextContent('Last observed amounts only, not current spend permission.')
  expect(spending()).toHaveTextContent('Reserved · 9 yoctoNEAR')
  expect(spending()).toHaveTextContent(`Observed at · ${time} ms since Unix epoch`)
  expect(view.economics).toEqual(original)
  expect(transport).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

test('known expiry timer is released on unmount and replaced observation owns its own expiry', async () => {
  const { view } = await parse()
  const mounted = render(<PublicTaskContext view={view} />)
  expect(vi.getTimerCount()).toBe(1)
  act(() => { vi.advanceTimersByTime(10000) })
  const replacement = { ...view, economics: { ...view.economics!, observation: { ...view.economics!.observation!, blockTimestampNs: String(BigInt(Date.now()) * 1000000n), observedAt: Date.now() } } }
  mounted.rerender(<PublicTaskContext view={replacement} />)
  expect(vi.getTimerCount()).toBe(1)
  act(() => { vi.advanceTimersByTime(19001) })
  expect(spending()).toHaveTextContent('Known · Fresh observation')
  act(() => { vi.advanceTimersByTime(11000) })
  expect(spending()).toHaveTextContent('Stale · Last observed amounts')
  expect(vi.getTimerCount()).toBe(0)
  mounted.rerender(<PublicTaskContext view={{ ...view, economics: { ...replacement.economics, observation: { ...replacement.economics.observation, blockTimestampNs: String(BigInt(Date.now()) * 1000000n), observedAt: Date.now() } } }} />)
  expect(vi.getTimerCount()).toBe(1)
  mounted.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

for (const reason of ['RPC_UNAVAILABLE', 'BINDING_MISMATCH', 'NOT_DEPLOYED', 'NOT_CONFIGURED'] as const) test(`unavailable ${reason} shows no invented zero and preserves source`, async () => {
  const value = fixture()
  value.economics = { ...economics(), state: 'unavailable', reason, amounts: null, observation: null }
  const { view } = await parse(value)
  render(<PublicTaskContext view={view} />)
  expect(spending()).toHaveTextContent('Unavailable · No authoritative amounts')
  for (const label of ['Spent', 'Reserved', 'Available']) expect(within(spending()).getByText(`${label} · Unavailable`)).toBeVisible()
  expect(spending()).toHaveTextContent(`Reason · ${reason}`)
  expect(spending()).toHaveTextContent('Source · https://rpc.testnet.near.org · get_status · final · testnet')
  expect(within(spending()).queryByText(/^(Spent|Reserved|Available) · 0 yoctoNEAR$/)).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

test('old server with no economics retains approved cap but amounts are unavailable, not zero', async () => {
  const value = fixture(); delete value.economics
  const { view } = await parse(value)
  render(<PublicTaskContext view={view} />)
  expect(spending()).toHaveTextContent('Purchase cap · 30 yoctoNEAR')
  expect(spending()).toHaveTextContent('Spent · UnavailableReserved · UnavailableAvailable · Unavailable')
  expect(within(spending()).queryByText(/^(Spent|Reserved|Available) · 0 yoctoNEAR$/)).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

test('server stale amounts remain last observed with immutable block and observation timestamps', async () => {
  const value = fixture()
  value.economics.state = 'stale'; value.economics.reason = 'STALE_BLOCK'
  value.economics.observation.blockTimestampNs = String(BigInt(time - 31000) * 1000000n)
  const { view } = await parse(value)
  render(<PublicTaskContext view={view} />)
  act(() => { vi.advanceTimersByTime(90000) })
  expect(spending()).toHaveTextContent('Stale · Last observed amounts')
  expect(spending()).toHaveTextContent('Spent · 8 yoctoNEARReserved · 9 yoctoNEARAvailable · 11 yoctoNEAR')
  expect(spending()).toHaveTextContent(`Block timestamp · ${value.economics.observation.blockTimestampNs} ns`)
  expect(spending()).toHaveTextContent(`Observed at · ${time} ms since Unix epoch`)
  expect(vi.getTimerCount()).toBe(0)
})

for (const retained of [true, false]) test(`withdraw UNKNOWN preserves uncertainty with ${retained ? 'retained' : 'absent'} observations, never a refund`, async () => {
  const value = fixture()
  value.economics = { ...economics(), state: 'uncertain', reason: 'OPERATION_UNCERTAIN', ...(retained ? {} : { observation: null, amounts: null }) }
  value.ownerOperations = [{ operationId: 'b'.repeat(64), action: 'withdraw', status: 'UNKNOWN', request: null, transactionHash: null, signerId: principal.accountId, receipt: null }]
  const { view } = await parse(value)
  render(<PublicTaskContext view={view} />)
  act(() => { vi.advanceTimersByTime(90000) })
  expect(spending()).toHaveTextContent('Uncertain · Observations only')
  expect(spending()).toHaveTextContent('Reason · OPERATION_UNCERTAIN')
  expect(spending()).toHaveTextContent(retained ? 'Available · 11 yoctoNEAR' : 'Available · Unavailable')
  expect(spending()).not.toHaveTextContent(/Recovered|Returned|Refunded|2 yoctoNEAR/)
  expect(screen.getByRole('region', { name: 'Activity' })).toHaveTextContent('Owner withdrawal · UNKNOWN')
  expect(view.ownerOperations[0].receipt).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

for (const state of ['unavailable', 'uncertain'] as const) test(`replacement ${state} cancels known expiry and keeps priority`, async () => {
  const { view } = await parse()
  const mounted = render(<PublicTaskContext view={view} />)
  expect(vi.getTimerCount()).toBe(1)
  const e: MandateEconomics = { ...economics(), state, reason: state === 'uncertain' ? 'OPERATION_UNCERTAIN' : 'RPC_UNAVAILABLE', ...(state === 'unavailable' ? { observation: null, amounts: null } : {}) }
  mounted.rerender(<PublicTaskContext view={{ ...view, economics: e }} />)
  expect(vi.getTimerCount()).toBe(0)
  act(() => { vi.advanceTimersByTime(90000) })
  expect(spending()).toHaveTextContent(state === 'uncertain' ? 'Uncertain · Observations only' : 'Unavailable · No authoritative amounts')
})

test('large literal atomic decimals are not converted to Number or inferred from quotes', async () => {
  const value = fixture()
  value.job.scope.budgetAtomic = '100000000000000000000000000000000000'
  value.economics.amounts = { capAtomic: value.job.scope.budgetAtomic, spentAtomic: '9007199254740993', reservedAtomic: '9007199254740995', availableAtomic: '99999999999999999981985601490518012', refundedAtomic: '0' }
  const { view } = await parse(value)
  render(<PublicTaskContext view={view} />)
  expect(spending()).toHaveTextContent('Spent · 9007199254740993 yoctoNEAR')
  expect(spending()).toHaveTextContent('Reserved · 9007199254740995 yoctoNEAR')
  expect(spending()).toHaveTextContent('Available · 99999999999999999981985601490518012 yoctoNEAR')
})

test('submillisecond block timestamp expires at the first integral millisecond beyond its window', async () => {
  const value = fixture()
  value.economics.observation.blockTimestampNs = String(BigInt(time - 1000) * 1000000n + 999999n)
  const { view } = await parse(value)
  render(<PublicTaskContext view={view} />)
  act(() => { vi.advanceTimersByTime(29000) })
  expect(spending()).toHaveTextContent('Known · Fresh observation')
  act(() => { vi.advanceTimersByTime(1) })
  expect(spending()).toHaveTextContent('Stale · Last observed amounts')
  expect(vi.getTimerCount()).toBe(0)
})
