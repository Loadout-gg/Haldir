import { expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
const ownerIdFor = (action: string, jobId = 'job-1') => createHash('sha256').update(JSON.stringify(['haldir-owner-v1', jobId, action])).digest('hex')
const generation = '12345678-1234-4234-8234-123456789abc'
import { createPublicTestnetController } from '../src/integration/testnet'
const origin = 'https://approved.invalid'
const principal = { sessionId: 'a'.repeat(64), accountId: 'owner.testnet', publicKey: 'ed25519:' + '1'.repeat(32), networkId: 'testnet', origin, recipient: 'approved.invalid', expiresAt: 1900000000000, authenticationOnly: true } as const
const config = { contractVersion: 'haldir.public.v1', networkId: 'testnet', financialActions: true, missingConfiguration: [], vendorData: 'FICTIONAL_SAMPLE', maxRunMs: 15000 }
const view = () => ({ contractVersion: 'haldir.public.v1',
  job: { jobId: 'job-1', ownerId: principal.accountId, scope: { purpose: 'Review fictional supplier', output: 'Evidence-linked report', budgetAtomic: '1000000000000000000000000' }, state: 'ACTIVE', qualification: 'PUBLIC_TESTNET_FICTIONAL_VENDOR', manifestId: 'manifest-1' },
  order: { jobId: 'job-1', orderId: 'quote-1', quote: { amountAtomic: '123456789012345678901234', vendorId: 'vendor.testnet' }, lifecycle: 'PAYMENT_PENDING', proof: null, artifact: null },
  payment: { status: 'ATTENTION_REQUIRED', transactionHash: null }, run: null, ownerOperations: [],
  disclosures: { vendorData: 'FICTIONAL_SAMPLE', supplierVerified: false, principalReturn: 'Only a confirmed withdraw receipt establishes returned principal; free balance is not a refund' } })
function setup(overrides: Record<string, unknown> = {}) {
  const values = new Map<string, string>(), requests: { path: string; body: unknown; init: RequestInit }[] = []
  let current: any = view(), currentConfig: any = config
  const transport = vi.fn(async (url: any, init: any) => {
    const path = new URL(url).pathname; requests.push({ path, body: init.body ? JSON.parse(init.body) : null, init })
    return Response.json(path === '/api/public/config' ? currentConfig : current)
  })
  const options: any = { origin, approvedOrigin: origin, principal: () => principal,
    storage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v) }, removeItem: (k: string) => { values.delete(k) } }, transport, ...overrides }
  return { options, values, requests, transport, setConfig: (v: any) => { currentConfig = v }, setView: (v: any) => { current = v }, client: createPublicTestnetController(options) }
}
test('public controller consumes frozen routes with session cookie/CSRF, exact atomic amounts, persists and reloads same job without wallet', async () => {
  const h = setup()
  await h.client.resume()
  expect(h.client.getSnapshot().config).toEqual(config)
  expect(h.requests.map(x => x.path)).toEqual(['/api/public/config'])
  await h.client.open('approved-terms-1', 'admission-1')
  expect(h.client.getSnapshot().view).toEqual(view())
  expect(h.requests.at(-1)?.body).toEqual({ approvalId: 'approved-terms-1', admissionKey: 'admission-1' })
  const reloaded = createPublicTestnetController(h.options)
  await reloaded.resume()
  expect(reloaded.getSnapshot().view?.job.jobId).toBe('job-1')
  expect(h.requests.at(-1)?.path).toBe('/api/public/jobs/job-1')
  expect(h.requests.at(-1)?.init.method).toBe('POST')
  expect(h.requests.at(-1)?.body).toEqual({})
  for (const { init } of h.requests) {
    expect(init.credentials).toBe('same-origin'); expect(init.redirect).toBe('error')
    expect(init.headers).toMatchObject({ 'x-haldir-csrf': '1' })
  }
})
test('runner resume reads actual paid-without-delivery and report; does not sign or invent returned principal', async () => {
  const h = setup()
  await h.client.resume(); await h.client.open('approval', 'admission')
  const v: any = view(); v.job.scope.mandateId = 'mandate.testnet'; v.ownerOperations = [{ operationId: 'c'.repeat(64), action: 'create', status: 'CONFIRMED', request: null, transactionHash: '1'.repeat(32), signerId: principal.accountId, receipt: { status: 'CONFIRMED', finality: 'final', networkId: 'testnet', ownerId: principal.accountId, signerId: principal.accountId, action: 'create', mandateId: 'mandate.testnet', transactionHash: '1'.repeat(32) } }]; v.order.lifecycle = 'PAID_NOT_DELIVERED'; v.order.proof = { transactionHash: '1'.repeat(32), proofId: 'proof-1' }
  v.run = { stage: 'PARTIAL', report: { status: 'PARTIAL', supplierVerified: false, findings: [], missing: ['Delivery missing'] } }
  h.setView(v); await h.client.refresh(); await h.client.run(true)
  expect(h.requests.at(-1)?.path).toBe('/api/public/jobs/job-1/resume')
  expect(h.client.getSnapshot().view).toEqual(v)
  expect(h.client.getSnapshot().wallet).toBeNull()
})
for (const scenario of ['foreign-owner', 'numeric-amount', 'false-supplier-claim', 'delivered-without-artifact']) test(`fails closed for response ${scenario} and retains last observation`, async () => {
  const h = setup(); await h.client.resume(); await h.client.open('approval', 'admission')
  const before = h.client.getSnapshot().view
  const bad: any = view()
  if (scenario === 'foreign-owner') bad.job.ownerId = 'other.testnet'
  if (scenario === 'numeric-amount') bad.order.quote.amountAtomic = 123
  if (scenario === 'false-supplier-claim') bad.disclosures.supplierVerified = true
  if (scenario === 'delivered-without-artifact') bad.order.lifecycle = 'DELIVERED'
  h.setView(bad); await h.client.refresh()
  expect(h.client.getSnapshot().error).toBeTruthy()
  expect(h.client.getSnapshot().view).toBe(before)
})
test('missing approved origin and missing session do not reach transport', async () => {
  for (const patch of [{ approvedOrigin: undefined }, { approvedOrigin: 'https://evil.invalid' }, { principal: () => null }]) {
    const h = setup(patch); await h.client.resume()
    expect(h.requests).toEqual([]); expect(h.client.getSnapshot().error).toBeTruthy()
  }
})
test('no owner request decoder means approval is blocked without invented endpoint or wallet request', async () => {
  const h = setup(); await h.client.resume(); await h.client.open('approval', 'admission')
  const count = h.requests.length; await h.client.approve('stop')
  expect(h.client.getSnapshot().error).toBe('OWNER_REQUEST_CONTRACT_REQUIRED')
  expect(h.requests).toHaveLength(count)
})
test('owner approval journals before prompt, posts returned hash only, reads observed return and never repeats on reload', async () => {
  let prompts = 0, receiptCount = 0, phase = 'before', release: (() => void) | undefined
  const operation: any = { preparation: { attemptId: generation, state: 'ISSUED' }, operationId: ownerIdFor('withdraw'), action: 'withdraw', status: 'AWAITING_WALLET', request: { unsigned: true }, transactionHash: null, signerId: principal.accountId, receipt: null }
  const v: any = view(); v.job.scope.mandateId = 'mandate.testnet'
  const h = setup({ reviewOwnerOperation: async () => ({ manifest: { network: 'testnet', owner: principal.accountId, mandate: 'mandate.testnet', kind: 'withdraw', gas: '30000000000000' }, candidate: {} }),
    wallet: { approve: async () => {
      prompts++; expect([...h.values.values()].some(x => x.includes(operation.operationId))).toBe(true)
      await new Promise<void>(resolve => { release = resolve })
      return { status: 'submitted', transactionHash: '1'.repeat(32) }
    } } })
  h.options.transport = async (url: any, init: any) => {
    const path = new URL(url).pathname
    if (path === '/api/public/config') return Response.json(config)
    if (path.endsWith('/owner/prepare')) { phase = 'prepared'; return Response.json({ operation, walletEligible: true }) }
    if (path.endsWith('/owner/receipt')) {
      receiptCount++; expect(JSON.parse(init.body)).toEqual({ operationId: operation.operationId, transactionHash: '1'.repeat(32), signerId: principal.accountId })
      phase = 'confirmed'; return Response.json({ operation: { ...operation, status: 'CONFIRMED', transactionHash: '1'.repeat(32), receipt: { amountAtomic: '765432109876543210987654', receiptId: 'return-receipt' } } })
    }
    return Response.json({ ...v, ownerOperations: phase === 'before' ? [] : [{ ...operation, status: phase === 'confirmed' ? 'CONFIRMED' : 'UNKNOWN', transactionHash: phase === 'confirmed' ? '1'.repeat(32) : null, receipt: phase === 'confirmed' ? { amountAtomic: '765432109876543210987654', receiptId: 'return-receipt' } : null }] })
  }
  const client = createPublicTestnetController(h.options)
  await client.resume(); await client.open('approval', 'admission')
  const pending = client.approve('withdraw')
  while (!release) await new Promise(resolve => setTimeout(resolve, 0))
  const reloaded = createPublicTestnetController(h.options); await reloaded.resume()
  await reloaded.approve('withdraw'); expect(prompts).toBe(1)
  expect(reloaded.getSnapshot().error).toBe('OWNER_OPERATION_REQUIRES_RECONCILIATION')
  release(); await pending
  expect(receiptCount).toBe(1)
  expect(client.getSnapshot().view?.ownerOperations[0].receipt?.amountAtomic).toBe('765432109876543210987654')
  await client.approve('withdraw'); expect(prompts).toBe(1)
})
for (const financialActions of [true, false]) for (const outcome of ['cancelled', 'unknown']) test(`${outcome} wallet outcome retains same no-hash operation; refresh/reload cannot sign again${financialActions ? '' : ' with model missing'}`, async () => {
  const op: any = { preparation: { attemptId: generation, state: 'ISSUED' }, operationId: ownerIdFor('stop'), action: 'stop', status: 'AWAITING_WALLET', request: {}, transactionHash: null, signerId: principal.accountId, receipt: null }
  let prepared = false, prompts = 0
  const v: any = view(); v.job.scope.mandateId = 'mandate.testnet'
  const h = setup({ reviewOwnerOperation: async () => ({ manifest: { network: 'testnet', kind: 'stop', owner: principal.accountId, mandate: 'mandate.testnet', gas: '30000000000000' }, candidate: {} }), wallet: { approve: async () => { prompts++; return { status: outcome, transactionHash: null } } } })
  h.options.transport = async (url: any) => { const p = new URL(url).pathname
    if (p === '/api/public/config') return Response.json({ ...config, financialActions, missingConfiguration: financialActions ? [] : ['model'] })
    if (p.endsWith('/owner/prepare')) { prepared = true; return Response.json({ operation: op, walletEligible: true }) }
    if (p.endsWith('/owner/receipt')) throw new Error('NULL_HASH_RECEIPT_FORBIDDEN')
    return Response.json({ ...v, ownerOperations: prepared ? [op] : [] })
  }
  if (!financialActions) h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, v.job.jobId)
  const client = createPublicTestnetController(h.options); await client.resume(); if (financialActions) await client.open('approval', 'admission'); await client.approve('stop')
  expect(client.getSnapshot().wallet?.status).toBe(outcome)
  await client.refresh(); await client.approve('stop')
  const reload = createPublicTestnetController(h.options); await reload.resume(); await reload.approve('stop')
  expect(prompts).toBe(1)
  expect(reload.getSnapshot().view?.ownerOperations[0].status).toBe('AWAITING_WALLET')
  expect(reload.getSnapshot().wallet?.status).toBe(outcome)
})
test('no agent run is requested before observed confirmed owner creation', async () => {
  const h = setup(); await h.client.resume(); await h.client.open('approval', 'admission')
  const count = h.requests.length; await h.client.run()
  expect(h.client.getSnapshot().error).toBe('OWNER_CREATION_NOT_CONFIRMED')
  expect(h.requests).toHaveLength(count)
})
test('lost owner receipt response recovers persisted hash on explicit check, without another prompt', async () => {
  let prompts = 0, receipts = 0, prepared = false
  const op: any = { preparation: { attemptId: generation, state: 'ISSUED' }, operationId: ownerIdFor('stop'), action: 'stop', status: 'UNKNOWN', request: {}, transactionHash: null, signerId: principal.accountId, receipt: null }
  const v: any = view(); v.job.scope.mandateId = 'mandate.testnet'
  const h = setup({ reviewOwnerOperation: async () => ({ manifest: { network: 'testnet', kind: 'stop', owner: principal.accountId, mandate: 'mandate.testnet', gas: '30000000000000' }, candidate: {} }), wallet: { approve: async () => { prompts++; return { status: 'submitted', transactionHash: '1'.repeat(32) } } } })
  h.options.transport = async (url: any, init: any) => { const path = new URL(url).pathname
    if (path === '/api/public/config') return Response.json(config)
    if (path.endsWith('/owner/prepare')) { prepared = true; return Response.json({ operation: { ...op, status: 'AWAITING_WALLET' }, walletEligible: true }) }
    if (path.endsWith('/owner/receipt')) {
      receipts++; expect(JSON.parse(init.body).transactionHash).toBe('1'.repeat(32))
      if (receipts === 1) throw new Error('RESPONSE_LOST')
      op.status = 'CONFIRMED'; op.transactionHash = '1'.repeat(32)
      return Response.json({ operation: op })
    }
    return Response.json({ ...v, ownerOperations: prepared ? [op] : [] })
  }
  const client = createPublicTestnetController(h.options); await client.resume(); await client.open('approval', 'admission'); await client.approve('stop')
  expect(client.getSnapshot().error).toBe('RESPONSE_LOST')
  const reload = createPublicTestnetController(h.options); await reload.resume(); await reload.refresh()
  expect(receipts).toBe(2); expect(prompts).toBe(1)
  expect(reload.getSnapshot().view?.ownerOperations[0].status).toBe('CONFIRMED')
})
test('session invalidated while parsing the response cannot publish a stale owner view', async () => {
  let p: any = principal
  const h = setup({ principal: () => p })
  h.options.transport = async (url: any) => String(url).endsWith('/config') ? Response.json(config) : { ok: true, json: async () => { p = null; return view() } }
  const client = createPublicTestnetController(h.options); await client.resume(); await client.open('approval', 'admission')
  expect(client.getSnapshot().view).toBeNull()
  expect(client.getSnapshot().error).toBe('OWNER_SESSION_REQUIRED')
})
test('qualified requiredOwnerManifest consumes the frozen flat UnsignedOwnerCall request with no invented envelope', async () => {
  const manifest: any = { network: 'testnet', owner: principal.accountId, mandate: 'mandate.testnet', kind: 'stop', gas: '30000000000000' }
  const call = { network: 'testnet', signerId: principal.accountId, receiverId: manifest.mandate, methodName: 'stop', args: {}, gas: manifest.gas, deposit: '0' }
  const operation = { preparation: { attemptId: generation, state: 'ISSUED' }, operationId: ownerIdFor('stop'), action: 'stop', status: 'AWAITING_WALLET', request: call, transactionHash: null, signerId: principal.accountId, receipt: null }
  const requiredOwnerManifest = vi.fn(async () => manifest)
  const approve = vi.fn(async () => ({ status: 'cancelled', transactionHash: null }))
  const h = setup({ requiredOwnerManifest, wallet: { approve } }); const v: any = view(); v.job.scope.mandateId = manifest.mandate
  let prepared = false
  h.options.transport = async (url: any) => {
    if (String(url).endsWith('/config')) return Response.json(config)
    if (String(url).endsWith('/owner/prepare')) { prepared = true; return Response.json({ operation, walletEligible: true }) }
    return Response.json({ ...v, ownerOperations: prepared ? [operation] : [] })
  }
  const client = createPublicTestnetController(h.options); await client.resume(); await client.open('approval', 'admission'); await client.approve('stop')
  expect(requiredOwnerManifest).toHaveBeenCalledOnce()
  expect(approve).toHaveBeenCalledWith(manifest, call)
  expect(client.getSnapshot().wallet?.status).toBe('cancelled')
})
for (const action of ['stop', 'withdraw'] as const) test(`model-missing config permits existing owned ${action} and same-operation receipt recovery only`, async () => {
  const manifest = { network: 'testnet', owner: principal.accountId, mandate: 'mandate.testnet', kind: action, gas: '30000000000000' } as const
  const call = { network: 'testnet', signerId: principal.accountId, receiverId: manifest.mandate, methodName: action, args: {}, gas: manifest.gas, deposit: '0' }
  const op: any = { preparation: { attemptId: generation, state: 'ISSUED' }, operationId: ownerIdFor(action), action, status: 'AWAITING_WALLET', request: call, transactionHash: null, signerId: principal.accountId, receipt: null }
  const requiredOwnerManifest = vi.fn(async () => manifest), approve = vi.fn(async () => ({ status: 'submitted', transactionHash: '1'.repeat(32) }))
  const h = setup({ requiredOwnerManifest, wallet: { approve } }), v: any = view()
  v.job.scope.mandateId = manifest.mandate
  h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, v.job.jobId)
  let prepared = false, receipts = 0
  const paths: string[] = []
  h.options.transport = async (url: any, init: any) => {
    const path = new URL(url).pathname; paths.push(path)
    if (path.endsWith('/config')) return Response.json({ ...config, financialActions: false, missingConfiguration: ['model', 'qualifiedModel'] })
    if (path.endsWith('/owner/prepare')) { expect(JSON.parse(init.body)).toEqual({ action }); prepared = true; return Response.json({ operation: op, walletEligible: true }) }
    if (path.endsWith('/owner/receipt')) {
      expect(JSON.parse(init.body)).toEqual({ operationId: op.operationId, signerId: principal.accountId, transactionHash: '1'.repeat(32) })
      if (++receipts === 1) throw new Error('RESPONSE_LOST')
      op.status = 'CONFIRMED'; op.transactionHash = '1'.repeat(32); return Response.json({ operation: op })
    }
    expect(init.method).toBe('POST'); expect(JSON.parse(init.body)).toEqual({})
    return Response.json({ ...v, ownerOperations: prepared ? [op] : [] })
  }
  const client = createPublicTestnetController(h.options); await client.resume()
  expect(client.getSnapshot().config?.financialActions).toBe(false)
  expect(client.getSnapshot().view?.job.jobId).toBe(v.job.jobId)
  await client.approve(action)
  expect(client.getSnapshot().error).toBe('RESPONSE_LOST')
  expect(requiredOwnerManifest).toHaveBeenCalledOnce(); expect(approve).toHaveBeenCalledWith(manifest, call)
  const reload = createPublicTestnetController(h.options); await reload.resume(); await reload.refresh()
  expect(reload.getSnapshot().error).toBeNull(); expect(receipts).toBe(2)
  expect(reload.getSnapshot().view?.ownerOperations[0].status).toBe('CONFIRMED')
  expect(reload.getSnapshot().view?.ownerOperations[0].operationId).toBe(op.operationId)
  await reload.approve(action)
  expect(reload.getSnapshot().error).toBe('OWNER_OPERATION_REQUIRES_RECONCILIATION'); expect(approve).toHaveBeenCalledOnce()
  h.values.delete(`haldir-public-job-v1:${origin}:${principal.accountId}`)
  const before = paths.length
  for (const blocked of [() => reload.open('approval', 'new-admission'), () => reload.approve('create'), () => reload.run(), () => reload.run(true)]) {
    await blocked(); expect(reload.getSnapshot().error).toBe('FINANCIAL_NOT_CONFIGURED')
  }
  expect(paths).toHaveLength(before)
})

