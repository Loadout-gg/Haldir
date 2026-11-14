// Loopback LOCAL qualification only. This is not the unavailable testnet adapter.
// Frozen routes/bodies: src/server/app.mjs. No proof, paid flag or financial
// command can be submitted by this client; only approval identity and {}.
export type LocalJob = {
  jobId: string; quoteId: string; ownerId: string; state: string
  qualification: 'LOCAL_SYNTHETIC_ONLY'
  scope: { purpose: string; output: string }
}
export type LocalOrder = {
  jobId: string; quoteId: string; orderId: string
  quote: { content: string; vendorId: string; amountAtomic: string }
  lifecycle: 'PAYMENT_PENDING' | 'PAID_NOT_DELIVERED' | 'DELIVERED'
  lastCheckCode: string | null
  proof: null | { proofId: string; transactionHash: string; transferReceiptId: string; orderId: string }
  artifact: null | { artifactId: string; orderId: string; fictionalSample: true; qualification: 'LOCAL_SYNTHETIC_ONLY'; content: string; contentDigest: string }
}
export type LocalSnapshot = { job: LocalJob | null; order: LocalOrder | null; busy: boolean; error: string | null }
const token = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const demand = (value: unknown): void => { if (!value) throw new Error('INVALID_LOCAL_RESPONSE') }
// The frozen local handler emits this tuple only after its synthetic session check.
// It is not wallet/testnet authentication, and an arbitrary HTTP error is not it.
class LocalNotFoundError extends Error {}

export function createLocalJourney({ origin, storage, transport = fetch }: {
  origin: string; storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; transport?: typeof fetch
}) {
  const url = new URL(origin)
  const allowed = url.origin === origin && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password
  const storageKey = `haldir-local-ui-v1:${origin}`
  let snapshot: LocalSnapshot = { job: null, order: null, busy: false, error: allowed ? null : 'LOOPBACK_ONLY' }
  const listeners = new Set<() => void>()
  const update = (patch: Partial<LocalSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()) }
  async function request(path: string, body?: object): Promise<unknown> {
    if (!allowed) throw new Error('LOOPBACK_ONLY')
    const response = await transport(origin + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    })
    const data: unknown = await response.json()
    if (!response.ok) {
      const code = object(data) && typeof data.error === 'string' && /^[A-Z_]{1,64}$/.test(data.error) ? data.error : 'LOCAL_HTTP_ERROR'
      if (response.status === 404 && code === 'NOT_FOUND' && object(data) && data.qualification === 'LOCAL_SYNTHETIC_ONLY') throw new LocalNotFoundError(code)
      throw new Error(code)
    }
    return data
  }
  function jobResponse(data: unknown, expected?: string): LocalJob {
    demand(object(data) && token(data.jobId) && (!expected || data.jobId === expected) && text(data.quoteId) && text(data.ownerId) &&
      ['LOCAL_ACTIVE', 'LOCAL_STOPPED'].includes(String(data.state)) && data.qualification === 'LOCAL_SYNTHETIC_ONLY' &&
      object(data.scope) && text(data.scope.purpose) && text(data.scope.output))
    return data as LocalJob
  }
  function orderResponse(data: unknown, job: LocalJob): LocalOrder {
    demand(object(data) && data.jobId === job.jobId && data.quoteId === job.quoteId && token(data.orderId) &&
      object(data.quote) && text(data.quote.content) && text(data.quote.vendorId) && text(data.quote.amountAtomic) &&
      (data.lastCheckCode === null || text(data.lastCheckCode)))
    const order = data as LocalOrder
    demand(['PAYMENT_PENDING', 'PAID_NOT_DELIVERED', 'DELIVERED'].includes(order.lifecycle))
    demand(order.lifecycle === 'PAYMENT_PENDING' ? order.proof === null && order.artifact === null :
      object(order.proof) && order.proof.orderId === order.orderId && text(order.proof.proofId) && text(order.proof.transactionHash) && text(order.proof.transferReceiptId))
    demand(order.lifecycle === 'DELIVERED' ? object(order.artifact) && order.artifact.orderId === order.orderId &&
      order.artifact.fictionalSample === true && order.artifact.qualification === 'LOCAL_SYNTHETIC_ONLY' &&
      text(order.artifact.artifactId) && text(order.artifact.content) && /^[a-f0-9]{64}$/.test(order.artifact.contentDigest) : order.artifact === null)
    return order
  }
  async function run(action: () => Promise<void>) {
    if (snapshot.busy) return
    update({ busy: true, error: null })
    try { await action() }
    catch (error) { update({ error: error instanceof Error ? error.message : 'LOCAL_REQUEST_FAILED' }) }
    finally { update({ busy: false }) }
  }
  async function open() {
    return run(async () => {
      if (!allowed) throw new Error('LOOPBACK_ONLY')
      const saved = storage.getItem(storageKey)
      if (saved !== null && !token(saved)) throw new Error('INVALID_SAVED_LOCAL_JOB')
      let job: LocalJob | undefined
      if (saved) {
        try { job = jobResponse(await request(`/api/jobs/${saved}`), saved) }
        catch (error) {
          if (!(error instanceof LocalNotFoundError)) throw error
          storage.removeItem(storageKey)
        }
      }
      // One original idempotent admission, never recursive open/retry. Errors
      // here or on the order read cannot trigger stale-identity recovery.
      job ??= jobResponse(await request('/api/jobs', { approvalId: 'local-ui-v1', admissionKey: 'local-ui-v1' }))
      // Persist identity immediately, even if the following order read fails.
      storage.setItem(storageKey, job.jobId)
      update({ job })
      const order = orderResponse(await request(`/api/jobs/${job.jobId}/order`), job)
      update({ order })
    })
  }
  async function orderAction(suffix: 'check' | 'delivery') {
    return run(async () => {
      const job = snapshot.job
      if (!job) throw new Error('LOCAL_JOB_REQUIRED')
      const order = orderResponse(await request(`/api/jobs/${job.jobId}/order/${suffix}`, {}), job)
      update({ order })
    })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    open,
    resume: async () => { if (allowed && storage.getItem(storageKey) !== null) await open() },
    check: () => orderAction('check'),
    delivery: () => orderAction('delivery'),
  }
}
