import { afterEach, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../src/App'
import { createLocalJourney } from '../src/integration/local-journey'

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); window.localStorage.clear() })

// Response fixtures characterize the frozen HTTP shape; authority lives in the
// real server harness, exercised separately by local-journey-ui.test.mjs.
const job = { jobId: 'local-job', quoteId: 'local-quote', ownerId: 'alice.testnet', state: 'LOCAL_ACTIVE', qualification: 'LOCAL_SYNTHETIC_ONLY', scope: { purpose: 'Local sample', output: 'Fictional artifact' } }
const pending = { jobId: job.jobId, quoteId: job.quoteId, orderId: 'local-order', quote: { content: 'Fictional sample', vendorId: 'vendor.testnet', amountAtomic: '3' }, lifecycle: 'PAYMENT_PENDING', proof: null, artifact: null, lastCheckCode: null }

test('opening and checking use exact HTTP bodies; unknown evidence stays pending on the original job', async () => {
  vi.stubGlobal('location', new URL('http://127.0.0.1:5199/?mode=local-qualification'))
  const requests: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    const response = url.endsWith('/api/jobs') ? job : url.endsWith('/check') ? { ...pending, lastCheckCode: 'EVIDENCE_UNAVAILABLE' } : pending
    return { ok: true, json: async () => response }
  }))
  render(<App />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Open approved local job' }))
  expect(await screen.findByText('PAYMENT_PENDING')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Check local receipt' }))
  expect(await screen.findByText('EVIDENCE_UNAVAILABLE')).toBeVisible()
  expect(screen.getByText('PAYMENT_PENDING')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Retrieve same local delivery' })).toBeDisabled()
  expect(requests.map(r => [r.url, r.init.method, r.init.body])).toEqual([
    ['http://127.0.0.1:5199/api/jobs', 'POST', JSON.stringify({ approvalId: 'local-ui-v1', admissionKey: 'local-ui-v1' })],
    ['http://127.0.0.1:5199/api/jobs/local-job/order', 'GET', undefined],
    ['http://127.0.0.1:5199/api/jobs/local-job/order/check', 'POST', '{}'],
  ])
})

test('nonliteral or nonloopback origins fail closed before transport, including localhost and HTTPS', async () => {
  for (const origin of ['https://example.invalid', 'http://localhost:5199', 'http://127.0.0.2:5199', 'https://127.0.0.1:5199']) {
    const transport = vi.fn()
    const controller = createLocalJourney({ origin, storage: window.localStorage, transport })
    await controller.open()
    expect(controller.getSnapshot().error).toBe('LOOPBACK_ONLY')
    expect(transport).not.toHaveBeenCalled()
  }
})

test('failed status read retains evidence and saved job; retry never readmits or invents proof', async () => {
  let fail = false
  const transport = vi.fn(async (url: string | URL | Request) => {
    if (fail) throw new Error('Synthetic local outage')
    return { ok: true, json: async () => String(url).endsWith('/order') ? pending : job } as Response
  })
  const controller = createLocalJourney({ origin: 'http://127.0.0.1:5199', storage: window.localStorage, transport })
  await controller.open()
  const before = controller.getSnapshot()
  fail = true
  await controller.open()
  expect(controller.getSnapshot().order).toEqual(before.order)
  expect(controller.getSnapshot().error).toBe('Synthetic local outage')
  fail = false
  await controller.open()
  expect(transport.mock.calls.filter(([url]) => String(url).endsWith('/api/jobs'))).toHaveLength(1)
  expect(controller.getSnapshot().order?.proof).toBe(null)
  expect(controller.getSnapshot().error).toBe(null)
})

test('wrong job response and paid-without-proof are rejected without replacing observed evidence', async () => {
  let invalid = false
  const transport = vi.fn(async (url: string | URL | Request) => ({ ok: true, json: async () =>
    String(url).endsWith('/order/check') ? { ...pending, lifecycle: 'PAID_NOT_DELIVERED' } :
    String(url).endsWith('/order') ? pending : invalid ? { ...job, jobId: 'different-job' } : job } as Response))
  const controller = createLocalJourney({ origin: 'http://127.0.0.1:5199', storage: window.localStorage, transport })
  await controller.open()
  await controller.check()
  expect(controller.getSnapshot().error).toBe('INVALID_LOCAL_RESPONSE')
  expect(controller.getSnapshot().order).toEqual(pending)
  invalid = true
  await controller.open()
  expect(controller.getSnapshot().error).toBe('INVALID_LOCAL_RESPONSE')
  expect(controller.getSnapshot().job?.jobId).toBe(job.jobId)
})

test('authenticated local NOT_FOUND clears only the stale identity and retries the original admission once', async () => {
  const origin = 'http://127.0.0.1:5199'
  const key = `haldir-local-ui-v1:${origin}`
  window.localStorage.setItem(key, 'stale-job')
  const requests: [string, string | undefined, string | null | undefined][] = []
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push([String(url), init?.method, init?.body as string | undefined])
    if (String(url).endsWith('/stale-job')) return new Response(JSON.stringify({ error: 'NOT_FOUND', qualification: 'LOCAL_SYNTHETIC_ONLY' }), { status: 404 })
    if (String(url).endsWith('/api/jobs')) expect(window.localStorage.getItem(key)).toBe(null)
    return new Response(JSON.stringify(String(url).endsWith('/order') ? pending : job))
  })
  const controller = createLocalJourney({ origin, storage: window.localStorage, transport })
  await controller.resume()
  expect(controller.getSnapshot()).toEqual({ job, order: pending, busy: false, error: null })
  expect(window.localStorage.getItem(key)).toBe(job.jobId)
  expect(requests).toEqual([
    [origin + '/api/jobs/stale-job', 'GET', undefined],
    [origin + '/api/jobs', 'POST', JSON.stringify({ approvalId: 'local-ui-v1', admissionKey: 'local-ui-v1' })],
    [origin + '/api/jobs/local-job/order', 'GET', undefined],
  ])
  await controller.open()
  expect(requests.slice(3).map(([url, method]) => [url, method])).toEqual([
    [origin + '/api/jobs/local-job', 'GET'], [origin + '/api/jobs/local-job/order', 'GET'],
  ])
})

