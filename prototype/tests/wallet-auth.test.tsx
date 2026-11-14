import { expect, test, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../src/App'
import { WalletLoginQualification } from '../src/components/wallet-login-qualification'
afterEach(() => { window.history.replaceState({}, '', '/'); vi.unstubAllGlobals() })
import { createWalletAuth } from '../src/integration/wallet-auth'

const origin = 'https://localhost:5443'
const recipient = 'localhost'
const accountId = 'alice.testnet'
const identifier = { blockchain: 'near', network: 'testnet', accountId }
const publicKey = 'ed25519:11111111111111111111111111111111'
const now = 1_800_000_000_000
const nonce = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)))
const challenge = () => {
  const c = { challengeId: 'a'.repeat(43), origin, networkId: 'testnet', accountId, issuedAt: now, expiresAt: now + 120_000 }
  return { ...c, payload: { recipient, nonce, message: JSON.stringify({ type: 'haldir.wallet-login.v1', origin, recipient, networkId: 'testnet', accountId, challengeId: c.challengeId, issuedAt: c.issuedAt, expiresAt: c.expiresAt, notice: 'Session authentication only; does not authorize create/pay/stop/withdraw.' }) } }
}
const principal = { sessionId: 'a'.repeat(64), accountId, publicKey, networkId: 'testnet', origin, recipient, expiresAt: now + 900_000, authenticationOnly: true }
function fixture() {
  const requests: { url: string; init: RequestInit }[] = []
  let authenticated = false
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init! })
    if (String(url).endsWith('/challenge')) return Response.json(challenge())
    if (String(url).endsWith('/logout')) { authenticated = false; return Response.json({ loggedOut: true }) }
    if (String(url).endsWith('/verify')) authenticated = true
    return authenticated ? Response.json({ principal }) : Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  })
  const promptForExecution = vi.fn(async () => ({ accountId, publicKey: { toString: () => publicKey }, signature: new Uint8Array(64).fill(1) }))
  const createAction = vi.fn(async (_request: unknown) => ({ promptForExecution }))
  const getAccount = vi.fn(async (_target: unknown) => ({ identifier }))
  const loadMeteor = vi.fn(async () => ({ getAccount, createAction }))
  const client = createWalletAuth({ origin, recipient, secureContext: true, transport, loadMeteor, now: () => now })
  return { client, requests, transport, loadMeteor, createAction, getAccount, promptForExecution }
}

test('explicit login hands exact decoded nonce32 to Meteor then verifies and reads cookie-only session', async () => {
  const f = fixture()
  expect(f.loadMeteor).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(0)
  await f.client.login()
  expect(f.client.getSnapshot().principal).toEqual(principal)
  expect(f.createAction).toHaveBeenCalledExactlyOnceWith({ id: 'near::sign_message', input: { target: identifier, messageParams: { message: challenge().payload.message, recipient, nonce: new Uint8Array(Array.from({ length: 32 }, (_, i) => i)) } } })
  expect(f.promptForExecution).toHaveBeenCalledTimes(1)
  expect(f.requests.map(r => r.url)).toEqual(['challenge', 'verify', 'session'].map(route => `${origin}/api/wallet-auth/${route}`))
  for (const { init } of f.requests) {
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-haldir-csrf': '1' } })
    expect(init.headers).not.toHaveProperty('cookie')
    expect(init.headers).not.toHaveProperty('authorization')
  }
  expect(JSON.parse(f.requests[1].init.body as string)).toEqual({ accountId, networkId: 'testnet', challengeId: challenge().challengeId, publicKey, signature: btoa(String.fromCharCode(...new Uint8Array(64).fill(1))) })
  expect(f.requests[2].init.body).toBe('{}')
})

test('wrong connected network or blockchain is rejected before challenge or prompt', async () => {
  for (const changed of [{ network: 'mainnet' }, { blockchain: 'ethereum' }]) {
    const f = fixture()
    f.getAccount.mockResolvedValue({ identifier: { ...identifier, ...changed } })
    await f.client.login()
    expect(f.requests).toHaveLength(0)
    expect(f.promptForExecution).not.toHaveBeenCalled()
    expect(f.client.getSnapshot().principal).toBeNull()
  }
})

