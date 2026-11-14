import { afterEach, expect, test, vi } from 'vitest'
afterEach(() => vi.clearAllMocks())
// Closed module fixture: no real SDK initialization, external transport or prompt.
const sdk = vi.hoisted(() => ({ initialize: vi.fn(), getAccount: vi.fn(async (): Promise<{ identifier: { blockchain: string; network: string; accountId: string } } | undefined> => undefined), createAction: vi.fn() }))
vi.mock('@meteorwallet/sdk', () => ({ MeteorConnect: class { initialize = sdk.initialize; getAccount = sdk.getAccount; createAction = sdk.createAction }, webpage_local_storage: {} }))
import { createWalletAuth } from '../src/integration/wallet-auth'

test('approved hosted composition initializes the installed SDK only on explicit login and exposes no connection/financial flow', async () => {
  const origin = 'https://approved-login.invalid' // test fixture only
  const transport = vi.fn(async () => Response.json({}, { status: 401 }))
  const client = createWalletAuth({ origin, recipient: 'approved-login.invalid', approvedOrigin: origin, secureContext: true, transport })
  expect(sdk.initialize).not.toHaveBeenCalled()
  await client.resume()
  await client.logout()
  expect(sdk.initialize).not.toHaveBeenCalled()
  await client.login()
  expect(sdk.initialize).toHaveBeenCalledExactlyOnceWith({ storage: {}, mobileBridge: { enabled: false, autoOpenPairedWallet: false, transferAccounts: { enabled: false, persistStagedAccounts: false }, newKeyTransfer: { enabled: false } } })
  expect(sdk.getAccount).toHaveBeenCalledExactlyOnceWith({ blockchain: 'near', network: 'testnet' })
  expect(sdk.createAction).not.toHaveBeenCalled()
  expect(client.getSnapshot()).toMatchObject({ principal: null, busy: false, error: 'CONNECT_TESTNET_ACCOUNT_FIRST' })
  expect(transport).toHaveBeenCalledTimes(2)
})

test('default real SDK path stays disabled for unchanged loopback qualification', async () => {
  const transport = vi.fn()
  const client = createWalletAuth({ origin: 'https://localhost:5443', recipient: 'localhost', secureContext: true, transport })
  await client.login()
  expect(client.getSnapshot().error).toBe('METEOR_BROWSER_BUNDLE_REQUIRED')
  expect(sdk.initialize).not.toHaveBeenCalled()
  expect(sdk.createAction).not.toHaveBeenCalled()
  expect(transport).not.toHaveBeenCalled()
})

test('explicit association adapter requests only testnet sign_in without key permissions or chained signing', async () => {
  const identifier = { blockchain: 'near', network: 'testnet', accountId: 'chosen.testnet' }
  const promptForExecution = vi.fn(async () => ({ identifier }))
  sdk.createAction.mockResolvedValueOnce({ promptForExecution })
  sdk.getAccount.mockResolvedValueOnce({ identifier })
  const origin = 'https://approved-login.invalid'
  const transport = vi.fn()
  const client = createWalletAuth({ origin, recipient: 'approved-login.invalid', approvedOrigin: origin, secureContext: true, transport })
  await client.connect()
  expect(sdk.createAction).toHaveBeenCalledExactlyOnceWith({ id: 'near::sign_in', input: { target: { blockchain: 'near', network: 'testnet' } } })
  expect(promptForExecution).toHaveBeenCalledTimes(1)
  expect(sdk.getAccount).toHaveBeenCalledExactlyOnceWith(identifier)
  expect(client.getSnapshot()).toMatchObject({ connectedAccount: identifier, principal: null, error: null, busy: false })
  expect(transport).not.toHaveBeenCalled()
})