test('model-missing open of an already-saved owned job is a read, while new admission stays blocked', async () => {
  const h = setup()
  h.setConfig({ ...config, financialActions: false, missingConfiguration: ['model'] })
  h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, 'job-1')
  await h.client.resume(); const count = h.requests.length
  await h.client.open('approval', 'existing-admission')
  expect(h.client.getSnapshot().error).toBeNull()
  expect(h.requests.slice(count).map(request => ({ path: request.path, method: request.init.method, body: request.body }))).toEqual([{ path: '/api/public/jobs/job-1', method: 'POST', body: {} }])
  h.values.delete(`haldir-public-job-v1:${origin}:${principal.accountId}`)
  const before = h.requests.length; await h.client.open('approval', 'new-admission')
  expect(h.client.getSnapshot().error).toBe('FINANCIAL_NOT_CONFIGURED')
  expect(h.requests).toHaveLength(before)
})

test('model-missing recovery still requires session, existing owned job and independent owner terms before prepare', async () => {
  let p: any = principal
  const approve = vi.fn(), h = setup({ principal: () => p, wallet: { approve } })
  h.setConfig({ ...config, financialActions: false, missingConfiguration: ['model'] })
  await h.client.resume(); await h.client.approve('stop')
  expect(h.client.getSnapshot().error).toBe('PUBLIC_JOB_REQUIRED')
  h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, 'job-1')
  await h.client.resume()
  const count = h.requests.length
  await h.client.approve('withdraw')
  expect(h.client.getSnapshot().error).toBe('OWNER_REQUEST_CONTRACT_REQUIRED')
  expect(h.requests).toHaveLength(count)
  p = { ...principal, accountId: 'foreign.testnet' }
  await h.client.approve('stop')
  expect(h.client.getSnapshot().error).toBe('PUBLIC_JOB_REQUIRED')
  p = null
  await h.client.approve('stop'); await h.client.refresh()
  expect(h.client.getSnapshot().error).toBe('OWNER_SESSION_REQUIRED')
  expect(h.requests).toHaveLength(count); expect(approve).not.toHaveBeenCalled()
})

