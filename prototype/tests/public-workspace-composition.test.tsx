import { vi, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PublicTestnetWorkspace } from '../src/App'
import { resolveOwnerManifest } from '../src/integration/owner-approval'

const { createController } = vi.hoisted(() => ({ createController: vi.fn() }))
vi.mock('../src/integration/testnet', async importOriginal => ({ ...await importOriginal<object>(), createPublicTestnetController: createController }))
const authSnapshot = { principal: { accountId: 'alice.testnet', sessionId: 'session' }, busy: false, error: null }
const auth = { subscribe: () => () => {}, getSnapshot: () => authSnapshot, resume: async () => {}, connect: async () => {}, login: async () => {}, logout: async () => {} }
function controller(view: unknown = null) {
  const snapshot = { busy: false, error: null, wallet: null, config: { financialActions: false, missingConfiguration: ['model'] }, view }
  return { ownerApprovalAvailable: true, subscribe: () => () => {}, getSnapshot: () => snapshot,
    resume: async () => {}, open: async () => {}, refresh: async () => {}, run: async () => {}, approve: async () => {} }
}

test('default workspace composes the independent persisted-terms resolver without automatic wallet approval', () => {
  const instance = controller(); const approve = vi.spyOn(instance, 'approve')
  createController.mockReturnValue(instance)
  render(<PublicTestnetWorkspace auth={auth as any} />)
  expect(createController.mock.lastCall?.[0].requiredOwnerManifest).toBe(resolveOwnerManifest)
  expect(approve).not.toHaveBeenCalled()
})

for (const ownerCreationRequired of [false, true, undefined]) test(`workspace shares creation fence for ${String(ownerCreationRequired)} and never offers deployed creation`, () => {
  const instance = controller({
    job: { jobId: 'job-1', ownerId: 'alice.testnet', state: 'ACTIVE', ownerCreationRequired, scope: { purpose: 'Sample', output: 'Report', budgetAtomic: '30' } },
    order: { quote: { amountAtomic: '8', vendorId: 'vendor.testnet' }, lifecycle: 'PAYMENT_PENDING', proof: null, artifact: null },
    payment: { status: 'NOT_STARTED' }, run: null, ownerOperations: [], disclosures: { principalReturn: 'Only observed principal is returned.' },
  })
  instance.getSnapshot().config.financialActions = true
  render(<PublicTestnetWorkspace auth={auth as any} controller={instance as any} />)
  const run = screen.getByRole('button', { name: 'Run or resume approved job' })
  if (ownerCreationRequired === false) {
    expect(run).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Approve owner creation in wallet' })).toBeNull()
  } else {
    expect(run).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Approve owner creation in wallet' })).toBeEnabled()
  }
})

test('existing job owner recovery buttons survive unavailable model while create and run remain disabled', () => {
  const instance = controller({
    job: { jobId: 'job-1', ownerId: 'alice.testnet', state: 'ACTIVE', scope: { purpose: 'Sample', output: 'Report', budgetAtomic: '30' } },
    order: { quote: { amountAtomic: '8', vendorId: 'vendor.testnet' }, lifecycle: 'PAYMENT_PENDING', proof: null, artifact: null },
    payment: { status: 'NOT_STARTED' }, run: null, ownerOperations: [], disclosures: { principalReturn: 'Only observed principal is returned.' },
  })
  render(<PublicTestnetWorkspace auth={auth as any} controller={instance as any} />)
  expect(screen.getByRole('button', { name: 'Approve owner stop in wallet' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Approve owner withdrawal in wallet' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Approve owner creation in wallet' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Run or resume approved job' })).toBeDisabled()
})
