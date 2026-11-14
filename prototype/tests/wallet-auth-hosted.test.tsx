import { afterEach, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../src/App'
import { createWalletAuth } from '../src/integration/wallet-auth'
const sdk = vi.hoisted(() => ({ initialize: vi.fn(), getAccount: vi.fn(async () => undefined), createAction: vi.fn() }))
vi.mock('@meteorwallet/sdk', () => ({ MeteorConnect: class { initialize = sdk.initialize; getAccount = sdk.getAccount; createAction = sdk.createAction }, webpage_local_storage: {} }))
const dom = (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom
const originalUrl = window.location.href

// Synthetic fixture ONLY; not a provider-returned deployment URL.
const origin = 'https://approved-login.invalid'
const recipient = 'approved-login.invalid'
afterEach(() => { dom.reconfigure({ url: originalUrl }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks() })

test('App consumes only trusted build approval; hosted login loads SDK on click, never resume', async () => {
  vi.stubEnv('VITE_HALDIR_APPROVED_ORIGIN', origin)
  dom.reconfigure({ url: `${origin}/?mode=wallet-auth-qualification` })
  vi.stubGlobal('isSecureContext', true)
  const transport = vi.fn(async () => Response.json({}, { status: 401 }))
  vi.stubGlobal('fetch', transport)
  render(<App />)
  expect(await screen.findByText('Not logged in. No mandate is active.')).toBeVisible()
  expect(transport).toHaveBeenCalledTimes(1)
  expect(sdk.initialize).not.toHaveBeenCalled()
  expect(screen.getByText(/Hosted testnet login preview/)).toBeVisible()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Log in with connected testnet wallet' }))
  expect(await screen.findByText(/Click Connect testnet account to associate an account with this site/)).toBeVisible()
  expect(sdk.initialize).toHaveBeenCalledTimes(1)
  expect(sdk.createAction).not.toHaveBeenCalled()
  expect(transport).toHaveBeenCalledTimes(1)
})

test('browser query/window configuration cannot grant hosted approval', async () => {
  vi.stubEnv('VITE_HALDIR_APPROVED_ORIGIN', undefined)
  dom.reconfigure({ url: `${origin}/?mode=wallet-auth-qualification&approvedOrigin=${encodeURIComponent(origin)}` })
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('HALDIR_APPROVED_ORIGIN', origin)
  const transport = vi.fn()
  vi.stubGlobal('fetch', transport)
  render(<App />)
  expect(await screen.findByText(/approved exact HTTPS origin/)).toBeVisible()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Log in with connected testnet wallet' }))
  expect(transport).not.toHaveBeenCalled()
  expect(sdk.initialize).not.toHaveBeenCalled()
})

test('configured build still starts the unchanged separate simulation by default', () => {
  vi.stubEnv('VITE_HALDIR_APPROVED_ORIGIN', origin)
  dom.reconfigure({ url: origin })
  const transport = vi.fn()
  vi.stubGlobal('fetch', transport)
  render(<App />)
  expect(screen.queryByRole('button', { name: 'Log in with connected testnet wallet' })).toBeNull()
  expect(transport).not.toHaveBeenCalled()
  expect(sdk.initialize).not.toHaveBeenCalled()
})

test('mock hosted transport retains only an exact validated principal across explicit login/reload/logout (not browser-cookie proof)', async () => {
  const accountId = 'alice.testnet', publicKey = 'ed25519:11111111111111111111111111111111', now = 1_800_000_000_000
  const c = { challengeId: 'a'.repeat(43), origin, networkId: 'testnet', accountId, issuedAt: now, expiresAt: now + 120_000 }
  const message = JSON.stringify({ type: 'haldir.wallet-login.v1', origin, recipient, networkId: 'testnet', accountId, challengeId: c.challengeId, issuedAt: c.issuedAt, expiresAt: c.expiresAt, notice: 'Session authentication only; does not authorize create/pay/stop/withdraw.' })
  const nonceBytes = Uint8Array.from({ length: 32 }, (_, i) => i)
  const nonce = btoa(String.fromCharCode(...nonceBytes))
  const principal = { sessionId: 'a'.repeat(64), accountId, publicKey, networkId: 'testnet', origin, recipient, expiresAt: now + 900_000, authenticationOnly: true }
  // Explicit response-state mock; it neither implements nor claims a cookie jar.
  let authenticated = false
  const requests: { route: string; body: unknown }[] = []
  const transport = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const route = new URL(String(url)).pathname.split('/').at(-1)!
    requests.push({ route, body: JSON.parse(init!.body as string) })
    if (route === 'challenge') return Response.json({ ...c, payload: { message, recipient, nonce } })
    if (route === 'verify') authenticated = true
    if (route === 'logout') { authenticated = false; return Response.json({ loggedOut: true }) }
    return authenticated ? Response.json({ principal }) : Response.json({}, { status: 401 })
  })
  const promptForExecution = vi.fn(async () => ({ accountId, publicKey: { toString: () => publicKey }, signature: new Uint8Array(64).fill(1) }))
  const createAction = vi.fn(async (_request: unknown) => ({ promptForExecution }))
  const loadMeteor = vi.fn(async () => ({ getAccount: async () => ({ identifier: { blockchain: 'near', network: 'testnet', accountId } }), createAction }))
  const makeClient = () => createWalletAuth({ origin, recipient, approvedOrigin: origin, secureContext: true, loadMeteor, transport, now: () => now })
  const client = makeClient()
  await client.login()
  expect(client.getSnapshot().principal).toEqual(principal)
  expect(createAction).toHaveBeenCalledExactlyOnceWith({ id: 'near::sign_message', input: { target: { blockchain: 'near', network: 'testnet', accountId }, messageParams: { message, recipient, nonce: nonceBytes } } })
  const reload = makeClient()
  await reload.resume()
  expect(reload.getSnapshot().principal).toEqual(principal)
  expect(loadMeteor).toHaveBeenCalledTimes(1)
  await reload.logout(); await client.resume()
  expect(client.getSnapshot().principal).toBeNull()
  expect(promptForExecution).toHaveBeenCalledTimes(1)
  expect(requests.map(r => r.route)).toEqual(['challenge', 'verify', 'session', 'session', 'logout', 'session'])
  expect(requests[0].body).toEqual({ accountId, networkId: 'testnet' })
  expect(requests[1].body).toEqual({ accountId, networkId: 'testnet', challengeId: c.challengeId, publicKey, signature: btoa(String.fromCharCode(...new Uint8Array(64).fill(1))) })
})

test('an explicitly approved exact hosted HTTPS origin can read a session without loading Meteor', async () => {
  const transport = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({}, { status: 401 }))
  const loadMeteor = vi.fn()
  const client = createWalletAuth({ origin, recipient, approvedOrigin: origin, secureContext: true, transport, loadMeteor })
  await client.resume()
  expect(transport).toHaveBeenCalledTimes(1)
  expect(transport.mock.calls[0][0]).toBe(`${origin}/api/wallet-auth/session`)
  expect(client.getSnapshot()).toEqual({ principal: null, busy: false, error: null })
  expect(loadMeteor).not.toHaveBeenCalled()
})