test('model-missing read/reconcile rejects a foreign saved operation identity instead of posting its hash', async () => {
  const h = setup(), v: any = view()
  v.ownerOperations = [{ operationId: 'a'.repeat(64), action: 'stop', status: 'UNKNOWN', request: {}, transactionHash: null, signerId: principal.accountId, receipt: null }]
  h.setView(v); h.setConfig({ ...config, financialActions: false, missingConfiguration: ['model'] })
  h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, 'job-1')
  await h.client.resume()
  h.values.set(`haldir-public-owner-v1:${origin}:${principal.accountId}:job-1:stop`, JSON.stringify({ operationId: 'b'.repeat(64), status: 'submitted', transactionHash: '1'.repeat(32) }))
  await h.client.refresh()
  expect(h.client.getSnapshot().error).toBe('INVALID_SAVED_OWNER_OPERATION')
  expect(h.requests.some(request => request.path.endsWith('/owner/receipt'))).toBe(false)
  expect(h.client.getSnapshot().view?.job.jobId).toBe('job-1')
})

test('committed prepare response loss reload adopts only the same authoritative stop and keeps distinct withdrawal accessible with model closed', async () => {
  const { createHash } = await import('node:crypto')
  const { resolveOwnerManifest } = await import('../src/integration/owner-approval')
  const operationId = createHash('sha256').update(JSON.stringify(['haldir-owner-v1', 'job-1', 'stop'])).digest('hex')
  const v: any = view(); v.job.scope.mandateId = 'mandate.testnet'
  const terms = { network: 'testnet', owner: principal.accountId, mandate: 'mandate.testnet', gas: '100000000000000' }
  v.ownerApproval = { jobId: v.job.jobId, ownerId: principal.accountId, mandateId: terms.mandate, manifestId: v.job.manifestId,
    actions: { stop: { ...terms, kind: 'stop' }, withdraw: { ...terms, kind: 'withdraw' } } }
  let prepareCount = 0
  const approve = vi.fn(async () => ({ status: 'cancelled', transactionHash: null }))
  const h = setup({ requiredOwnerManifest: resolveOwnerManifest, wallet: { approve } })
  h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, v.job.jobId)
  h.options.transport = async (url: any, init: any) => {
    const path = new URL(url).pathname
    if (path.endsWith('/config')) return Response.json({ ...config, financialActions: false, missingConfiguration: ['model'] })
    if (path.endsWith('/owner/prepare')) {
      prepareCount++
      const { action } = JSON.parse(init.body)
      const op = { preparation: { attemptId: generation, state: 'ISSUED' }, operationId: action === 'stop' ? operationId : createHash('sha256').update(JSON.stringify(['haldir-owner-v1', 'job-1', action])).digest('hex'), action, status: 'AWAITING_WALLET', transactionHash: null, signerId: principal.accountId, receipt: null,
        request: { network: 'testnet', signerId: principal.accountId, receiverId: terms.mandate, methodName: action, args: {}, gas: terms.gas, deposit: '0' } }
      v.ownerOperations.push(op) // Commit, then lose only the HTTP response.
      if (action === 'stop') throw new Error('RESPONSE_LOST_AFTER_COMMIT')
      return Response.json({ operation: op, walletEligible: true })
    }
    expect(path).toBe('/api/public/jobs/job-1'); expect(init.method).toBe('POST'); expect(JSON.parse(init.body)).toEqual({})
    return Response.json(v)
  }
  const client = createPublicTestnetController(h.options); await client.resume(); await client.approve('stop')
  expect(client.getSnapshot().error).toBe('RESPONSE_LOST_AFTER_COMMIT')
  const key = `haldir-public-owner-v1:${origin}:${principal.accountId}:job-1:stop`
  expect(JSON.parse(h.values.get(key)!)).toEqual({ operationId: null, status: 'preparing', transactionHash: null })
  const reload = createPublicTestnetController(h.options); await reload.resume()
  expect(reload.getSnapshot().error).toBeNull()
  expect(reload.getSnapshot().view?.ownerOperations[0].operationId).toBe(operationId)
  expect(JSON.parse(h.values.get(key)!)).toMatchObject({ operationId, transactionHash: null })
  expect(approve).not.toHaveBeenCalled()
  await reload.refresh(); await reload.approve('stop')
  expect(reload.getSnapshot().error).toBe('OWNER_OPERATION_REQUIRES_RECONCILIATION')
  expect(prepareCount).toBe(1); expect(approve).not.toHaveBeenCalled()
  await reload.approve('withdraw')
  expect(reload.getSnapshot().error).toBeNull(); expect(prepareCount).toBe(2); expect(approve).toHaveBeenCalledOnce()
  expect(h.values.has(key)).toBe(true)
})

