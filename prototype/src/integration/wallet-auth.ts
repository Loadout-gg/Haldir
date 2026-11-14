// Authentication only. No mandate, transaction, private-key or financial API.
// Hosted authority is trusted build configuration, never a URL parameter or a
// reflected Host. Unconfigured loopback qualification keeps its injected port.
// Installed Meteor stays a dynamic Vite import (existing globalThis define).
// No copied SDK, dependency changes or window-global patch.
export type WalletTarget = Readonly<{ blockchain: 'near'; network: 'testnet'; accountId: string }>
export type MessageRequest = { id: 'near::sign_message'; input: { target: WalletTarget; messageParams: { message: string; recipient: string; nonce: Uint8Array } } }
export type MeteorLoginPort = {
  getAccount: (target: { blockchain: 'near'; network: 'testnet'; accountId?: string }) => Promise<{ identifier: { blockchain: string; network: string; accountId: string } } | undefined>
  associateTestnet?: () => Promise<{ identifier: { blockchain: string; network: string; accountId: string } }>
  createAction: (request: MessageRequest) => Promise<{ promptForExecution: () => Promise<{ accountId: string; publicKey: { toString(): string }; signature: Uint8Array }> }>
}
export type LoginPrincipal = { sessionId: string; accountId: string; publicKey: string; networkId: 'testnet'; origin: string; recipient: string; expiresAt: number; authenticationOnly: true }
export type LoginSnapshot = { principal: LoginPrincipal | null; busy: boolean; error: string | null; connectedAccount?: WalletTarget }
async function unavailableMeteor(): Promise<MeteorLoginPort> {
  throw new LoginError('METEOR_BROWSER_BUNDLE_REQUIRED')
}
async function installedMeteor(): Promise<MeteorLoginPort> {
  const { MeteorConnect, webpage_local_storage } = await import('@meteorwallet/sdk')
  const sdk = new MeteorConnect()
  await sdk.initialize({ storage: webpage_local_storage, mobileBridge: {
    enabled: false, autoOpenPairedWallet: false,
    transferAccounts: { enabled: false, persistStagedAccounts: false },
    newKeyTransfer: { enabled: false },
  } })
  // Account association is separate from login signing; no contract/key grant.
  return {
    getAccount: target => sdk.getAccount(target),
    associateTestnet: async () => {
      const action = await sdk.createAction({ id: 'near::sign_in', input: { target: { blockchain: 'near', network: 'testnet' } } })
      return action.promptForExecution()
    },
    createAction: async request => {
      const action = await sdk.createAction(request)
      return { promptForExecution: () => action.promptForExecution() }
    },
  }
}

const notice = 'Session authentication only; does not authorize create/pay/stop/withdraw.'
class LoginError extends Error {}
function demand(ok: unknown, code = 'INVALID_LOGIN_RESPONSE'): asserts ok { if (!ok) throw new LoginError(code) }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).sort().join('|') === [...keys].sort().join('|')
const account = (v: unknown): v is string => typeof v === 'string' && v.length >= 2 && v.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v)
const key = (v: unknown): v is string => typeof v === 'string' && /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)
const time = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
function decodeNonce(value: unknown) {
  demand(typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value))
  const raw = atob(value)
  demand(raw.length === 32 && btoa(raw) === value)
  return Uint8Array.from(raw, char => char.charCodeAt(0))
}