test.each([
  ['unauthenticated', 401, { error: 'NOT_FOUND', qualification: 'LOCAL_SYNTHETIC_ONLY' }],
  ['forbidden', 403, { error: 'NOT_FOUND', qualification: 'LOCAL_SYNTHETIC_ONLY' }],
  ['internal error', 500, { error: 'NOT_FOUND', qualification: 'LOCAL_SYNTHETIC_ONLY' }],
  ['unqualified 404', 404, { error: 'NOT_FOUND' }],
  ['foreign qualification', 404, { error: 'NOT_FOUND', qualification: 'TESTNET' }],
  ['unknown code', 404, { error: 'UNKNOWN', qualification: 'LOCAL_SYNTHETIC_ONLY' }],
  ['unknown shape', 404, { message: 'NOT_FOUND', qualification: 'LOCAL_SYNTHETIC_ONLY' }],
  ['malformed JSON', 404, null],
  ['network failure', 0, null],
  ['timeout', -1, null],
] as const)('saved job %s never clears identity, readmits or discards observed evidence', async (_name, status, data) => {
  const origin = 'http://127.0.0.1:5199'
  const key = `haldir-local-ui-v1:${origin}`
  let failing = false
  const transport = vi.fn(async (url: string | URL | Request) => {
    if (failing) {
      if (status === 0) throw new Error('NOT_FOUND')
      if (status === -1) throw new DOMException('Timeout', 'TimeoutError')
      return new Response(data === null ? 'invalid-json' : JSON.stringify(data), { status })
    }
    return new Response(JSON.stringify(String(url).endsWith('/order') ? pending : job))
  })
  const controller = createLocalJourney({ origin, storage: window.localStorage, transport })
  await controller.open()
  const before = controller.getSnapshot()
  failing = true
  transport.mockClear()
  await controller.resume()
  await controller.open()
  expect(transport.mock.calls.map(([url]) => String(url))).toEqual([origin + '/api/jobs/local-job', origin + '/api/jobs/local-job'])
  expect(window.localStorage.getItem(key)).toBe(job.jobId)
  expect(controller.getSnapshot().job).toEqual(before.job)
  expect(controller.getSnapshot().order).toEqual(before.order)
  expect(controller.getSnapshot().error).not.toBe(null)
  expect(controller.getSnapshot().busy).toBe(false)
})

test('a repeated NOT_FOUND during admission ends recovery without a retry loop', async () => {
  const origin = 'http://127.0.0.1:5199'
  const key = `haldir-local-ui-v1:${origin}`
  window.localStorage.setItem(key, 'stale-job')
  const transport = vi.fn(async () => new Response(JSON.stringify({ error: 'NOT_FOUND', qualification: 'LOCAL_SYNTHETIC_ONLY' }), { status: 404 }))
  const controller = createLocalJourney({ origin, storage: window.localStorage, transport })
  await controller.open()
  expect(transport).toHaveBeenCalledTimes(2)
  expect(window.localStorage.getItem(key)).toBe(null)
  expect(controller.getSnapshot()).toEqual({ job: null, order: null, busy: false, error: 'NOT_FOUND' })
  await controller.resume()
  expect(transport).toHaveBeenCalledTimes(2)
})

test('order NOT_FOUND retains its admitted identity without a second admission', async () => {
  const origin = 'http://127.0.0.1:5199'
  const key = `haldir-local-ui-v1:${origin}`
  window.localStorage.setItem(key, 'stale-job')
  const missing = () => new Response(JSON.stringify({ error: 'NOT_FOUND', qualification: 'LOCAL_SYNTHETIC_ONLY' }), { status: 404 })
  const transport = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/stale-job') || String(url).endsWith('/order') ? missing() : new Response(JSON.stringify(job)))
  const controller = createLocalJourney({ origin, storage: window.localStorage, transport })
  await controller.open()
  expect(transport).toHaveBeenCalledTimes(3)
  expect(window.localStorage.getItem(key)).toBe(job.jobId)
  expect(controller.getSnapshot()).toEqual({ job, order: null, busy: false, error: 'NOT_FOUND' })
  await controller.resume()
  expect(transport).toHaveBeenCalledTimes(5)
  expect(transport.mock.calls.filter(([url]) => String(url).endsWith('/api/jobs'))).toHaveLength(1)
  expect(window.localStorage.getItem(key)).toBe(job.jobId)
})

test('explicit local mode discloses synthetic authority and separates backend controls from simulation', () => {
  window.history.replaceState({}, '', '/?mode=local-qualification')
  render(<App />)
  expect(screen.getByRole('region', { name: 'Preview notice' })).toHaveTextContent('LOCAL backend')
  expect(screen.getByText(/Synthetic identity, synthetic receipts and fictional sample data/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Open approved local job' })).toBeVisible()
  expect(screen.queryByText('Demo controls', { exact: true })).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'Your message' })).not.toBeInTheDocument()
})