for (const scenario of ['foreign-owner', 'foreign-job', 'foreign-action', 'foreign-operation', 'conflicting-id', 'conflicting-hash', 'not-preparing', 'placeholder-hash', 'extra-placeholder-field']) test(`prepare-loss recovery rejects ${scenario} without clearing guard or calling wallet`, async () => {
  const { createHash } = await import('node:crypto')
  const id = (action: string, jobId = 'job-1') => createHash('sha256').update(JSON.stringify(['haldir-owner-v1', jobId, action])).digest('hex')
  const v: any = view(), saved: any = { operationId: null, status: 'preparing', transactionHash: null }
  const op: any = { operationId: id('stop'), action: 'stop', status: 'AWAITING_WALLET', transactionHash: null, signerId: principal.accountId, request: {}, receipt: null }
  if (scenario === 'foreign-owner') op.signerId = 'foreign.testnet'
  if (scenario === 'foreign-job') v.job.jobId = 'job-2'
  if (scenario === 'foreign-action') op.operationId = id('withdraw')
  if (scenario === 'foreign-operation') op.operationId = id('stop', 'job-2')
  if (scenario === 'conflicting-id') saved.operationId = 'f'.repeat(64)
  if (scenario === 'conflicting-hash') { saved.operationId = op.operationId; saved.status = 'submitted'; saved.transactionHash = '1'.repeat(32); op.transactionHash = '2'.repeat(32) }
  if (scenario === 'not-preparing') saved.status = 'unknown'
  if (scenario === 'placeholder-hash') saved.transactionHash = '1'.repeat(32)
  if (scenario === 'extra-placeholder-field') saved.ownerId = 'foreign.testnet'
  v.ownerOperations = [op]
  const approve = vi.fn(), h = setup({ wallet: { approve } }); h.setView(v)
  h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, 'job-1')
  const key = `haldir-public-owner-v1:${origin}:${principal.accountId}:job-1:stop`, raw = JSON.stringify(saved)
  h.values.set(key, raw)
  await h.client.resume()
  expect(h.client.getSnapshot().error).toBeTruthy(); expect(h.client.getSnapshot().view).toBeNull()
  expect(h.values.get(key)).toBe(raw); expect(approve).not.toHaveBeenCalled()
  expect(h.requests.some(r => /owner\//.test(r.path))).toBe(false)
})

for (const withCreationTerms of [true, false]) test(`deployed admission runs without a fabricated creation operation and rejects new create (creation terms ${withCreationTerms})`, async () => {
  const approve = vi.fn(), h = setup({ requiredOwnerManifest: vi.fn(), wallet: { approve } }), v: any = view()
  v.job.ownerCreationRequired = false
  v.ownerApproval = { actions: { create: withCreationTerms ? { kind: 'create' } : null } }
  h.setView(v); await h.client.resume(); await h.client.open('approval', 'admission')
  expect(h.client.getSnapshot().view?.ownerOperations).toEqual([])
  for (const resume of [false, true]) {
    await h.client.run(resume)
    expect(h.client.getSnapshot().error).toBeNull()
    expect(h.requests.at(-1)?.path).toBe(`/api/public/jobs/job-1/${resume ? 'resume' : 'run'}`)
  }
  const count = h.requests.length; await h.client.approve('create')
  expect(h.client.getSnapshot().error).toBe('OWNER_CREATION_NOT_REQUIRED')
  expect(h.requests).toHaveLength(count); expect(approve).not.toHaveBeenCalled()
  expect(h.client.getSnapshot().view?.ownerOperations).toEqual([])
})

for (const required of [true, undefined]) for (const scenario of ['missing', 'unconfirmed', 'no-receipt', 'wrong-owner', 'wrong-signer', 'wrong-mandate', 'wrong-action', 'wrong-hash', 'not-final', 'wrong-network', 'receipt-failed', 'bound']) test(`creation fence ${required === true ? 'factory' : 'legacy'} ${scenario}`, async () => {
  const h = setup(), v: any = view()
  if (required !== undefined) v.job.ownerCreationRequired = required
  v.job.scope.mandateId = 'mandate.testnet'
  const op: any = { operationId: 'a'.repeat(64), action: 'create', status: 'CONFIRMED', request: null, signerId: principal.accountId, transactionHash: '1'.repeat(32), receipt: {
    status: 'CONFIRMED', finality: 'final', networkId: 'testnet', ownerId: principal.accountId, signerId: principal.accountId, action: 'create', mandateId: 'mandate.testnet', transactionHash: '1'.repeat(32) } }
  if (scenario !== 'missing') v.ownerOperations = [op]
  if (scenario === 'unconfirmed') op.status = 'UNKNOWN'
  if (scenario === 'no-receipt') op.receipt = null
  if (scenario === 'wrong-owner') op.receipt.ownerId = 'foreign.testnet'
  if (scenario === 'wrong-signer') op.receipt.signerId = 'foreign.testnet'
  if (scenario === 'wrong-mandate') op.receipt.mandateId = 'foreign.testnet'
  if (scenario === 'wrong-action') op.receipt.action = 'stop'
  if (scenario === 'wrong-hash') op.receipt.transactionHash = '2'.repeat(32)
  if (scenario === 'not-final') op.receipt.finality = 'optimistic'
  if (scenario === 'wrong-network') op.receipt.networkId = 'mainnet'
  if (scenario === 'receipt-failed') op.receipt.status = 'FAILED'
  h.setView(v); await h.client.resume(); await h.client.open('approval', 'admission')
  const count = h.requests.length; await h.client.run()
  expect(h.client.getSnapshot().error).toBe(scenario === 'bound' ? null : 'OWNER_CREATION_NOT_CONFIRMED')
  expect(h.requests).toHaveLength(count + (scenario === 'bound' ? 1 : 0))
})

for (const bad of [null, 'false', 0]) test(`rejects malformed creation-required flag ${JSON.stringify(bad)}`, async () => {
  const h = setup(), v: any = view(); v.job.ownerCreationRequired = bad
  h.setView(v); await h.client.resume(); await h.client.open('approval', 'admission')
  expect(h.client.getSnapshot().error).toBe('INVALID_PUBLIC_RESPONSE')
  expect(h.client.getSnapshot().view).toBeNull()
})

test('prepare placeholder adoption cannot publish or rewrite its guard after same-owner session changes during digest', async () => {
  const { createHash } = await import('node:crypto')
  let p: any = principal
  const h = setup({ principal: () => p }), v: any = view()
  const bytes = createHash('sha256').update(JSON.stringify(['haldir-owner-v1', 'job-1', 'stop'])).digest()
  v.ownerOperations = [{ operationId: bytes.toString('hex'), action: 'stop', status: 'AWAITING_WALLET', transactionHash: null, signerId: principal.accountId, request: {}, receipt: null }]
  h.setView(v); h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, 'job-1')
  const key = `haldir-public-owner-v1:${origin}:${principal.accountId}:job-1:stop`, raw = JSON.stringify({ operationId: null, status: 'preparing', transactionHash: null })
  h.values.set(key, raw)
  const digest = vi.fn(async () => { p = { ...principal, sessionId: 'b'.repeat(64) }; return Uint8Array.from(bytes).buffer })
  vi.stubGlobal('crypto', { subtle: { digest } })
  try {
    await h.client.resume()
    expect(digest).toHaveBeenCalledOnce()
    expect(h.client.getSnapshot().error).toBe('OWNER_SESSION_CHANGED')
    expect(h.client.getSnapshot().view).toBeNull(); expect(h.values.get(key)).toBe(raw)
  } finally { vi.unstubAllGlobals() }
})