test('missing, malformed or mismatched approval never loads a wallet or sends any hosted request', async () => {
  for (const approvedOrigin of [undefined, '', 'https://foreign.invalid', origin + '/', origin + '/path', origin + '?mode=hosted', origin + '#login', 'https://user:pass@approved-login.invalid', 'https://*.invalid', 'http://approved-login.invalid', 'HTTPS://approved-login.invalid', origin + ':443']) {
    const transport = vi.fn()
    const loadMeteor = vi.fn()
    const client = createWalletAuth({ origin, recipient, approvedOrigin, secureContext: true, transport, loadMeteor })
    await client.resume(); await client.login(); await client.logout()
    expect(client.getSnapshot().principal).toBeNull()
    expect(client.getSnapshot().error).toBe('APPROVED_HTTPS_ORIGIN_REQUIRED')
    expect(loadMeteor).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
  }
})

test('hosted approval also pins recipient and secure context; invalid config never falls back to loopback', async () => {
  for (const options of [
    { origin: 'https://*.invalid', recipient: '*.invalid', approvedOrigin: 'https://*.invalid', secureContext: true },
    { origin, recipient: 'foreign.invalid', approvedOrigin: origin, secureContext: true },
    { origin, recipient, approvedOrigin: origin, secureContext: false },
    { origin: 'https://localhost:5443', recipient: 'localhost', approvedOrigin: '', secureContext: true },
    { origin: 'https://localhost:5443', recipient: 'localhost', approvedOrigin: origin, secureContext: true },
  ]) {
    const transport = vi.fn(), loadMeteor = vi.fn()
    const client = createWalletAuth({ ...options, transport, loadMeteor })
    await client.login()
    expect(client.getSnapshot().error).toBe('APPROVED_HTTPS_ORIGIN_REQUIRED')
    expect(transport).not.toHaveBeenCalled()
    expect(loadMeteor).not.toHaveBeenCalled()
  }
})