test('account changes during challenge or signing do not verify another account', async () => {
  for (const changedAt of [2, 3]) {
    const f = fixture()
    f.getAccount.mockImplementation(async () => ({ identifier: { ...identifier, accountId: f.getAccount.mock.calls.length >= changedAt ? 'bob.testnet' : accountId } }))
    await f.client.login()
    expect(f.requests.some(r => r.url.endsWith('/verify'))).toBe(false)
    expect(f.client.getSnapshot().principal).toBeNull()
    if (changedAt === 2) expect(f.promptForExecution).not.toHaveBeenCalled()
  }
})

test('wrong signed account never reaches verify', async () => {
  const f = fixture()
  f.promptForExecution.mockResolvedValue({ accountId: 'bob.testnet', publicKey: { toString: () => publicKey }, signature: new Uint8Array(64) })
  await f.client.login()
  expect(f.requests.some(r => r.url.endsWith('/verify'))).toBe(false)
})

test('malformed or mismatched challenge fails before wallet prompt', async () => {
  for (const alter of [
    (c: ReturnType<typeof challenge>) => ({ ...c, accountId: 'bob.testnet' }),
    (c: ReturnType<typeof challenge>) => ({ ...c, networkId: 'mainnet' }),
    (c: ReturnType<typeof challenge>) => ({ ...c, origin: 'https://foreign.invalid' }),
    (c: ReturnType<typeof challenge>) => ({ ...c, expiresAt: now }),
    (c: ReturnType<typeof challenge>) => ({ ...c, payload: { ...c.payload, recipient: 'foreign.invalid' } }),
    (c: ReturnType<typeof challenge>) => ({ ...c, payload: { ...c.payload, nonce: btoa('not32') } }),
    (c: ReturnType<typeof challenge>) => ({ ...c, payload: { ...c.payload, message: 'Authorize a mandate' } }),
    (c: ReturnType<typeof challenge>) => ({ ...c, payload: { ...c.payload, callbackUrl: 'https://foreign.invalid' } }),
  ]) {
    const f = fixture()
    f.transport.mockResolvedValueOnce(Response.json(alter(challenge())))
    await f.client.login()
    expect(f.promptForExecution).not.toHaveBeenCalled()
    expect(f.client.getSnapshot().principal).toBeNull()
  }
})

test('wallet cancellation is a redacted normal outcome; no verify or automatic retry', async () => {
  const f = fixture()
  f.promptForExecution.mockRejectedValue(new Error('Action was cancelled'))
  await f.client.login()
  expect(f.client.getSnapshot()).toMatchObject({ principal: null, busy: false, error: 'LOGIN_CANCELLED' })
  expect(f.requests).toHaveLength(1)
  expect(f.promptForExecution).toHaveBeenCalledTimes(1)
})

test('double click holds one wallet prompt until it settles', async () => {
  const f = fixture()
  let reject!: (reason: Error) => void
  f.promptForExecution.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
  const first = f.client.login()
  await vi.waitFor(() => expect(f.promptForExecution).toHaveBeenCalledTimes(1))
  await f.client.login()
  expect(f.promptForExecution).toHaveBeenCalledTimes(1)
  reject(new Error('Action was cancelled'))
  await first
})

test('foreign/nonsecure origin fails closed before any wallet or HTTP', async () => {
  for (const [url, secureContext] of [['https://example.com', true], ['http://127.0.0.1:8080', true], ['https://localhost:5443', false]] as const) {
    const f = fixture()
    const c = createWalletAuth({ origin: url, recipient, secureContext, loadMeteor: f.loadMeteor, transport: f.transport })
    await c.login()
    expect(f.requests).toHaveLength(0)
    expect(f.loadMeteor).not.toHaveBeenCalled()
  }
})