const prepareGuard = JSON.stringify({ operationId: null, status: 'preparing', transactionHash: null })
const stopGuardKey = `haldir-public-owner-v1:${origin}:${principal.accountId}:job-1:stop`
function rejectedPrepare(response: () => Promise<Response>, overrides: Record<string, unknown> = {}) {
  const approve = vi.fn(), review = vi.fn(), h = setup({ reviewOwnerOperation: review, wallet: { approve }, ...overrides })
  const ordinary = h.options.transport
  let prepares = 0
  h.options.transport = async (url: any, init: any) => {
    if (String(url).endsWith('/owner/prepare')) { prepares++; return response() }
    return ordinary(url, init)
  }
  const client = createPublicTestnetController(h.options)
  return { ...h, client, approve, review, prepares: () => prepares }
}
for (const [status, error] of [[429, 'RATE_LIMITED'], [401, 'UNAUTHENTICATED'], [503, 'FINANCIAL_NOT_CONFIGURED']] as const)
  test(`explicit precommit HTTP ${status} ${error} retains guard; reload never auto-retries`, async () => {
    const h = rejectedPrepare(async () => Response.json({ contractVersion: 'haldir.public.v1', error }, { status }))
    await h.client.resume(); await h.client.open('approval', 'admission'); await h.client.approve('stop')
    expect(h.client.getSnapshot().error).toBe(error)
    expect(h.values.get(stopGuardKey)).toBe(prepareGuard)
    expect(h.prepares()).toBe(1); expect(h.approve).not.toHaveBeenCalled(); expect(h.review).not.toHaveBeenCalled()
    const reload = createPublicTestnetController(h.options); await reload.resume(); await reload.refresh()
    expect(h.prepares()).toBe(1); expect(h.approve).not.toHaveBeenCalled()
    await reload.approve('stop')
    expect(reload.getSnapshot().error).toBe('OWNER_OPERATION_REQUIRES_RECONCILIATION')
    expect(h.prepares()).toBe(1); expect(h.values.get(stopGuardKey)).toBe(prepareGuard)
  })

