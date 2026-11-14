import { afterEach, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WalletLoginQualification } from '../src/components/wallet-login-qualification'
import { createWalletAuth } from '../src/integration/wallet-auth'

const target = { blockchain: 'near' as const, network: 'testnet' as const, accountId: 'chosen.testnet' }
afterEach(() => vi.unstubAllEnvs())

test('empty origin registry has a reachable explicit association; selection never chains login signing', async () => {
  let registered = false
  const associateTestnet = vi.fn(async () => { registered = true; return { identifier: target } })
  const getAccount = vi.fn(async () => registered ? { identifier: target } : undefined)
  const createAction = vi.fn()
  const loadMeteor = vi.fn(async () => ({ getAccount, associateTestnet, createAction }))
  const transport = vi.fn(async () => Response.json({}, { status: 401 }))
  const client = createWalletAuth({ origin: 'https://localhost:5443', recipient: 'localhost', secureContext: true, loadMeteor, transport })
  render(<WalletLoginQualification client={client} />)
  expect(await screen.findByText('Not logged in. No mandate is active.')).toBeVisible()
  expect(loadMeteor).not.toHaveBeenCalled()
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Log in with connected testnet wallet' }))
  expect(createAction).not.toHaveBeenCalled()
  expect(registered).toBe(false)
  await user.click(screen.getByRole('button', { name: 'Connect testnet account' }))
  expect(await screen.findByText(/Connected chosen.testnet · testnet/)).toBeVisible()
  expect(associateTestnet).toHaveBeenCalledTimes(1)
  expect(getAccount).toHaveBeenLastCalledWith(target)
  expect(createAction).not.toHaveBeenCalled()
  expect(transport).toHaveBeenCalledTimes(1) // mount-only session; no challenge
})

test('hosted auth never offers the simulation return that redirects back to auth', () => {
  vi.stubEnv('VITE_HALDIR_APPROVED_ORIGIN', 'https://approved-login.invalid')
  render(<WalletLoginQualification />)
  expect(screen.queryByRole('link', { name: 'Return to separate scripted simulation' })).toBeNull()
})

test('unhosted auth retains its separate simulation return', () => {
  vi.stubEnv('VITE_HALDIR_APPROVED_ORIGIN', undefined)
  render(<WalletLoginQualification />)
  expect(screen.getByRole('link', { name: 'Return to separate scripted simulation' })).toHaveAttribute('href', '/')
})

test('association cancellation, wrong network, blockchain, malformed and unregistered identities cannot challenge or sign', async () => {
  for (const mode of ['cancel', 'network', 'blockchain', 'malformed', 'unregistered', 'different'] as const) {
    const identifier = { ...target, ...(mode === 'network' ? { network: 'mainnet' } : mode === 'blockchain' ? { blockchain: 'ethereum' } : mode === 'malformed' ? { accountId: 'INVALID!' } : {}) }
    const associateTestnet = vi.fn(async () => { if (mode === 'cancel') throw new Error('Action was cancelled'); return { identifier } })
    const createAction = vi.fn(), transport = vi.fn()
    const client = createWalletAuth({ origin: 'https://localhost:5443', recipient: 'localhost', secureContext: true, transport, loadMeteor: async () => ({ associateTestnet, createAction, getAccount: async () => mode === 'unregistered' ? undefined : { identifier: mode === 'different' ? { ...target, accountId: 'other.testnet' } : identifier } }) })
    await client.connect()
    expect(client.getSnapshot().connectedAccount).toBeUndefined()
    expect(client.getSnapshot().principal).toBeNull()
    expect(client.getSnapshot().error).toBe(mode === 'cancel' ? 'LOGIN_CANCELLED' : mode === 'unregistered' ? 'CONNECT_TESTNET_ACCOUNT_FIRST' : mode === 'different' ? 'WALLET_ACCOUNT_CHANGED' : 'INVALID_ASSOCIATED_ACCOUNT')
    expect(associateTestnet).toHaveBeenCalledTimes(1)
    expect(createAction).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
  }
})

test('pending association disables all controls and excludes overlapping prompts or login', async () => {
  let release!: (value: { identifier: typeof target }) => void
  const associateTestnet = vi.fn(() => new Promise<{ identifier: typeof target }>(resolve => { release = resolve }))
  const createAction = vi.fn(), transport = vi.fn(async () => Response.json({}, { status: 401 }))
  const client = createWalletAuth({ origin: 'https://localhost:5443', recipient: 'localhost', secureContext: true, transport, loadMeteor: async () => ({ associateTestnet, createAction, getAccount: async () => ({ identifier: target }) }) })
  render(<WalletLoginQualification client={client} />)
  await screen.findByText('Not logged in. No mandate is active.')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Connect testnet account' }))
  await vi.waitFor(() => expect(associateTestnet).toHaveBeenCalledTimes(1))
  for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
  await client.connect(); await client.login(); await client.logout(); await client.resume()
  expect(associateTestnet).toHaveBeenCalledTimes(1)
  expect(createAction).not.toHaveBeenCalled()
  expect(transport).toHaveBeenCalledTimes(1)
  release({ identifier: target })
  await screen.findByText(/Connected chosen.testnet · testnet/)
  expect(createAction).not.toHaveBeenCalled()
})

test('association shares the exact approved HTTPS origin gate; URL-independent denial never loads SDK', async () => {
  for (const options of [
    { origin: 'https://foreign.invalid', recipient: 'foreign.invalid', approvedOrigin: undefined, secureContext: true },
    { origin: 'https://approved-login.invalid', recipient: 'approved-login.invalid', approvedOrigin: 'https://different.invalid', secureContext: true },
    { origin: 'https://approved-login.invalid', recipient: 'approved-login.invalid', approvedOrigin: 'https://approved-login.invalid', secureContext: false },
    { origin: 'http://localhost:5443', recipient: 'localhost', approvedOrigin: undefined, secureContext: true },
  ]) {
    const loadMeteor = vi.fn(), transport = vi.fn()
    const client = createWalletAuth({ ...options, loadMeteor, transport })
    await client.connect()
    expect(client.getSnapshot().error).toBeTruthy()
    expect(client.getSnapshot().connectedAccount).toBeUndefined()
    expect(loadMeteor).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
  }
})