export function createWalletAuth({ origin, recipient, secureContext, approvedOrigin, loadMeteor = approvedOrigin === undefined ? unavailableMeteor : installedMeteor, transport = fetch, now = Date.now }: {
  origin: string; recipient: string; secureContext: boolean; approvedOrigin?: string; loadMeteor?: () => Promise<MeteorLoginPort>; transport?: typeof fetch; now?: () => number
}) {
  let allowed = false
  let originError = 'APPROVED_HTTPS_ORIGIN_REQUIRED'
  try {
    const url = new URL(origin)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    // Only trusted composition/build configuration grants hosted authority. The
    // observed browser origin is compared, never echoed back as its own approval.
    // An explicitly invalid approval must not fall back to local qualification.
    const approved = approvedOrigin === undefined ? loopback : approvedOrigin === origin
    if (approvedOrigin === undefined && loopback) originError = 'LOCAL_HTTPS_REQUIRED'
    allowed = secureContext && url.origin === origin && url.protocol === 'https:' && !url.hostname.includes('*') && !url.username && !url.password && approved && recipient === url.hostname && /^[\x21-\x7e]{1,253}$/.test(recipient)
  } catch { /* fail closed */ }
  let snapshot: LoginSnapshot = { principal: null, busy: false, error: allowed ? null : originError }
  let meteorPromise: Promise<MeteorLoginPort> | undefined
  const listeners = new Set<() => void>()
  const update = (patch: Partial<LoginSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()) }
  async function request(route: 'challenge' | 'verify' | 'session' | 'logout', body: object): Promise<unknown> {
    demand(allowed, originError)
    const response = await transport(`${origin}/api/wallet-auth/${route}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-haldir-csrf': '1' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new LoginError(response.status === 401 ? 'UNAUTHENTICATED' : 'LOGIN_HTTP_FAILED')
    return response.json()
  }
  function principalResponse(data: unknown, expectedAccount?: string): LoginPrincipal {
    demand(exact(data, ['principal']) && exact(data.principal, ['sessionId', 'accountId', 'publicKey', 'networkId', 'origin', 'recipient', 'expiresAt', 'authenticationOnly']))
    const p = data.principal
    demand(p.networkId === 'testnet' && p.origin === origin && p.recipient === recipient && p.authenticationOnly === true && account(p.accountId) && (!expectedAccount || p.accountId === expectedAccount) && key(p.publicKey) && typeof p.sessionId === 'string' && /^[a-f0-9]{64}$/.test(p.sessionId) && time(p.expiresAt) && p.expiresAt > now())
    return p as LoginPrincipal
  }
  async function currentTarget(meteor: MeteorLoginPort, expected?: WalletTarget): Promise<WalletTarget> {
    const c = await meteor.getAccount(expected ?? { blockchain: 'near', network: 'testnet' })
    demand(c?.identifier?.blockchain === 'near' && c.identifier.network === 'testnet' && account(c.identifier.accountId), 'CONNECT_TESTNET_ACCOUNT_FIRST')
    demand(!expected || c.identifier.accountId === expected.accountId, 'WALLET_ACCOUNT_CHANGED')
    return Object.freeze({ blockchain: 'near', network: 'testnet', accountId: c.identifier.accountId })
  }
  function challengeResponse(data: unknown, target: WalletTarget) {
    demand(exact(data, ['challengeId', 'origin', 'networkId', 'accountId', 'issuedAt', 'expiresAt', 'payload']))
    demand(data.origin === origin && data.networkId === 'testnet' && data.accountId === target.accountId && typeof data.challengeId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(data.challengeId) && time(data.issuedAt) && time(data.expiresAt) && data.issuedAt <= now() && data.expiresAt > now() && data.expiresAt - data.issuedAt <= 300_000)
    demand(exact(data.payload, ['message', 'recipient', 'nonce']) && data.payload.recipient === recipient && typeof data.payload.message === 'string')
    const message = JSON.parse(data.payload.message)
    demand(exact(message, ['type', 'origin', 'recipient', 'networkId', 'accountId', 'challengeId', 'issuedAt', 'expiresAt', 'notice']) && message.type === 'haldir.wallet-login.v1' && message.origin === origin && message.recipient === recipient && message.networkId === 'testnet' && message.accountId === target.accountId && message.challengeId === data.challengeId && message.issuedAt === data.issuedAt && message.expiresAt === data.expiresAt && message.notice === notice)
    return { challengeId: data.challengeId, expiresAt: data.expiresAt, messageParams: { message: data.payload.message, recipient, nonce: decodeNonce(data.payload.nonce) } }
  }
  async function run(action: () => Promise<void>) {
    if (snapshot.busy) return
    update({ busy: true, error: null, principal: null })
    try { demand(allowed, originError); await action() }
    catch (error) { update({ error: error instanceof LoginError ? error.message : error instanceof Error && error.message === 'Action was cancelled' ? 'LOGIN_CANCELLED' : 'LOGIN_FAILED' }) }
    finally { update({ busy: false }) }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    // Only the explicit Connect control may acquire an origin-scoped account.
    // SDK registration must be read back before exposing the selected identity.
    connect: () => run(async () => {
      update({ connectedAccount: undefined })
      meteorPromise ??= loadMeteor().catch(error => { meteorPromise = undefined; throw error })
      const meteor = await meteorPromise
      demand(meteor.associateTestnet, 'CONNECT_TESTNET_ACCOUNT_FIRST')
      const result = await meteor.associateTestnet()
      const id = result?.identifier
      demand(id?.blockchain === 'near' && id.network === 'testnet' && account(id.accountId), 'INVALID_ASSOCIATED_ACCOUNT')
      const target: WalletTarget = { blockchain: 'near', network: 'testnet', accountId: id.accountId }
      update({ connectedAccount: await currentTarget(meteor, target) })
    }),
    // Session reads never load the SDK or prompt. A missing/expired cookie is a
    // logged-out state, not permission to start another challenge automatically.
    resume: () => run(async () => {
      try { update({ principal: principalResponse(await request('session', {})) }) }
      catch (error) { if (!(error instanceof LoginError && error.message === 'UNAUTHENTICATED')) throw error }
    }),
    // Server-session logout only, not wallet disconnection or mandate revocation.
    logout: () => run(async () => {
      const result = await request('logout', {})
      demand(exact(result, ['loggedOut']) && result.loggedOut === true)
    }),
    // Only the separate explicit Login control signs. Connect never chains here.
    login: () => run(async () => {
      meteorPromise ??= loadMeteor().catch(error => { meteorPromise = undefined; throw error })
      const meteor = await meteorPromise
      const target = await currentTarget(meteor, snapshot.connectedAccount)
      const c = challengeResponse(await request('challenge', { accountId: target.accountId, networkId: 'testnet' }), target)
      await currentTarget(meteor, target)
      demand(now() < c.expiresAt, 'LOGIN_EXPIRED')
      const action = await meteor.createAction({ id: 'near::sign_message', input: { target, messageParams: c.messageParams } })
      const signed = await action.promptForExecution()
      await currentTarget(meteor, target)
      demand(now() < c.expiresAt, 'LOGIN_EXPIRED')
      demand(signed?.accountId === target.accountId && key(signed.publicKey?.toString()) && signed.signature instanceof Uint8Array && signed.signature.length === 64, 'INVALID_WALLET_PROOF')
      const verified = principalResponse(await request('verify', { accountId: target.accountId, networkId: 'testnet', challengeId: c.challengeId, publicKey: signed.publicKey.toString(), signature: btoa(String.fromCharCode(...signed.signature)) }), target.accountId)
      const retained = principalResponse(await request('session', {}), target.accountId)
      demand(retained.sessionId === verified.sessionId && retained.publicKey === verified.publicKey)
      update({ principal: retained })
    }),
  }
}