for (const [label, response] of [
  ['provider-unavailable', async () => Response.json({ contractVersion: 'haldir.public.v1', error: 'PROVIDER_UNAVAILABLE' }, { status: 503 })],
  ['internal-error', async () => Response.json({ contractVersion: 'haldir.public.v1', error: 'INTERNAL_ERROR' }, { status: 500 })],
  ['arbitrary-4xx', async () => Response.json({ contractVersion: 'haldir.public.v1', error: 'INVALID_BODY' }, { status: 400 })],
  ['unknown-code', async () => Response.json({ contractVersion: 'haldir.public.v1', error: 'SOMETHING_ELSE' }, { status: 429 })],
  ['wrong-status', async () => Response.json({ contractVersion: 'haldir.public.v1', error: 'RATE_LIMITED' }, { status: 409 })],
  ['wrong-contract', async () => Response.json({ contractVersion: 'haldir.public.v2', error: 'RATE_LIMITED' }, { status: 429 })],
  ['missing-contract', async () => Response.json({ error: 'RATE_LIMITED' }, { status: 429 })],
  ['missing-code', async () => Response.json({ contractVersion: 'haldir.public.v1' }, { status: 429 })],
  ['body-parse-failure', async () => new Response('{', { status: 429 })],
  ['timeout', async () => { throw new DOMException('timed out', 'TimeoutError') }],
  ['response-lost', async () => { throw new Error('RESPONSE_LOST') }],
  ...['RATE_LIMITED', 'UNAUTHENTICATED', 'FINANCIAL_NOT_CONFIGURED'].map(code => [`plain-error-${code}`, async () => { throw new Error(code) }] as const),
] as const) test(`uncertain prepare ${label} remains lookup-only without automatic signature or retry`, async () => {
  const h = rejectedPrepare(response)
  await h.client.resume(); await h.client.open('approval', 'admission'); await h.client.approve('stop')
  expect(h.client.getSnapshot().error).toBeTruthy()
  expect(h.values.get(stopGuardKey)).toBe(prepareGuard)
  const reload = createPublicTestnetController(h.options); await reload.resume(); await reload.refresh(); await reload.approve('stop')
  expect(reload.getSnapshot().error).toBe('OWNER_OPERATION_REQUIRES_RECONCILIATION')
  expect(h.prepares()).toBe(1); expect(h.approve).not.toHaveBeenCalled(); expect(h.review).not.toHaveBeenCalled()
  expect(h.values.get(stopGuardKey)).toBe(prepareGuard)
})

for (const change of ['session', 'in-place-session', 'owner', 'logout', 'operation-id', 'status', 'hash', 'extra-field', 'reformatted-placeholder', 'removed'] as const)
  test(`precommit rejection preserves changed ${change} identity/storage during the current request`, async () => {
    let p: any = { ...principal }, release!: (r: Response) => void
    const h = rejectedPrepare(() => new Promise(resolve => { release = resolve }), { principal: () => p })
    await h.client.resume(); await h.client.open('approval', 'admission')
    const pending = h.client.approve('stop')
    expect(h.values.get(stopGuardKey)).toBe(prepareGuard)
    if (change === 'session') p = { ...principal, sessionId: 'b'.repeat(64) }
    if (change === 'in-place-session') p.sessionId = 'b'.repeat(64)
    if (change === 'owner') p = { ...principal, accountId: 'foreign.testnet' }
    if (change === 'logout') p = null
    if (change === 'operation-id') h.values.set(stopGuardKey, JSON.stringify({ operationId: 'b'.repeat(64), status: 'awaiting-wallet', transactionHash: null }))
    if (change === 'status') h.values.set(stopGuardKey, JSON.stringify({ operationId: null, status: 'unknown', transactionHash: null }))
    if (change === 'hash') h.values.set(stopGuardKey, JSON.stringify({ operationId: null, status: 'preparing', transactionHash: '1'.repeat(32) }))
    if (change === 'extra-field') h.values.set(stopGuardKey, JSON.stringify({ operationId: null, status: 'preparing', transactionHash: null, newer: true }))
    if (change === 'reformatted-placeholder') h.values.set(stopGuardKey, JSON.stringify(JSON.parse(prepareGuard), null, 2))
    if (change === 'removed') h.values.delete(stopGuardKey)
    const before = h.values.get(stopGuardKey)
    release(Response.json({ contractVersion: 'haldir.public.v1', error: 'RATE_LIMITED' }, { status: 429 }))
    await pending
    expect(h.values.get(stopGuardKey)).toBe(before)
    expect(h.prepares()).toBe(1); expect(h.approve).not.toHaveBeenCalled()
  })

for (const eligibility of [undefined, false]) test(`prepare walletEligible ${String(eligibility)} stays lookup-only even with an unsigned request`, async () => {
  const op = { operationId: ownerIdFor('stop'), action: 'stop', status: 'AWAITING_WALLET', request: {}, transactionHash: null, signerId: principal.accountId, receipt: null }
  const approve = vi.fn(async () => ({ status: 'cancelled', transactionHash: null })), review = vi.fn(async () => ({ manifest: { owner: principal.accountId, kind: 'stop', mandate: undefined }, candidate: {} })), h = setup({ reviewOwnerOperation: review, wallet: { approve } })
  let prepared = false
  h.options.transport = async (url: any) => {
    if (String(url).endsWith('/config')) return Response.json(config)
    if (String(url).endsWith('/owner/prepare')) { prepared = true; return Response.json({ operation: op, walletEligible: eligibility }) }
    return Response.json({ ...view(), ownerOperations: prepared ? [op] : [] })
  }
  const client = createPublicTestnetController(h.options); await client.resume(); await client.open('approval', 'admission'); await client.approve('stop')
  expect(client.getSnapshot().error).toBeNull()
  expect(client.getSnapshot().view?.ownerOperations[0].operationId).toBe(op.operationId)
  expect(review).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled()
  expect(h.values.has(stopGuardKey)).toBe(true)
})

for (const invalid of ['owner', 'action', 'operation', 'generation-missing', 'generation-null', 'generation-malformed', 'generation-pending', 'generation-failed', 'hash', 'terminal']) test(`eligible prepare rejects mismatched ${invalid} before review or wallet`, async () => {
  const op: any = { operationId: ownerIdFor('stop'), action: 'stop', status: 'AWAITING_WALLET', preparation: { attemptId: generation, state: 'ISSUED' }, request: {}, transactionHash: null, signerId: principal.accountId, receipt: null }
  if (invalid === 'owner') op.signerId = 'foreign.testnet'
  if (invalid === 'action') op.action = 'withdraw'
  if (invalid === 'operation') op.operationId = ownerIdFor('withdraw')
  if (invalid === 'generation-missing') delete op.preparation
  if (invalid === 'generation-null') op.preparation = null
  if (invalid === 'generation-malformed') op.preparation.attemptId = generation.toUpperCase()
  if (invalid === 'generation-pending') op.preparation.state = 'PREPARING'
  if (invalid === 'generation-failed') op.preparation.state = 'UNISSUED_FAILED'
  if (invalid === 'hash') op.transactionHash = '1'.repeat(32)
  if (invalid === 'terminal') op.status = 'CONFIRMED'
  const review = vi.fn(async () => ({ manifest: { owner: principal.accountId, kind: 'stop', mandate: undefined }, candidate: {} })), approve = vi.fn(async () => ({ status: 'cancelled', transactionHash: null }))
  const h = setup({ reviewOwnerOperation: review, wallet: { approve } })
  const ordinary = h.options.transport
  h.options.transport = async (url: any, init: any) => String(url).endsWith('/owner/prepare') ? Response.json({ operation: op, walletEligible: true }) : ordinary(url, init)
  const client = createPublicTestnetController(h.options); await client.resume(); await client.open('approval', 'admission'); await client.approve('stop')
  expect(client.getSnapshot().error).toBeTruthy()
  expect(review).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled()
  expect(h.values.get(stopGuardKey)).toBe(prepareGuard)
})

