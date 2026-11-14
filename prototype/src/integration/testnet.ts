import { draftMatchesPreview, type PublicDraft, type PublicApprovalPreview } from './public-draft'
import type { LoginPrincipal } from './wallet-auth'
import { createNativeOwnerWallet, prepareOwnerRequest, type OwnerManifest, type UnsignedOwnerCall, type OwnerWalletResult } from './native-owner-wallet'

// Legacy unavailable seam remains compatible with the preserved simulator.
// The separate public-v1 controller below requires explicit qualified ports.
// Owner approval is only for create/stop/withdraw; backend runner owns pay.
export type OwnerAction = 'create' | 'stop' | 'withdraw'
export type TestnetCommand =
  | { type: 'REQUEST_OWNER_APPROVAL'; action: OwnerAction }
  | { type: 'CHECK_STATUS' }
export type BlockedCommand = {
  status: 'blocked'
  reason: 'TESTNET_NOT_CONFIGURED' | 'UNSUPPORTED_COMMAND'
}

// In-memory handoff only, not a transport schema or authoritative status decoder.
// Pending/unknown are unresolved even when no transaction hash was learned.
export type UnresolvedOperation = Readonly<{
  jobId: string
  operationId: string
  kind: OwnerAction | 'pay'
  status: 'pending' | 'unknown'
  transactionHash: string | null
}>
export type TestnetState = Readonly<{
  mode: 'testnet'
  readiness: 'not-configured'
  ownerApproval: 'unavailable'
  unresolvedOperations: readonly UnresolvedOperation[]
}>
export type TestnetController = Readonly<{
  mode: 'testnet'
  state: TestnetState
  dispatch: (command: TestnetCommand) => BlockedCommand
}>

export function createTestnetController(unresolved: readonly UnresolvedOperation[] = []): TestnetController {
  const state: TestnetState = Object.freeze({
    mode: 'testnet', readiness: 'not-configured', ownerApproval: 'unavailable',
    unresolvedOperations: Object.freeze(unresolved.map(operation => Object.freeze({
      jobId: operation.jobId, operationId: operation.operationId, kind: operation.kind,
      status: operation.status, transactionHash: operation.transactionHash,
    }))),
  })
  return Object.freeze({
    mode: 'testnet',
    state,
    dispatch: (command: TestnetCommand): BlockedCommand => {
      const supported = command?.type === 'CHECK_STATUS' ||
        (command?.type === 'REQUEST_OWNER_APPROVAL' &&
          ['create', 'stop', 'withdraw'].includes(command.action))
      return { status: 'blocked', reason: supported ? 'TESTNET_NOT_CONFIGURED' : 'UNSUPPORTED_COMMAND' }
    },
  })
}

