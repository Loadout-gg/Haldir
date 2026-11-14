// These are adapter ports, NOT an HTTP schema. The public API consumer must
// normalize its unsigned request and independently reviewed terms into them.
import { actionCreators } from '@near-js/transactions'
const { functionCall } = actionCreators
import type { WalletTarget, LoginPrincipal } from './wallet-auth'

export type OwnerManifest = {
  network: 'testnet'; owner: string; mandate: string; kind: 'stop' | 'withdraw'; gas: string
} | {
  network: 'testnet'; owner: string; mandate: string; kind: 'create'; gas: string
  factory: string; job_label: string; agent: string; allowlist: string[]
  cap: string; deadline_ns: string; operating_float: string
}
export type UnsignedOwnerCall = {
  network: 'testnet'; signerId: string; receiverId: string
  methodName: 'create_job' | 'stop' | 'withdraw'; args: Record<string, unknown>; gas: string; deposit: string
}
export type OwnerRequest = {
  id: 'near::sign_transactions'; input: { target: WalletTarget; useFunctionCallKey: false
    transactions: { receiverId: string; actions: ReturnType<typeof functionCall>[] }[] }
}

function demand(value: unknown, code = 'UNAPPROVED_OWNER_REQUEST'): asserts value { if (!value) throw new Error(code) }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: unknown, keys: string[]) => object(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|')
const named = (v: unknown): v is string => typeof v === 'string' && v.length >= 2 && v.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v) && v === v.trim()
const testnetAccount = (v: unknown): v is string => named(v) && (v.endsWith('.testnet') || /^[a-f0-9]{64}$/.test(v))
function decimal(v: unknown, width: number, positive = true): bigint {
  demand(typeof v === 'string' && v.length <= 39 && /^(0|[1-9][0-9]*)$/.test(v) && v === v.trim())
  const n = BigInt(v)
  demand(n < (1n << BigInt(width)) && (!positive || n > 0n))
  return n
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && [...a].every((v, i) => equal(v, b[i]))
  if (!object(a) || !object(b) || !exact(a, Object.keys(b))) return false
  return Object.keys(a).every(k => equal(a[k], b[k]))
}
export async function prepareOwnerRequest(approved: OwnerManifest, candidate: UnsignedOwnerCall): Promise<OwnerRequest> {
  demand(object(approved) && approved.network === 'testnet' && testnetAccount(approved.owner) && testnetAccount(approved.mandate))
  demand(['create', 'stop', 'withdraw'].includes(approved.kind))
  const gas = decimal(approved.gas, 64)
  demand(gas <= 300_000_000_000_000n)
  let expected: UnsignedOwnerCall = { network: 'testnet', signerId: approved.owner, receiverId: approved.mandate,
    methodName: approved.kind === 'withdraw' ? 'withdraw' : 'stop', args: {}, gas: approved.gas, deposit: '0' }
  if (approved.kind === 'create') {
    demand(exact(approved, ['network', 'owner', 'mandate', 'kind', 'gas', 'factory', 'job_label', 'agent', 'allowlist', 'cap', 'deadline_ns', 'operating_float']))
    demand(testnetAccount(approved.factory) && approved.factory.endsWith('.testnet') && approved.factory.length <= 30)
    demand(typeof approved.job_label === 'string' && /^[a-z0-9_-]{1,32}$/.test(approved.job_label) && approved.job_label === approved.job_label.trim())
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${approved.owner}:${approved.job_label}`))
    const child = 'j' + [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32) + '.' + approved.factory
    demand(child === approved.mandate && testnetAccount(approved.agent) && approved.owner !== approved.agent && approved.agent !== child)
    demand(Array.isArray(approved.allowlist) && approved.allowlist.length >= 1 && approved.allowlist.length <= 4 &&
      new Set(approved.allowlist).size === approved.allowlist.length && [...approved.allowlist].every(v => testnetAccount(v) && ![approved.owner, approved.agent, child].includes(v)))
    const cap = decimal(approved.cap, 128), float = decimal(approved.operating_float, 128)
    decimal(approved.deadline_ns, 64)
    demand(cap <= 100n * 10n ** 24n && cap + float < (1n << 128n) && gas >= 200_000_000_000_000n)
    expected = { network: 'testnet', signerId: approved.owner, receiverId: approved.factory, methodName: 'create_job', gas: approved.gas,
      deposit: (cap + float).toString(), args: { job_label: approved.job_label, agent: approved.agent, allowlist: [...approved.allowlist], cap: approved.cap, deadline_ns: approved.deadline_ns, operating_float: approved.operating_float } }
  } else demand(exact(approved, ['network', 'owner', 'mandate', 'kind', 'gas']))
  demand(equal(candidate, expected))
  return { id: 'near::sign_transactions', input: {
    target: { blockchain: 'near', network: 'testnet', accountId: approved.owner }, useFunctionCallKey: false,
    transactions: [{ receiverId: expected.receiverId, actions: [functionCall(expected.methodName, new TextEncoder().encode(JSON.stringify(expected.args)), gas, BigInt(expected.deposit))] }],
  } }
}

export type OwnerWalletResult = { status: 'submitted' | 'unknown' | 'cancelled' | 'blocked'; transactionHash: string | null; reason?: string }
export type OwnerMeteorPort = {
  getAccount(target: WalletTarget): Promise<{ identifier: { blockchain: string; network: string; accountId: string } } | undefined>
  createAction(request: OwnerRequest): Promise<{ promptForExecution(): Promise<unknown> }>
}
async function installedOwnerMeteor(): Promise<OwnerMeteorPort> {
  const { MeteorConnect, webpage_local_storage } = await import('@meteorwallet/sdk')
  const sdk = new MeteorConnect()
  await sdk.initialize({ storage: webpage_local_storage, mobileBridge: {
    enabled: false, autoOpenPairedWallet: false,
    transferAccounts: { enabled: false, persistStagedAccounts: false }, newKeyTransfer: { enabled: false },
  } })
  return { getAccount: target => sdk.getAccount(target), createAction: request => sdk.createAction(request) }
}
// An untrusted returned hash is a reconciliation hint only, NEVER settlement.
function hashFromResult(value: unknown, request: OwnerRequest): string | null {
  if (!Array.isArray(value) || value.length !== 1 || !object(value[0]) || !object(value[0].transaction)) return null
  const tx = value[0].transaction
  if (tx.signer_id !== request.input.target.accountId || tx.receiver_id !== request.input.transactions[0].receiverId || typeof tx.hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tx.hash)) return null
  return tx.hash
}
export function createNativeOwnerWallet({ principal, loadMeteor = installedOwnerMeteor, now = Date.now }: { principal: () => LoginPrincipal | null; loadMeteor?: () => Promise<OwnerMeteorPort>; now?: () => number }) {
  let busy = false
  let meteorPromise: Promise<OwnerMeteorPort> | undefined
  return { approve: async (manifest: OwnerManifest, candidate: UnsignedOwnerCall): Promise<OwnerWalletResult> => {
    if (busy) return { status: 'blocked', transactionHash: null, reason: 'OWNER_WALLET_BUSY' }
    busy = true
    let prompted = false, transactionHash: string | null = null
    try {
      const session = principal()
      const qualify = () => {
        const p = principal()
        demand(session && p && p.sessionId === session.sessionId && p.accountId === manifest.owner && p.networkId === 'testnet' && p.expiresAt > now(), 'OWNER_SESSION_REQUIRED')
      }
      qualify()
      const request = await prepareOwnerRequest(manifest, candidate)
      meteorPromise ??= loadMeteor().catch(error => { meteorPromise = undefined; throw error })
      const meteor = await meteorPromise
      const account = async () => {
        qualify()
        const selected = await meteor.getAccount(request.input.target)
        demand(selected?.identifier?.blockchain === 'near' && selected.identifier.network === 'testnet' && selected.identifier.accountId === manifest.owner, 'OWNER_WALLET_ACCOUNT_CHANGED')
        qualify()
      }
      await account()
      const action = await meteor.createAction(request)
      await account()
      prompted = true
      const output = await action.promptForExecution()
      transactionHash = hashFromResult(output, request)
      await account()
      return { status: transactionHash ? 'submitted' : 'unknown', transactionHash }
    } catch (error) {
      return { status: prompted ? error instanceof Error && error.message === 'Action was cancelled' && !transactionHash ? 'cancelled' : 'unknown' : 'blocked', transactionHash,
        reason: error instanceof Error ? error.message : 'OWNER_WALLET_FAILED' }
    } finally { busy = false }
  } }
}