test('reload resumes the cookie session without loading or prompting any wallet; logout is server only', async () => {
  const f = fixture()
  await f.client.resume()
  expect(f.requests.map(r => r.url)).toEqual([origin + '/api/wallet-auth/session'])
  expect(f.client.getSnapshot().principal).toBeNull()
  expect(f.client.getSnapshot().error).toBeNull()
  expect(f.loadMeteor).not.toHaveBeenCalled()
  await f.client.login()
  const reload = createWalletAuth({ origin, recipient, secureContext: true, transport: f.transport, loadMeteor: f.loadMeteor, now: () => now })
  await reload.resume()
  expect(reload.getSnapshot().principal).toEqual(principal)
  expect(f.promptForExecution).toHaveBeenCalledTimes(1)
  await reload.logout()
  expect(reload.getSnapshot()).toEqual({ principal: null, busy: false, error: null })
  expect(f.requests.at(-1)).toMatchObject({ url: origin + '/api/wallet-auth/logout', init: { body: '{}' } })
  await f.client.resume()
  expect(f.client.getSnapshot().principal).toBeNull()
})

test('failed logout is not reported as success and retained session cannot bypass revalidation', async () => {
  const f = fixture()
  await f.client.login()
  f.transport.mockResolvedValueOnce(Response.json({ error: 'INTERNAL_ERROR' }, { status: 500 }))
  await f.client.logout()
  expect(f.client.getSnapshot()).toMatchObject({ principal: null, error: 'LOGIN_HTTP_FAILED' })
})

test('wallet login mode renders login-only controls, not active mandate or simulation authorization', async () => {
  window.history.replaceState({}, '', '/?mode=wallet-auth-qualification')
  const transport = vi.fn()
  vi.stubGlobal('fetch', transport)
  render(<App />)
  expect(screen.getByRole('button', { name: 'Log in with connected testnet wallet' })).toBeVisible()
  expect(screen.queryByRole('button', { name: /authorize|fund|pay|withdraw|stop spending/i })).toBeNull()
  expect(screen.getByText(/Login does not authorize a mandate/)).toBeVisible()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Log in with connected testnet wallet' }))
  expect(await screen.findByText(/Local HTTPS is required/)).toBeVisible()
  expect(transport).not.toHaveBeenCalled()
})

// Characterization of the completed component/client using an explicit closed
// synthetic wallet/HTTP fixture. NOT actual browser-managed cookies or live SDK.
test('mounted login-only control signs once on click, shows authenticated identity, and logs out without a wallet prompt', async () => {
  const f = fixture()
  render(<WalletLoginQualification client={f.client} />)
  expect(await screen.findByText('Not logged in. No mandate is active.')).toBeVisible()
  expect(f.loadMeteor).not.toHaveBeenCalled()
  expect(f.promptForExecution).not.toHaveBeenCalled()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Log in with connected testnet wallet' }))
  expect(await screen.findByText('Logged in as alice.testnet · testnet · Authentication only')).toBeVisible()
  expect(f.promptForExecution).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('button', { name: 'Log out of session' }))
  expect(await screen.findByText('Not logged in. No mandate is active.')).toBeVisible()
  expect(f.promptForExecution).toHaveBeenCalledTimes(1)
})

test('a verify response alone cannot authenticate if browser cookie session read fails', async () => {
  const f = fixture()
  f.transport.mockResolvedValueOnce(Response.json(challenge()))
    .mockResolvedValueOnce(Response.json({ principal }))
    .mockResolvedValueOnce(Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 }))
  await f.client.login()
  expect(f.client.getSnapshot()).toMatchObject({ principal: null, error: 'UNAUTHENTICATED' })
  expect(f.promptForExecution).toHaveBeenCalledTimes(1)
})

test('untrusted session shapes, extra credentials, wrong network or expired principal never show authenticated state', async () => {
  for (const response of [
    { principal: { ...principal, authenticationOnly: false } },
    { principal: { ...principal, networkId: 'mainnet' } },
    { principal: { ...principal, origin: 'https://foreign.invalid' } },
    { principal: { ...principal, expiresAt: now } },
    { principal, token: 'must-not-be-a-client-token' },
  ]) {
    const f = fixture()
    f.transport.mockResolvedValueOnce(Response.json(response))
    await f.client.resume()
    expect(f.client.getSnapshot().principal).toBeNull()
    expect(f.client.getSnapshot().error).toBe('INVALID_LOGIN_RESPONSE')
    expect(f.loadMeteor).not.toHaveBeenCalled()
  }
})