// Public-v1 is additive; the original unavailable controller above remains the
// compatibility boundary for simulation. This client only consumes frozen API
// routes. No endpoints or owner request format are inferred from local harnesses.
export type PublicOwnerOperation = { preparation?: null | { attemptId: string; state: 'PREPARING' | 'UNISSUED_FAILED' | 'ISSUED' }; operationId: string; action: OwnerAction; status: 'PREPARING' | 'AWAITING_WALLET' | 'SUBMITTED' | 'UNKNOWN' | 'CONFIRMED' | 'FAILED'; request: unknown; transactionHash: string | null; signerId: string; receipt: null | { amountAtomic?: string; receiptId?: string; [key: string]: unknown } }
export type PublicReportV2 = {
  schemaVersion: 'haldir.report.two-source.v1'; purpose: string; output: string; status: 'PARTIAL' | 'EVIDENCE_REVIEW_REQUIRED'; supplierVerified: false; fictionalSample: true; qualification: string
  purchases: { sourceId: string; quoteId: string; orderId: string; vendorId: string; amountAtomic: string; lifecycle: string; proofId: string | null; artifactId: string | null }[]
  facts: { artifactId: string; excerpt: string; sourceId: string; quoteId: string; orderId: string; vendorId: string; amountAtomic: string; proofId: string; contentDigest: string; fictionalSample: true }[]
  interpretations: { kind: 'COMPARE_COMPANY_DETAILS' | 'COMPARE_SOURCE_CONSISTENCY'; findingIndexes: number[] }[]
  limits: string[]; missing: string[]; nextCheck: { code: string; sourceId: string | null }; ownerActions: { stop: string; withdraw: string; residual: string }
}
export type MandateEconomics = {
  schemaVersion: 'haldir.mandate-economics.v1'
  state: 'known' | 'stale' | 'unavailable' | 'uncertain'
  networkId: 'testnet'; ownerId: string; mandateId: string
  source: { rpcUrl: string; method: 'get_status'; finality: 'final' }
  observation: null | { blockHash: string; blockHeight: number; blockTimestampNs: string; observedAt: number }
  amounts: null | { capAtomic: string; spentAtomic: string; reservedAtomic: string; availableAtomic: string; refundedAtomic: string }
  reason: null | 'STALE_BLOCK' | 'RPC_UNAVAILABLE' | 'BINDING_MISMATCH' | 'NOT_DEPLOYED' | 'NOT_CONFIGURED' | 'OPERATION_UNCERTAIN'
}
export type PublicJourneyView = {
  economics?: MandateEconomics
  contractVersion: 'haldir.public.v1' | 'haldir.public.v2'
  orders?: { sourceId: 'company-records' | 'background-research'; order: PublicJourneyView['order']; payment: PublicJourneyView['payment'] }[]
  ownerApproval?: unknown
  job: { jobId: string; ownerId: string; ownerCreationRequired?: boolean; scope: { purpose: string; output: string; budgetAtomic: string; [key: string]: unknown }; state: 'ACTIVE' | 'STOPPED'; qualification: 'PUBLIC_TESTNET_FICTIONAL_VENDOR'; manifestId: string }
  order: { jobId: string; orderId: string; quote: { amountAtomic: string; vendorId: string }; lifecycle: 'PAYMENT_PENDING' | 'PAID_NOT_DELIVERED' | 'DELIVERED'; proof: null | { transactionHash: string; proofId: string }; artifact: null | { fictionalSample: true; content: string; contentDigest: string; artifactId: string } }
  run: null | { stage: string; report: null | PublicReportV2 | { status: string; supplierVerified: false; findings: { excerpt: string; artifactId: string; proofId: string | null }[]; missing: string[] } }
  payment: { status: 'NOT_STARTED' | 'ATTENTION_REQUIRED' | 'SUBMITTED'; transactionHash: string | null }
  ownerOperations: PublicOwnerOperation[]
  disclosures: { vendorData: 'FICTIONAL_SAMPLE'; supplierVerified: false; principalReturn: string }
}
export type PublicConfig = { contractVersion: 'haldir.public.v1'; networkId: 'testnet'; financialActions: boolean; missingConfiguration: string[]; vendorData: 'FICTIONAL_SAMPLE'; maxRunMs: number }
export type PublicJourneySnapshot = { preview?: PublicApprovalPreview | null; reviewed?: boolean; config: PublicConfig | null; view: PublicJourneyView | null; busy: boolean; error: string | null; wallet: OwnerWalletResult | null }
export type PublicJourneyOptions = {
  origin: string; approvedOrigin?: string; principal: () => LoginPrincipal | null
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; transport?: typeof fetch; now?: () => number
  // Concrete ownerOps prepare returns the flat UnsignedOwnerCall directly.
  // Independent reviewed manifest terms must come from trusted composition,
  // never be inferred from that candidate or selected by URL/window globals.
  requiredOwnerManifest?: (operation: PublicOwnerOperation, view: PublicJourneyView) => OwnerManifest | Promise<OwnerManifest>
  reviewOwnerOperation?: (operation: PublicOwnerOperation, view: PublicJourneyView) => Promise<{ manifest: OwnerManifest; candidate: UnsignedOwnerCall }>
  wallet?: ReturnType<typeof createNativeOwnerWallet>
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
const atomic = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 39 && BigInt(v) < 2n ** 128n
function requirePublic(value: unknown, code = 'INVALID_PUBLIC_RESPONSE'): asserts value { if (!value) throw new Error(code) }
// Only a received, parsed HTTP response is evidence. A thrown transport Error
// with the same message (including timeouts/response loss) is never equivalent.
class PublicHttpError extends Error {
  readonly status: number
  readonly publicError: { contractVersion: 'haldir.public.v1'; error: string } | null
  constructor(status: number, data: unknown) {
    super(record(data) && typeof data.error === 'string' && /^[A-Z_]{1,64}$/.test(data.error) ? data.error : 'PUBLIC_HTTP_FAILED')
    this.name = 'PublicHttpError'
    this.status = status
    this.publicError = record(data) && data.contractVersion === 'haldir.public.v1' && typeof data.error === 'string' && /^[A-Z_]{1,64}$/.test(data.error)
      ? { contractVersion: data.contractVersion, error: data.error } : null
  }
}
// Only the persisted server admission phase can waive creation. Missing legacy
// projections stay closed; neither local manifest terms nor deployment reads
// reinterpret an existing admission. Shared by the controller and workspace.
export function ownerCreationState(view: PublicJourneyView) {
  const required = view.job.ownerCreationRequired !== false
  const confirmed = view.ownerOperations.some(op => {
    const receipt = op.receipt
    return op.action === 'create' && op.status === 'CONFIRMED' && op.signerId === view.job.ownerId &&
      typeof op.transactionHash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(op.transactionHash) &&
      receipt?.status === 'CONFIRMED' && receipt.finality === 'final' && receipt.networkId === 'testnet' &&
      receipt.ownerId === view.job.ownerId && receipt.signerId === view.job.ownerId && receipt.action === 'create' &&
      typeof view.job.scope.mandateId === 'string' && receipt.mandateId === view.job.scope.mandateId && receipt.transactionHash === op.transactionHash
  })
  return { required, canRun: !required || confirmed }
}
function operationResponse(value: unknown, owner: string): PublicOwnerOperation {
  requirePublic(record(value) && typeof value.operationId === 'string' && /^[a-f0-9]{64}$/.test(value.operationId) && ['create', 'stop', 'withdraw'].includes(String(value.action)) &&
    ['PREPARING', 'AWAITING_WALLET', 'SUBMITTED', 'UNKNOWN', 'CONFIRMED', 'FAILED'].includes(String(value.status)) && value.signerId === owner &&
    (value.transactionHash === null || typeof value.transactionHash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.transactionHash)) &&
    (value.receipt === null || record(value.receipt) && (value.receipt.amountAtomic === undefined || atomic(value.receipt.amountAtomic))))
  requirePublic(value.preparation === undefined || value.preparation === null || record(value.preparation) && uuid(value.preparation.attemptId) && ['PREPARING', 'UNISSUED_FAILED', 'ISSUED'].includes(String(value.preparation.state)))
  return value as PublicOwnerOperation
}
function viewResponse(value: unknown, owner: string, expected?: string): PublicJourneyView {
  if (record(value) && value.contractVersion === 'haldir.public.v2') return twoSourceView(value, owner, expected)
  requirePublic(record(value) && value.contractVersion === 'haldir.public.v1' && record(value.job) && token(value.job.jobId) && (!expected || value.job.jobId === expected) &&
    value.job.ownerId === owner && value.job.qualification === 'PUBLIC_TESTNET_FICTIONAL_VENDOR' && ['ACTIVE', 'STOPPED'].includes(String(value.job.state)) && text(value.job.manifestId) &&
    (value.job.ownerCreationRequired === undefined || typeof value.job.ownerCreationRequired === 'boolean') &&
    record(value.job.scope) && text(value.job.scope.purpose) && text(value.job.scope.output) && atomic(value.job.scope.budgetAtomic))
  requirePublic(record(value.order) && value.order.jobId === value.job.jobId && text(value.order.orderId) && record(value.order.quote) && atomic(value.order.quote.amountAtomic) && text(value.order.quote.vendorId) &&
    ['PAYMENT_PENDING', 'PAID_NOT_DELIVERED', 'DELIVERED'].includes(String(value.order.lifecycle)))
  const order = value.order
  requirePublic(order.lifecycle === 'PAYMENT_PENDING' ? order.proof === null && order.artifact === null : record(order.proof) && text(order.proof.proofId) && text(order.proof.transactionHash))
  requirePublic(order.lifecycle === 'DELIVERED' ? record(order.artifact) && order.artifact.fictionalSample === true && text(order.artifact.artifactId) && text(order.artifact.content) && typeof order.artifact.contentDigest === 'string' && /^[a-f0-9]{64}$/.test(order.artifact.contentDigest) : order.artifact === null)
  requirePublic(record(value.payment) && ['NOT_STARTED', 'ATTENTION_REQUIRED', 'SUBMITTED'].includes(String(value.payment.status)) && (value.payment.transactionHash === null || text(value.payment.transactionHash)))
  requirePublic(record(value.disclosures) && value.disclosures.vendorData === 'FICTIONAL_SAMPLE' && value.disclosures.supplierVerified === false && text(value.disclosures.principalReturn))
  requirePublic(Array.isArray(value.ownerOperations))
  const operations = value.ownerOperations.map(v => operationResponse(v, owner))
  requirePublic(new Set(operations.map(v => v.action)).size === operations.length)
  requirePublic(value.run === null || record(value.run) && text(value.run.stage) && (value.run.report === null || record(value.run.report) && text(value.run.report.status) && value.run.report.supplierVerified === false &&
    Array.isArray(value.run.report.findings) && value.run.report.findings.every(v => record(v) && text(v.excerpt) && text(v.artifactId) && (v.proofId === null || text(v.proofId))) && Array.isArray(value.run.report.missing) && value.run.report.missing.every(text)))
  if (Object.hasOwn(value,'economics')) economicsResponse(value.economics, value.job)
  return value as PublicJourneyView
}
const exactKeys = (v: unknown, keys: string) => record(v) && Object.keys(v).sort().join('|') === keys.split(' ').sort().join('|')
const nearAccount = (v: unknown): v is string => typeof v === 'string' && v.length >= 2 && v.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v)
const u64 = (v: unknown): v is string => atomic(v) && BigInt(v) < 2n ** 64n
function blockHash(v: unknown): boolean {
  if (typeof v !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return false
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = 0n
  for (const c of v) n = n * 58n + BigInt(alphabet.indexOf(c))
  const zeros = v.match(/^1*/)?.[0].length ?? 0
  return zeros + (n === 0n ? 0 : Math.ceil(n.toString(2).length / 8)) === 32
}
function economicsResponse(v: unknown, job: Record<string, unknown>): MandateEconomics {
  requirePublic(exactKeys(v,'schemaVersion state networkId ownerId mandateId source observation amounts reason') && record(v) && v.schemaVersion === 'haldir.mandate-economics.v1' &&
    record(job.scope) && job.scope.networkId === 'testnet' && v.networkId === job.scope.networkId && nearAccount(v.ownerId) && v.ownerId === job.ownerId && nearAccount(v.mandateId) && v.mandateId === job.scope.mandateId &&
    exactKeys(v.source,'rpcUrl method finality') && record(v.source) && v.source.method === 'get_status' && v.source.finality === 'final' && typeof v.source.rpcUrl === 'string')
  let endpoint: URL | null = null
  try { endpoint = new URL(v.source.rpcUrl) } catch { /* reject below */ }
  requirePublic(endpoint && endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && !endpoint.hostname.includes('mainnet') && (v.source.rpcUrl === endpoint.origin || v.source.rpcUrl === endpoint.origin + '/'))
  const observed = v.observation !== null && v.amounts !== null
  requirePublic(observed || v.observation === null && v.amounts === null)
  if (observed) {
    const o = v.observation, a = v.amounts
    requirePublic(exactKeys(o,'blockHash blockHeight blockTimestampNs observedAt') && record(o) && blockHash(o.blockHash) && Number.isSafeInteger(o.blockHeight) && Number(o.blockHeight) > 0 &&
      u64(o.blockTimestampNs) && Number.isSafeInteger(o.observedAt) && Number(o.observedAt) >= 0 && BigInt(o.blockTimestampNs) <= BigInt(Number(o.observedAt))*1000000n &&
      exactKeys(a,'capAtomic spentAtomic reservedAtomic availableAtomic refundedAtomic') && record(a) && Object.values(a).every(atomic) && a.capAtomic === job.scope.budgetAtomic)
    requirePublic(BigInt(String(a.spentAtomic))+BigInt(String(a.reservedAtomic))+BigInt(String(a.availableAtomic))+BigInt(String(a.refundedAtomic)) === BigInt(String(a.capAtomic)))
    if (v.state === 'known') requirePublic(BigInt(Number(o.observedAt))*1000000n - BigInt(o.blockTimestampNs) <= 30000000000n)
  }
  requirePublic(v.state === 'known' && observed && v.reason === null || v.state === 'stale' && observed && v.reason === 'STALE_BLOCK' ||
    v.state === 'unavailable' && !observed && ['RPC_UNAVAILABLE','BINDING_MISMATCH','NOT_DEPLOYED','NOT_CONFIGURED'].includes(String(v.reason)) ||
    v.state === 'uncertain' && v.reason === 'OPERATION_UNCERTAIN')
  return v as MandateEconomics
}
// Renderer/controller clock projection only. Preserve the actual observation
// time and values; elapsed time is never a new balance observation or permission.
export function ageMandateEconomics(economics: MandateEconomics | undefined, clock: number): MandateEconomics | undefined {
  if (economics?.state !== 'known' || !economics.observation) return economics
  const o = economics.observation
  if (Number.isSafeInteger(clock) && clock >= o.observedAt && BigInt(clock)*1000000n - BigInt(o.blockTimestampNs) <= 30000000000n) return economics
  return { ...economics, state: 'stale', reason: 'STALE_BLOCK' }
}
const same = (a: unknown, b: unknown): boolean => a === b || Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v,b[i])) || record(a) && record(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => same(a[k],b[k]))
const sourceIds = ['company-records', 'background-research'] as const
function twoSourceView(value: Record<string, unknown>, owner: string, expected?: string): PublicJourneyView {
  requirePublic(exactKeys(value, 'contractVersion job order run payment orders ownerOperations ownerApproval disclosures') || exactKeys(value, 'contractVersion job order run payment orders ownerOperations ownerApproval disclosures economics'))
  requirePublic(record(value.job) && value.job.schemaVersion === 'haldir.job.two-source.v1' && Array.isArray(value.job.sourceRefs) && value.job.sourceRefs.length === 2 && Array.isArray(value.orders) && value.orders.length === 2)
  const job = value.job, members = value.orders
  requirePublic(record(job.scope) && Array.isArray(job.scope.vendorIds) && job.scope.vendorIds.length === 2 && atomic(job.scope.budgetAtomic))
  let total = 0n
  const quotes: string[] = [], vendors: string[] = [], orderIds: string[] = []
  members.forEach((m, i) => {
    requirePublic(exactKeys(m,'sourceId order payment') && record(m) && m.sourceId === sourceIds[i] && record(m.order) && record(m.payment))
    const o = m.order, ref = (job.sourceRefs as unknown[])[i]
    requirePublic(exactKeys(o,'jobId quoteId orderId quote lifecycle proof artifact lastCheckCode') && text(o.quoteId) && exactKeys(ref,'sourceId quoteId') && record(ref) && ref.sourceId === m.sourceId && ref.quoteId === o.quoteId)
    requirePublic(record(o.quote) && exactKeys(o.quote,'networkId mandateId vendorId amountAtomic orderId content') && o.quote.networkId === 'testnet' && o.quote.mandateId === (job.scope as Record<string,unknown>).mandateId && o.orderId === o.quote.orderId && text(o.quote.content) && atomic(o.quote.amountAtomic) && BigInt(o.quote.amountAtomic) > 0n && o.quote.vendorId === ((job.scope as Record<string,unknown>).vendorIds as unknown[])[i])
    const key = btoa(unescape(encodeURIComponent(JSON.stringify(['haldir-local-v1',o.quote.networkId,o.quote.mandateId,o.orderId])))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
    requirePublic(o.quoteId === key)
    total += BigInt(o.quote.amountAtomic); quotes.push(o.quoteId); vendors.push(String(o.quote.vendorId)); orderIds.push(String(o.orderId))
    if (o.proof !== null) {
      requirePublic(record(o.proof) && ['networkId','mandateId','vendorId','amountAtomic','orderId'].every(k => o.proof && record(o.proof) && o.proof[k] === (o.quote as Record<string,unknown>)[k]) && m.payment.status === 'SUBMITTED' && m.payment.transactionHash === o.proof.transactionHash)
    }
    if (o.artifact !== null) requirePublic(record(o.artifact) && o.artifact.artifactId === 'fictional:' + o.quoteId && o.artifact.orderId === o.orderId && o.artifact.vendorId === o.quote.vendorId)
    // Exercise incumbent owner, lifecycle, operation and disclosure checks per member.
    viewResponse({ ...value, contractVersion: 'haldir.public.v1', order: o, payment: m.payment, run: null }, owner, expected)
  })
  requirePublic(total < 2n ** 128n && total <= BigInt(job.scope.budgetAtomic) && new Set(quotes).size === 2 && new Set(vendors).size === 2 && new Set(orderIds).size === 2 && same(value.order,members[0].order) && same(value.payment,members[0].payment))
  requirePublic(value.run === null || exactKeys(value.run,'stage report') && record(value.run) && text(value.run.stage))
  if (record(value.run) && value.run.report !== null) {
    const r = value.run.report
    requirePublic(exactKeys(r,'schemaVersion purpose output status supplierVerified fictionalSample qualification purchases facts interpretations limits nextCheck missing ownerActions') && record(r) && r.schemaVersion === 'haldir.report.two-source.v1' && r.purpose === job.scope.purpose && r.output === job.scope.output && ['PARTIAL','EVIDENCE_REVIEW_REQUIRED'].includes(String(r.status)) && r.supplierVerified === false && r.fictionalSample === true && r.qualification === job.qualification)
    const purchases = members.map(m => { const o = m.order as Record<string,unknown>, q = o.quote as Record<string,unknown>; return { sourceId: m.sourceId, quoteId: o.quoteId, orderId: o.orderId, vendorId: q.vendorId, amountAtomic: q.amountAtomic, lifecycle: o.lifecycle, proofId: record(o.proof) ? o.proof.proofId : null, artifactId: record(o.artifact) ? o.artifact.artifactId : null } })
    requirePublic(same(r.purchases,purchases) && Array.isArray(r.facts) && r.facts.length <= 12 && Array.isArray(r.interpretations) && r.interpretations.length <= 2 && Array.isArray(r.missing) && r.missing.every(text))
    r.facts.forEach(f => {
      requirePublic(exactKeys(f,'artifactId excerpt sourceId quoteId orderId vendorId amountAtomic proofId contentDigest fictionalSample') && record(f))
      const m = members.find(m => m.sourceId === f.sourceId), o = m?.order as Record<string,unknown> | undefined, a = o?.artifact, q = o?.quote
      requirePublic(o && record(a) && record(q) && record(o.proof) && f.artifactId === a.artifactId && f.quoteId === o.quoteId && f.orderId === o.orderId && f.vendorId === q.vendorId && f.amountAtomic === q.amountAtomic && f.proofId === o.proof.proofId && f.contentDigest === a.contentDigest && f.fictionalSample === true && text(f.excerpt) && f.excerpt.length <= 4096 && String(a.content).includes(f.excerpt))
    })
    requirePublic(new Set(r.interpretations.map(v => record(v) ? v.kind : null)).size === r.interpretations.length)
    r.interpretations.forEach(v => {
      requirePublic(exactKeys(v,'kind findingIndexes') && record(v) && ['COMPARE_COMPANY_DETAILS','COMPARE_SOURCE_CONSISTENCY'].includes(String(v.kind)) && Array.isArray(v.findingIndexes) && v.findingIndexes.length >= 1 && v.findingIndexes.length <= 12 && new Set(v.findingIndexes).size === v.findingIndexes.length && v.findingIndexes.every(i => Number.isInteger(i) && Number(i) >= 0 && Number(i) < (r.facts as unknown[]).length))
      if (v.kind === 'COMPARE_SOURCE_CONSISTENCY') requirePublic(new Set(v.findingIndexes.map(i => ((r.facts as Record<string,unknown>[])[Number(i)]).sourceId)).size === 2)
    })
    const both = members.every(m => record((m.order as Record<string,unknown>).artifact))
    const limits = ['FICTIONAL_SAMPLE','SOURCE_ACCURACY_NOT_VERIFIED','NO_SIGNING_ASSURANCE', ...(!both ? ['INCOMPLETE_EVIDENCE'] : [])]
    requirePublic(Array.isArray(r.limits) && (same(r.limits,limits) || same(r.limits,[...limits,'MODEL_REPORT_UNAVAILABLE'])) && (r.status !== 'EVIDENCE_REVIEW_REQUIRED' || both && sourceIds.every(id => (r.facts as Record<string,unknown>[]).some(f => f.sourceId === id)) && r.missing.length === 0) && (both || r.status === 'PARTIAL'))
    requirePublic(exactKeys(r.nextCheck,'code sourceId') && record(r.nextCheck) && ['CHECK_SAME_PAYMENT','RETRIEVE_SAME_DELIVERY','OWNER_REVIEW','RESUME_APPROVED_JOB','REVIEW_REPORT_AVAILABILITY','COMPARE_SOURCES_WITH_CONTRACT'].includes(String(r.nextCheck.code)) && (r.nextCheck.sourceId === null || sourceIds.includes(r.nextCheck.sourceId as typeof sourceIds[number])) && same(r.ownerActions,{ stop: 'OWNER_ACTION_REQUIRED', withdraw: 'OWNER_ACTION_REQUIRED', residual: 'NOT_OBSERVED' }))
  }
  return value as unknown as PublicJourneyView
}
// A local review identity only; independent owner-request validation still runs.
export function creationCostIdentity(view: PublicJourneyView, sessionId: string): string | null {
  const e = view.ownerApproval, s = view.job.scope
  if (!record(e) || !record(e.actions) || !record(e.actions.create)) return null
  const c = e.actions.create
  const valid = e.manifestId === view.job.manifestId && e.jobId === view.job.jobId && e.ownerId === view.job.ownerId && e.mandateId === s.mandateId && c.network === 'testnet' && c.kind === 'create' && c.owner === view.job.ownerId && c.mandate === s.mandateId && c.cap === s.budgetAtomic && same(c.allowlist,s.vendorIds) && typeof s.expiresAt === 'string' && Number.isSafeInteger(Date.parse(s.expiresAt)) && c.deadline_ns === String(BigInt(Date.parse(s.expiresAt))*1000000n) && atomic(c.operating_float) && BigInt(c.operating_float) > 0n && atomic(c.gas) && BigInt(c.gas) > 0n && atomic(s.budgetAtomic) && BigInt(s.budgetAtomic) + BigInt(c.operating_float) < 2n**128n
  return valid ? JSON.stringify([sessionId,view.job,e]) : null
}
function approvalResponse(value: unknown, owner: string, approvalId: string): PublicApprovalPreview {
  requirePublic(exactKeys(value,'contractVersion approvalId manifestId ownerId approved ownerCreationRequired') && record(value) && value.approvalId === approvalId && value.ownerId === owner && text(value.manifestId) && typeof value.ownerCreationRequired === 'boolean' && record(value.approved))
  const a = value.approved, j = a.job
  requirePublic(exactKeys(j,'networkId mandateId purpose output budgetAtomic vendorIds expiresAt') && record(j) && j.networkId === 'testnet' && text(j.mandateId) && text(j.purpose) && text(j.output) && atomic(j.budgetAtomic) && BigInt(j.budgetAtomic) > 0n && text(j.expiresAt) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(j.expiresAt) && Number.isFinite(Date.parse(j.expiresAt)) && Array.isArray(j.vendorIds))
  const sources = value.contractVersion === 'haldir.public.v2' ? (requirePublic(exactKeys(a,'schemaVersion job sources') && a.schemaVersion === 'haldir.approved.two-source.v1' && Array.isArray(a.sources) && a.sources.length === 2), a.sources) : (requirePublic(value.contractVersion === 'haldir.public.v1' && exactKeys(a,'job quote')), [{ sourceId:'legacy', quote:a.quote }])
  let total = 0n
  const ids: string[] = [], descriptions: string[] = []
  sources.forEach((m, i) => {
    requirePublic(exactKeys(m,'sourceId quote') && record(m) && m.sourceId === (sources.length === 2 ? sourceIds[i] : 'legacy') && record(m.quote))
    const q = m.quote
    requirePublic(exactKeys(q,'networkId mandateId vendorId amountAtomic orderId content') && q.networkId === j.networkId && q.mandateId === j.mandateId && q.vendorId === (j.vendorIds as unknown[])[i] && text(q.vendorId) && atomic(q.amountAtomic) && BigInt(q.amountAtomic) > 0n && text(q.orderId) && text(q.content))
    total += BigInt(q.amountAtomic); ids.push(q.orderId); descriptions.push(q.content)
  })
  requirePublic(j.vendorIds.length === sources.length && new Set(j.vendorIds).size === sources.length && new Set(ids).size === sources.length && new Set(descriptions).size === sources.length && total < 2n ** 128n && total <= BigInt(j.budgetAtomic))
  return value as unknown as PublicApprovalPreview
}
export function createPublicTestnetController({ origin, approvedOrigin, principal, storage, transport = fetch, now = Date.now, requiredOwnerManifest, reviewOwnerOperation: suppliedReview, wallet = createNativeOwnerWallet({ principal, now }) }: PublicJourneyOptions) {
  const reviewOwnerOperation = suppliedReview ?? (requiredOwnerManifest ? async (operation: PublicOwnerOperation, view: PublicJourneyView) => {
    const manifest = await requiredOwnerManifest(operation, view)
    const candidate = operation.request as UnsignedOwnerCall
    await prepareOwnerRequest(manifest, candidate)
    return { manifest, candidate }
  } : undefined)
  let snapshot: PublicJourneySnapshot = { config: null, view: null, busy: false, error: null, wallet: null }
  const listeners = new Set<() => void>()
  const update = (patch: Partial<PublicJourneySnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()) }
  function session() {
    const p = principal()
    requirePublic(p && p.networkId === 'testnet' && p.origin === origin && p.expiresAt > now(), 'OWNER_SESSION_REQUIRED')
    const url = new URL(origin)
    requirePublic(approvedOrigin === origin && url.origin === origin && url.protocol === 'https:' && !url.username && !url.password, 'APPROVED_HTTPS_ORIGIN_REQUIRED')
    return p
  }
  const savedKey = (owner: string) => `haldir-public-job-v1:${origin}:${owner}`
  async function request(path: string, body?: object): Promise<unknown> {
    const p = { ...session() }
    const response = await transport(origin + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-haldir-csrf': '1' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
    requirePublic(session().sessionId === p.sessionId, 'OWNER_SESSION_CHANGED')
    const data: unknown = await response.json()
    requirePublic(session().sessionId === p.sessionId, 'OWNER_SESSION_CHANGED')
    if (!response.ok) throw new PublicHttpError(response.status, data)
    return data
  }
  async function runAction(action: () => Promise<void>) {
    if (snapshot.busy) return
    update({ busy: true, error: null })
    try { session(); await action() }
    catch (error) { update({ error: error instanceof Error ? error.message : 'PUBLIC_REQUEST_FAILED' }) }
    finally { update({ busy: false }) }
  }
  async function configRead() {
    const data = await request('/api/public/config', {})
    requirePublic(record(data) && data.contractVersion === 'haldir.public.v1' && data.networkId === 'testnet' && typeof data.financialActions === 'boolean' && Array.isArray(data.missingConfiguration) && data.missingConfiguration.every(text) && data.vendorData === 'FICTIONAL_SAMPLE' && Number.isSafeInteger(data.maxRunMs) && Number(data.maxRunMs) > 0)
    update({ config: data as PublicConfig })
  }
  function available() { requirePublic(snapshot.config?.financialActions, 'FINANCIAL_NOT_CONFIGURED') }
  function job() { const v = snapshot.view; requirePublic(v && v.job.ownerId === session().accountId, 'PUBLIC_JOB_REQUIRED'); return v }
  async function ownedView(value: unknown, expected?: string) {
    const p = { ...session() }, data = viewResponse(value, p.accountId, expected)
    if (data.economics?.observation) requirePublic(data.economics.observation.observedAt <= now())
    if (data.contractVersion === 'haldir.public.v2') {
      const proofs = data.orders!.flatMap(m => m.order.proof ? [m.order.proof.proofId] : [])
      requirePublic(new Set(proofs).size === proofs.length)
      for (const member of data.orders!) if (member.order.artifact) {
        const artifact = member.order.artifact
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(artifact.content))
        requirePublic(artifact.contentDigest === [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2,'0')).join(''))
      }
    }
    for (const op of data.ownerOperations) {
      // Legacy rows remain readable but never establish retry eligibility.
      if (!op.preparation) continue
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['haldir-owner-v1', data.job.jobId, op.action])))
      const expectedId = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
      requirePublic(op.operationId === expectedId, 'INVALID_PUBLIC_RESPONSE')
    }
    requirePublic(session().sessionId === p.sessionId && session().accountId === p.accountId, 'OWNER_SESSION_CHANGED')
    const previous = snapshot.view
    if (previous?.contractVersion === 'haldir.public.v2' && previous.job.jobId === data.job.jobId && previous.job.ownerId === data.job.ownerId) {
      const immutable = (v: PublicJourneyView) => [v.contractVersion,v.job.manifestId,v.job.scope,v.orders?.map(m=>({sourceId:m.sourceId,quote:m.order.quote}))]
      if (!same(immutable(previous),immutable(data))) { reviewedCreation = null; throw new Error('APPROVED_TERMS_CHANGED') }
    }
    return data
  }
  async function readJob(id: string) {
    requirePublic(token(id), 'INVALID_SAVED_PUBLIC_JOB')
    const p = { ...session() }
    const data = await ownedView(await request(`/api/public/jobs/${id}`, {}), id)
    let retained: OwnerWalletResult | null = null
    const adopted: { key: string; value: string; operationId: string }[] = []
    for (const op of data.ownerOperations) {
      const key = attemptKey(data, op.action), raw = storage.getItem(key)
      if (raw === null) continue
      const saved: unknown = JSON.parse(raw)
      requirePublic(record(saved), 'INVALID_SAVED_OWNER_OPERATION')
      const placeholder = Object.keys(saved).sort().join('|') === 'operationId|status|transactionHash' &&
        saved.operationId === null && saved.status === 'preparing' && saved.transactionHash === null
      if (placeholder) {
        // Only the exact pre-response guard can acquire an ID, from the owned
        // job projection and the server's job/action operation identity scheme.
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['haldir-owner-v1', data.job.jobId, op.action])))
        const expected = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('')
        requirePublic(op.operationId === expected, 'INVALID_SAVED_OWNER_OPERATION')
        adopted.push({ key, operationId: op.operationId, value: JSON.stringify({ operationId: op.operationId, status: 'unknown', transactionHash: null }) })
      } else {
        requirePublic(saved.operationId === op.operationId &&
          (saved.transactionHash === null || typeof saved.transactionHash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(saved.transactionHash)) &&
          (saved.transactionHash === null || op.transactionHash === null || saved.transactionHash === op.transactionHash), 'INVALID_SAVED_OWNER_OPERATION')
      }
      if (['CONFIRMED', 'FAILED'].includes(op.status)) continue
      retained = { status: saved.status === 'cancelled' ? 'cancelled' : saved.status === 'submitted' ? 'submitted' : 'unknown', transactionHash: saved.transactionHash as string | null }
    }
    requirePublic(p.sessionId === session().sessionId && data.job.ownerId === session().accountId, 'OWNER_SESSION_CHANGED')
    for (const entry of adopted) checkOwnerGuard(entry.key, entry.operationId)
    for (const entry of adopted) storage.setItem(entry.key, entry.value)
    if (snapshot.view && creationCostIdentity(snapshot.view,p.sessionId) !== creationCostIdentity(data,p.sessionId)) reviewedCreation = null
    update({ view: data, wallet: retained })
  }
  const attemptKey = (v: PublicJourneyView, action: OwnerAction) => `haldir-public-owner-v1:${origin}:${v.job.ownerId}:${v.job.jobId}:${action}`
  async function reconcile(v: PublicJourneyView, operation: PublicOwnerOperation, hash: string) {
    const response = await request(`/api/public/jobs/${v.job.jobId}/owner/receipt`, { operationId: operation.operationId, transactionHash: hash, signerId: v.job.ownerId })
    requirePublic(record(response))
    const observed = operationResponse(response.operation, v.job.ownerId)
    requirePublic(observed.operationId === operation.operationId && observed.action === operation.action && observed.transactionHash === hash)
    // The operation POST is not sufficient: read back the exact job projection.
    await readJob(v.job.jobId)
  }
  let reviewedCreation: string | null = null
  const approve = (action: OwnerAction) => runAction(async () => {
    requirePublic(['create', 'stop', 'withdraw'].includes(action), 'UNSUPPORTED_COMMAND')
    if (action === 'create') available()
    const v = job()
    if (action === 'create') {
      requirePublic(ownerCreationState(v).required, 'OWNER_CREATION_NOT_REQUIRED')
      if (v.contractVersion === 'haldir.public.v2') requirePublic(reviewedCreation !== null && reviewedCreation === creationCostIdentity(v,session().sessionId),'CREATION_COST_REVIEW_REQUIRED')
    }
    requirePublic(reviewOwnerOperation, 'OWNER_REQUEST_CONTRACT_REQUIRED')
    const key = attemptKey(v, action)
    requirePublic(!v.ownerOperations.some(o => o.action === action) && storage.getItem(key) === null, 'OWNER_OPERATION_REQUIRES_RECONCILIATION')
    // Persist before the preparatory HTTP write; lost prepare responses also
    // stay lookup-only. This is a conservative browser guard, not a backend lock.
    // HTTP rejection is not authority to release the browser guard: another
    // context can have an identical placeholder and an outstanding prior write.
    const guard = JSON.stringify({ operationId: null, status: 'preparing', transactionHash: null })
    storage.setItem(key, guard)
    const response = await request(`/api/public/jobs/${v.job.jobId}/owner/prepare`, { action })
    await completePreparation(v, action, response)
  })
  function checkOwnerGuard(key: string, operationId: string, returnedHash: string | null = null) {
    const raw = storage.getItem(key)
    if (raw === null) return
    const saved: unknown = JSON.parse(raw)
    requirePublic(record(saved), 'INVALID_SAVED_OWNER_OPERATION')
    const placeholder = Object.keys(saved).sort().join('|') === 'operationId|status|transactionHash' &&
      saved.operationId === null && saved.status === 'preparing' && saved.transactionHash === null
    // This is an identity/hash fence, not a browser lock or a claim of CAS.
    // Only the server's atomic generation claim can authorize a wallet prompt.
    requirePublic(placeholder || saved.operationId === operationId &&
      (saved.transactionHash === null && ['unknown', 'awaiting-wallet'].includes(String(saved.status)) ||
        returnedHash !== null && saved.transactionHash === returnedHash), 'INVALID_SAVED_OWNER_OPERATION')
  }
  async function completePreparation(v: PublicJourneyView, action: OwnerAction, response: unknown, priorAttemptId?: string) {
    requirePublic(reviewOwnerOperation, 'OWNER_REQUEST_CONTRACT_REQUIRED')
    const key = attemptKey(v, action)
    requirePublic(record(response))
    const operation = operationResponse(response.operation, v.job.ownerId)
    requirePublic(operation.action === action, 'OWNER_OPERATION_REQUIRES_RECONCILIATION')
    if (response.walletEligible !== true) { await readJob(v.job.jobId); return }
    const { sessionId: responseSessionId } = session()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['haldir-owner-v1', v.job.jobId, action])))
    requirePublic(session().sessionId === responseSessionId && session().accountId === v.job.ownerId, 'OWNER_SESSION_CHANGED')
    const expectedId = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
    requirePublic(operation.operationId === expectedId && operation.status === 'AWAITING_WALLET' && operation.transactionHash === null && operation.preparation?.state === 'ISSUED' && operation.preparation.attemptId !== priorAttemptId, 'OWNER_OPERATION_REQUIRES_RECONCILIATION')
    checkOwnerGuard(key, operation.operationId)
    storage.setItem(key, JSON.stringify({ operationId: operation.operationId, status: 'awaiting-wallet', transactionHash: null }))
    const p = { ...session() }
    const reviewed = await reviewOwnerOperation(operation, v)
    requirePublic(session().sessionId === p.sessionId && session().accountId === v.job.ownerId, 'OWNER_SESSION_CHANGED')
    requirePublic(reviewed.manifest.owner === v.job.ownerId && reviewed.manifest.kind === action && reviewed.manifest.mandate === v.job.scope.mandateId, 'OWNER_TERMS_BINDING_CHANGED')
    checkOwnerGuard(key, operation.operationId)
    const result = await wallet.approve(reviewed.manifest, reviewed.candidate)
    requirePublic(session().sessionId === p.sessionId && session().accountId === v.job.ownerId, 'OWNER_SESSION_CHANGED')
    checkOwnerGuard(key, operation.operationId, result.transactionHash)
    storage.setItem(key, JSON.stringify({ operationId: operation.operationId, ...result }))
    update({ wallet: result })
    if (result.transactionHash) await reconcile(v, operation, result.transactionHash)
    // Null hash (including cancellation) has no receipt endpoint in v1. Never
    // manufacture a hash, report success, or erase identity to ask again.
    else await readJob(v.job.jobId)
  }
  function retryGeneration(action: OwnerAction): string | null {
    if (action !== 'stop' && action !== 'withdraw') return null
    const v = job()
    const op = v.ownerOperations.find(o => o.action === action)
    const raw = storage.getItem(attemptKey(v, action))
    if (op) {
      if (raw !== null) {
        const saved: unknown = JSON.parse(raw)
        if (!record(saved) || saved.transactionHash !== null ||
          !((saved.operationId === null && saved.status === 'preparing' && Object.keys(saved).sort().join('|') === 'operationId|status|transactionHash') ||
            (saved.operationId === op.operationId && saved.status === 'unknown'))) return null
      }
      if (op.status !== 'UNKNOWN' || op.transactionHash !== null || op.request !== null || op.receipt !== null ||
        op.preparation?.state !== 'UNISSUED_FAILED' || !uuid(op.preparation.attemptId)) return null
      return op.preparation.attemptId
    }
    if (raw === null) return null
    const saved: unknown = JSON.parse(raw)
    return record(saved) && Object.keys(saved).sort().join('|') === 'operationId|status|transactionHash' &&
      saved.operationId === null && saved.status === 'preparing' && saved.transactionHash === null ? 'unreserved' : null
  }
  const retryPreparation = (action: OwnerAction) => runAction(async () => {
    const v = job(), attemptId = retryGeneration(action)
    requirePublic(attemptId !== null, 'OWNER_OPERATION_REQUIRES_RECONCILIATION')
    requirePublic(reviewOwnerOperation, 'OWNER_REQUEST_CONTRACT_REQUIRED')
    const { sessionId } = session()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['haldir-owner-v1', v.job.jobId, action])))
    requirePublic(session().sessionId === sessionId && session().accountId === v.job.ownerId, 'OWNER_SESSION_CHANGED')
    const operationId = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
    requirePublic(!v.ownerOperations.some(op => op.action === action && op.operationId !== operationId), 'OWNER_OPERATION_REQUIRES_RECONCILIATION')
    const response = await request(`/api/public/jobs/${v.job.jobId}/owner/retry-prepare`, { action, operationId, attemptId })
    await completePreparation(v, action, response, attemptId)
  })
  let review: { sessionId: string; preview: PublicApprovalPreview; draft: PublicDraft } | null = null
  let reviewGeneration = 0
  const invalidateReview = () => { reviewedCreation = null; reviewGeneration++; review = null; update({ reviewed:false }) }
  async function readApproval(approvalId: string) {
    requirePublic(token(approvalId),'APPROVAL_IDENTITY_REQUIRED')
    const p = { ...session() }
    const data = approvalResponse(await request('/api/public/approvals/read',{ approvalId }),p.accountId,approvalId)
    requirePublic(session().sessionId === p.sessionId,'OWNER_SESSION_CHANGED')
    return data
  }
  return {
    invalidateReview,
    reviewCreationCosts: () => runAction(async () => { const identity = creationCostIdentity(job(),session().sessionId); requirePublic(identity,'CREATION_COST_REVIEW_REQUIRED'); reviewedCreation = identity }),
    readApproval: (approvalId: string) => runAction(async () => { invalidateReview(); update({ preview:null }); const preview = await readApproval(approvalId); update({ preview }) }),
    reviewDraft: (draft: PublicDraft) => runAction(async () => {
      invalidateReview(); const generation = reviewGeneration; const selected = snapshot.preview; requirePublic(selected,'TRUSTED_APPROVAL_REQUIRED')
      const p = { ...session() }, fresh = await readApproval(selected.approvalId)
      requirePublic(same(selected,fresh),'APPROVED_TERMS_CHANGED')
      requirePublic(draftMatchesPreview(draft,fresh),'NEEDS_OPERATOR_APPROVED_TERMS')
      requirePublic(Date.parse(fresh.approved.job.expiresAt) > now(),'DEADLINE_EXPIRED')
      requirePublic(generation === reviewGeneration,'CORE_TERMS_REVIEW_REQUIRED')
      review = { sessionId:p.sessionId, preview:structuredClone(fresh), draft:structuredClone(draft) }; update({ preview:fresh, reviewed:true })
    }),
    admitReviewed: (admissionKey: string, draft: PublicDraft) => runAction(async () => {
      const accepted = review; requirePublic(accepted && accepted.sessionId === session().sessionId && same(accepted.draft,draft),'CORE_TERMS_REVIEW_REQUIRED')
      const fresh = await readApproval(accepted.preview.approvalId)
      requirePublic(review === accepted && same(accepted.preview,fresh) && draftMatchesPreview(draft,fresh),'APPROVED_TERMS_CHANGED')
      requirePublic(accepted.sessionId === session().sessionId,'OWNER_SESSION_CHANGED'); available(); requirePublic(token(admissionKey),'APPROVAL_IDENTITY_REQUIRED')
      const saved = storage.getItem(savedKey(session().accountId)); if (saved !== null) { await readJob(saved); return }
      const data = await ownedView(await request('/api/public/jobs',{ approvalId:fresh.approvalId, admissionKey }))
      requirePublic(data.job.manifestId === fresh.manifestId && same(data.job.scope,fresh.approved.job) && data.contractVersion === fresh.contractVersion,'APPROVED_TERMS_CHANGED')
      requirePublic(review === accepted && 'sources' in fresh.approved && same(data.orders?.map(m => ({sourceId:m.sourceId,quote:m.order.quote})),fresh.approved.sources),'APPROVED_TERMS_CHANGED')
      storage.setItem(savedKey(session().accountId),data.job.jobId); update({ view:data }); invalidateReview()
    }),
    ownerApprovalAvailable: Boolean(reviewOwnerOperation),
    getSnapshot: () => {
      const e = snapshot.view?.economics, aged = ageMandateEconomics(e,now())
      // Cache the changed snapshot once for useSyncExternalStore stability.
      if (snapshot.view && aged !== e) snapshot = { ...snapshot, view: { ...snapshot.view, economics: aged } }
      return snapshot
    },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    resume: () => runAction(async () => { await configRead(); const id = storage.getItem(savedKey(session().accountId)); if (id !== null) await readJob(id) }),
    open: (approvalId: string, admissionKey: string) => runAction(async () => {
      requirePublic(token(approvalId) && token(admissionKey), 'APPROVAL_IDENTITY_REQUIRED')
      const p = { ...session() }, saved = storage.getItem(savedKey(p.accountId))
      if (saved !== null) { await readJob(saved); return }
      available()
      const data = await ownedView(await request('/api/public/jobs', { approvalId, admissionKey }))
      storage.setItem(savedKey(p.accountId), data.job.jobId)
      update({ view: data })
    }),
    refresh: () => runAction(async () => {
      await readJob(job().job.jobId)
      const v = job()
      for (const op of v.ownerOperations) {
        if (['CONFIRMED', 'FAILED'].includes(op.status)) continue
        const raw = storage.getItem(attemptKey(v, op.action))
        if (raw === null) continue
        const saved: unknown = JSON.parse(raw)
        requirePublic(record(saved) && saved.operationId === op.operationId, 'INVALID_SAVED_OWNER_OPERATION')
        if (saved.transactionHash !== null) {
          requirePublic(typeof saved.transactionHash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(saved.transactionHash), 'INVALID_SAVED_OWNER_OPERATION')
          await reconcile(v, op, saved.transactionHash)
        }
      }
    }),
    run: (resume = false) => runAction(async () => { available(); const v = job(); requirePublic(ownerCreationState(v).canRun, 'OWNER_CREATION_NOT_CONFIRMED'); const data = await ownedView(await request(`/api/public/jobs/${v.job.jobId}/${resume ? 'resume' : 'run'}`, {}), v.job.jobId); update({ view: data }) }),
    approve, retryPreparation,
    canRetryPreparation: (action: OwnerAction) => { try { return Boolean(reviewOwnerOperation) && retryGeneration(action) !== null } catch { return false } },
    ownerOperationRetained: (action: OwnerAction) => { try { const v = job(); return v.ownerOperations.some(op => op.action === action) || storage.getItem(attemptKey(v, action)) !== null } catch { return true } },
  }
}