test('retained pre-claim guard reload offers only explicit unreserved retry, one reviewed wallet prompt with model closed', async () => {
  const v: any = view(); v.job.scope.mandateId = 'mandate.testnet'
  const manifest = { network: 'testnet', owner: principal.accountId, mandate: v.job.scope.mandateId, kind: 'stop', gas: '100000000000000' }
  const call = { network: 'testnet', signerId: principal.accountId, receiverId: manifest.mandate, methodName: 'stop', args: {}, gas: manifest.gas, deposit: '0' }
  const op = { operationId: ownerIdFor('stop'), action: 'stop', status: 'AWAITING_WALLET', preparation: { attemptId: generation, state: 'ISSUED' }, request: call, transactionHash: null, signerId: principal.accountId, receipt: null }
  const approve = vi.fn(async () => ({ status: 'cancelled', transactionHash: null })), requiredOwnerManifest = vi.fn(async () => manifest)
  const h = setup({ requiredOwnerManifest, wallet: { approve } }), bodies: any[] = []
  h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, 'job-1')
  h.options.transport = async (url: any, init: any) => {
    const path = new URL(url).pathname
    if (path.endsWith('/config')) return Response.json({ ...config, financialActions: false, missingConfiguration: ['model'] })
    if (path.endsWith('/owner/prepare')) return Response.json({ contractVersion: 'haldir.public.v1', error: 'RATE_LIMITED' }, { status: 429 })
    if (path.endsWith('/owner/retry-prepare')) { bodies.push(JSON.parse(init.body)); v.ownerOperations = [op]; return Response.json({ operation: op, walletEligible: true }) }
    return Response.json(v)
  }
  const first = createPublicTestnetController(h.options); await first.resume(); await first.approve('stop')
  expect(h.values.get(stopGuardKey)).toBe(prepareGuard)
  const reload: any = createPublicTestnetController(h.options); await reload.resume(); await reload.refresh(); await reload.open('approval', 'admission')
  expect(bodies).toEqual([]); expect(approve).not.toHaveBeenCalled()
  expect(reload.canRetryPreparation?.('stop')).toBe(true)
  await reload.retryPreparation('stop')
  expect(reload.getSnapshot().error).toBeNull()
  expect(bodies).toEqual([{ action: 'stop', operationId: ownerIdFor('stop'), attemptId: 'unreserved' }])
  expect(requiredOwnerManifest).toHaveBeenCalledOnce(); expect(approve).toHaveBeenCalledExactlyOnceWith(manifest, call)
  expect(reload.canRetryPreparation('stop')).toBe(false)
  await reload.retryPreparation('stop'); expect(bodies).toHaveLength(1); expect(approve).toHaveBeenCalledOnce()
  expect(JSON.parse(h.values.get(stopGuardKey)!)).toEqual({ operationId: op.operationId, status: 'cancelled', transactionHash: null })
})

for (const action of ['stop', 'withdraw'] as const) test(`server-proved failed unissued ${action} retries exact generation and same financial operation/terms`, async () => {
  const v: any = view(); v.job.scope.mandateId = 'mandate.testnet'
  const failed: any = { operationId: ownerIdFor(action), action, status: 'UNKNOWN', preparation: { attemptId: generation, state: 'UNISSUED_FAILED' }, request: null, transactionHash: null, signerId: principal.accountId, receipt: null }
  v.ownerOperations = [failed]
  const manifest = { network: 'testnet', owner: principal.accountId, mandate: v.job.scope.mandateId, kind: action, gas: '100000000000000' }
  const call = { network: 'testnet', signerId: principal.accountId, receiverId: manifest.mandate, methodName: action, args: {}, gas: manifest.gas, deposit: '0' }
  const approve = vi.fn(async () => ({ status: 'cancelled', transactionHash: null })), requiredOwnerManifest = vi.fn(async () => manifest)
  const h = setup({ requiredOwnerManifest, wallet: { approve } }), bodies: any[] = []
  h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, 'job-1')
  h.options.transport = async (url: any, init: any) => {
    if (String(url).endsWith('/config')) return Response.json({ ...config, financialActions: false, missingConfiguration: ['model'] })
    if (String(url).endsWith('/owner/retry-prepare')) { bodies.push(JSON.parse(init.body)); v.ownerOperations = [{ ...failed, status: 'AWAITING_WALLET', request: call, preparation: { attemptId: '22345678-1234-4234-8234-123456789abc', state: 'ISSUED' } }]; return Response.json({ operation: v.ownerOperations[0], walletEligible: true }) }
    return Response.json(v)
  }
  const client = createPublicTestnetController(h.options); await client.resume()
  expect(client.canRetryPreparation(action)).toBe(true)
  await client.retryPreparation(action)
  expect(client.getSnapshot().error).toBeNull()
  expect(bodies).toEqual([{ action, operationId: failed.operationId, attemptId: generation }])
  expect(approve).toHaveBeenCalledExactlyOnceWith(manifest, call)
  expect(client.getSnapshot().view?.job.scope).toEqual(v.job.scope)
  expect(client.getSnapshot().view?.ownerOperations[0].operationId).toBe(failed.operationId)
  expect(ownerIdFor('stop')).not.toBe(ownerIdFor('withdraw'))
})

for (const phase of ['response', 'digest', 'review', 'wallet']) test(`same-owner in-place session change during ${phase} cannot prompt or persist stale provider results`, async () => {
  let p: any = { ...principal }, release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const op: any = { operationId: ownerIdFor('stop'), action: 'stop', status: 'AWAITING_WALLET', preparation: { attemptId: generation, state: 'ISSUED' }, request: {}, transactionHash: null, signerId: principal.accountId, receipt: null }
  const review = vi.fn(async () => { if (phase === 'review') { entered(); await held } return { manifest: { owner: principal.accountId, kind: 'stop', mandate: undefined }, candidate: {} } })
  const approve = vi.fn(async () => { if (phase === 'wallet') { entered(); await held } return { status: 'submitted', transactionHash: '1'.repeat(32) } })
  const h = setup({ principal: () => p, reviewOwnerOperation: review, wallet: { approve } }), ordinary = h.options.transport
  let receipts = 0
  h.options.transport = async (url: any, init: any) => {
    if (String(url).endsWith('/owner/prepare')) { if (phase === 'response') { entered(); await held } return Response.json({ operation: op, walletEligible: true }) }
    if (String(url).endsWith('/owner/receipt')) receipts++
    return ordinary(url, init)
  }
  const realDigest = crypto.subtle.digest.bind(crypto.subtle)
  if (phase === 'digest') vi.stubGlobal('crypto', { subtle: { digest: async (...args: Parameters<typeof realDigest>) => { entered(); await held; return realDigest(...args) } } })
  try {
    const client = createPublicTestnetController(h.options); await client.resume(); await client.open('approval', 'admission')
    const pending = client.approve('stop'); await started
    const raw = h.values.get(stopGuardKey)
    p.sessionId = 'b'.repeat(64); release(); await pending
    expect(receipts).toBe(0); expect(approve).toHaveBeenCalledTimes(phase === 'wallet' ? 1 : 0)
    expect(h.values.get(stopGuardKey)).toBe(raw)
    expect(client.getSnapshot().error).toBe('OWNER_SESSION_CHANGED')
    expect(client.getSnapshot().wallet).toBeNull()
  } finally { vi.unstubAllGlobals() }
})

for (const invalid of ['pending', 'issued', 'legacy', 'null-generation', 'terminal', 'failed-terminal', 'server-hash', 'request', 'receipt', 'local-hash', 'local-cancelled', 'local-awaiting', 'foreign-operation', 'create']) test(`retry remains closed for ${invalid}`, async () => {
  const op: any = { operationId: ownerIdFor('stop'), action: 'stop', status: 'UNKNOWN', preparation: { attemptId: generation, state: 'UNISSUED_FAILED' }, request: null, transactionHash: null, signerId: principal.accountId, receipt: null }
  if (invalid === 'pending') { op.status = 'PREPARING'; op.preparation.state = 'PREPARING' }
  if (invalid === 'issued') { op.status = 'AWAITING_WALLET'; op.preparation.state = 'ISSUED' }
  if (invalid === 'legacy') delete op.preparation
  if (invalid === 'null-generation') op.preparation = null
  if (invalid === 'terminal') op.status = 'CONFIRMED'
  if (invalid === 'failed-terminal') op.status = 'FAILED'
  if (invalid === 'server-hash') op.transactionHash = '1'.repeat(32)
  if (invalid === 'request') op.request = {}
  if (invalid === 'receipt') op.receipt = {}
  if (invalid === 'foreign-operation') op.operationId = ownerIdFor('withdraw')
  if (invalid === 'create') { op.action = 'create'; op.operationId = ownerIdFor('create') }
  const h = setup({ reviewOwnerOperation: vi.fn(), wallet: { approve: vi.fn() } }), v: any = view(); v.ownerOperations = [op]; h.setView(v)
  h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, 'job-1')
  const client = createPublicTestnetController(h.options); await client.resume()
  if (invalid.startsWith('local-')) h.values.set(stopGuardKey, JSON.stringify({ operationId: op.operationId, transactionHash: invalid === 'local-hash' ? '1'.repeat(32) : null, status: invalid === 'local-cancelled' ? 'cancelled' : 'awaiting-wallet' }))
  const count = h.requests.length
  expect(client.canRetryPreparation(invalid === 'create' ? 'create' : 'stop')).toBe(false)
  await client.retryPreparation(invalid === 'create' ? 'create' : 'stop')
  expect(client.getSnapshot().error).toBeTruthy(); expect(h.requests).toHaveLength(count)
  expect(h.options.wallet.approve).not.toHaveBeenCalled()
})

for (const invalid of ['same-generation', 'uuid-version']) test(`retry eligible response rejects ${invalid} without reviewing or signing`, async () => {
  const v: any = view(), failed = { operationId: ownerIdFor('stop'), action: 'stop', status: 'UNKNOWN', preparation: { attemptId: generation, state: 'UNISSUED_FAILED' }, request: null, transactionHash: null, signerId: principal.accountId, receipt: null }
  v.ownerOperations = [failed]
  const review = vi.fn(async () => ({ manifest: { owner: principal.accountId, kind: 'stop', mandate: undefined }, candidate: {} })), approve = vi.fn(async () => ({ status: 'cancelled', transactionHash: null }))
  const h = setup({ reviewOwnerOperation: review, wallet: { approve } }); h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, 'job-1')
  h.options.transport = async (url: any) => {
    if (String(url).endsWith('/config')) return Response.json(config)
    if (String(url).endsWith('/owner/retry-prepare')) return Response.json({ walletEligible: true, operation: { ...failed, status: 'AWAITING_WALLET', request: {}, preparation: { attemptId: invalid === 'same-generation' ? generation : generation.replace('-4234-', '-1234-'), state: 'ISSUED' } } })
    return Response.json(v)
  }
  const client = createPublicTestnetController(h.options); await client.resume(); await client.retryPreparation('stop')
  expect(review).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled()
  expect(client.getSnapshot().error).toBeTruthy()
})

for (const phase of ['digest', 'review', 'wallet']) test(`concurrent hash-bearing guard during ${phase} is never overwritten or signed again`, async () => {
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const op: any = { operationId: ownerIdFor('stop'), action: 'stop', status: 'AWAITING_WALLET', preparation: { attemptId: generation, state: 'ISSUED' }, request: {}, transactionHash: null, signerId: principal.accountId, receipt: null }
  const review = vi.fn(async () => { if (phase === 'review') { entered(); await held } return { manifest: { owner: principal.accountId, kind: 'stop', mandate: undefined }, candidate: {} } })
  const approve = vi.fn(async () => { if (phase === 'wallet') { entered(); await held } return { status: 'submitted', transactionHash: '1'.repeat(32) } })
  const h = setup({ reviewOwnerOperation: review, wallet: { approve } }), ordinary = h.options.transport
  h.options.transport = async (url: any, init: any) => String(url).endsWith('/owner/prepare') ? Response.json({ operation: op, walletEligible: true }) : ordinary(url, init)
  const realDigest = crypto.subtle.digest.bind(crypto.subtle)
  if (phase === 'digest') vi.stubGlobal('crypto', { subtle: { digest: async (...args: Parameters<typeof realDigest>) => { entered(); await held; return realDigest(...args) } } })
  try {
    const client = createPublicTestnetController(h.options); await client.resume(); await client.open('approval', 'admission')
    const pending = client.approve('stop'); await started
    const raw = JSON.stringify({ operationId: op.operationId, status: 'submitted', transactionHash: '2'.repeat(32) })
    h.values.set(stopGuardKey, raw); release(); await pending
    expect(h.values.get(stopGuardKey)).toBe(raw)
    expect(approve).toHaveBeenCalledTimes(phase === 'wallet' ? 1 : 0)
    expect(client.getSnapshot().error).toBe('INVALID_SAVED_OWNER_OPERATION')
    expect(client.getSnapshot().wallet).toBeNull()
  } finally { vi.unstubAllGlobals() }
})

test('prepare-loss adoption never overwrites a concurrent saved hash while identity digest is pending', async () => {
  const h = setup(), v: any = view(), operationId = ownerIdFor('stop')
  v.ownerOperations = [{ operationId, action: 'stop', status: 'AWAITING_WALLET', transactionHash: null, signerId: principal.accountId, request: {}, receipt: null }]
  h.setView(v); h.values.set(`haldir-public-job-v1:${origin}:${principal.accountId}`, 'job-1'); h.values.set(stopGuardKey, prepareGuard)
  const replacement = JSON.stringify({ operationId, status: 'submitted', transactionHash: '1'.repeat(32) })
  const bytes = createHash('sha256').update(JSON.stringify(['haldir-owner-v1', 'job-1', 'stop'])).digest()
  vi.stubGlobal('crypto', { subtle: { digest: async () => { h.values.set(stopGuardKey, replacement); return Uint8Array.from(bytes).buffer } } })
  try {
    await h.client.resume()
    expect(h.values.get(stopGuardKey)).toBe(replacement)
    expect(h.client.getSnapshot().error).toBe('INVALID_SAVED_OWNER_OPERATION')
    expect(h.client.getSnapshot().view).toBeNull()
  } finally { vi.unstubAllGlobals() }
})

export { setup, view, principal, config }
