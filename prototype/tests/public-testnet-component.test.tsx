import { expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
import App, { PublicTestnetWorkspace } from '../src/App'

test('shared public view renders observed report/receipt and returned atomic principal, not wallet success or fixture simulation', async () => {
  const principal = { accountId: 'owner.testnet', sessionId: 'a'.repeat(64) }
  const auth = { subscribe: () => () => {}, getSnapshot: () => authSnapshot, resume: async () => {}, connect: async () => {}, login: async () => {}, logout: async () => {} }
  const authSnapshot = { principal, busy: false, error: null }
  const snapshot = { busy: false, error: null, wallet: { status: 'submitted', transactionHash: '1'.repeat(32) }, config: { financialActions: true, missingConfiguration: [] }, view: {
    job: { jobId: 'job-1', ownerId: 'owner.testnet', state: 'STOPPED', scope: { purpose: 'Fictional supplier review', output: 'Source-linked report', budgetAtomic: '1000000000000000000000000', mandateId: 'mandate.testnet' } },
    order: { orderId: 'quote-1', lifecycle: 'DELIVERED', quote: { vendorId: 'vendor.testnet', amountAtomic: '123456789012345678901234' }, proof: { transactionHash: '1'.repeat(32), proofId: 'proof-1' }, artifact: { fictionalSample: true, artifactId: 'artifact-1', content: 'FICTIONAL SAMPLE: company records.', contentDigest: 'c'.repeat(64) } },
    run: { stage: 'COMPLETE', report: { status: 'EVIDENCE_REVIEW_REQUIRED', supplierVerified: false, findings: [{ excerpt: 'Fictional observation from delivered source', artifactId: 'artifact-1', proofId: 'proof-1' }], missing: [] } },
    payment: { status: 'SUBMITTED', transactionHash: '1'.repeat(32) },
    ownerOperations: [{ action: 'withdraw', operationId: 'b'.repeat(64), status: 'CONFIRMED', transactionHash: '1'.repeat(32), signerId: 'owner.testnet', receipt: { finality: 'final', networkId: 'testnet', ownerId: 'owner.testnet', signerId: 'owner.testnet', mandateId: 'mandate.testnet', action: 'withdraw', amountAtomic: '765432109876543210987654', receiptId: 'return-receipt' } }],
    disclosures: { vendorData: 'FICTIONAL_SAMPLE', supplierVerified: false, principalReturn: 'Free balance is not a refund.' },
  } }
  const controller = { ownerApprovalAvailable: false, subscribe: () => () => {}, getSnapshot: () => snapshot, resume: async () => {}, open: async () => {}, refresh: async () => {}, run: async () => {}, approve: async () => {} }
  const { rerender } = render(<PublicTestnetWorkspace auth={auth as any} controller={controller as any} />)
  expect(await screen.findByRole('heading', { name: 'Testnet job' })).toBeVisible()
  expect(screen.getByText('Fictional observation from delivered source')).toBeVisible()
  expect(screen.getByTestId('public-returned-amount')).toHaveTextContent('765432109876543210987654')
  expect(screen.getByTestId('public-purchase-amount')).toHaveTextContent('123456789012345678901234')
  expect(screen.getByText('Fictional sample data. Not a verified supplier finding. Report completion does not establish returned funds.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Approve owner withdrawal in wallet' })).toBeDisabled()
  snapshot.view.ownerOperations[0].receipt.mandateId = 'unrelated.testnet'
  rerender(<PublicTestnetWorkspace auth={auth as any} controller={controller as any} />)
  expect(screen.getByTestId('public-returned-amount')).toHaveTextContent('Not observed')
})

for (const action of ['stop', 'withdraw'] as const) test(`explicit Retry ${action} preparation uses the existing control, never mount/check/open auto-retry`, async () => {
  const authSnapshot = { principal: { accountId: 'owner.testnet', sessionId: 'session' }, busy: false, error: null }
  const auth = { subscribe: () => () => {}, getSnapshot: () => authSnapshot, resume: async () => {} }
  const snapshot = { busy: false, error: null, config: { financialActions: false, missingConfiguration: ['model'] }, view: {
    job: { jobId: 'job-1', ownerId: 'owner.testnet', scope: { purpose: 'Sample', output: 'Report', budgetAtomic: '30' } },
    order: { quote: { amountAtomic: '8', vendorId: 'vendor.testnet' } }, payment: { status: 'NOT_STARTED' }, run: null, ownerOperations: [], disclosures: { principalReturn: 'Only observed return.' },
  } }
  const retryPreparation = vi.fn(), approve = vi.fn(), refresh = vi.fn()
  const controller = { ownerApprovalAvailable: true, subscribe: () => () => {}, getSnapshot: () => snapshot, resume: vi.fn(), refresh, approve, retryPreparation,
    canRetryPreparation: (kind: string) => kind === action, ownerOperationRetained: (kind: string) => kind === action }
  render(<PublicTestnetWorkspace auth={auth as any} controller={controller as any} />)
  expect(retryPreparation).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: action === 'stop' ? 'Approve owner stop in wallet' : 'Approve owner withdrawal in wallet' })).toBeDisabled()
  const retry = screen.getByRole('button', { name: `Retry ${action === 'stop' ? 'stop' : 'withdrawal'} preparation` })
  expect(retry).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: 'Check same job and owner receipts' }))
  expect(refresh).toHaveBeenCalledOnce(); expect(retryPreparation).not.toHaveBeenCalled()
  await userEvent.click(retry)
  expect(retryPreparation).toHaveBeenCalledExactlyOnceWith(action); expect(approve).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Run or resume approved job' })).toBeDisabled()
})

for (const bound of [true, false]) test(`factory run control requires receipt bound to observed owner/mandate/hash (${bound})`, () => {
  const authSnapshot = { principal: { accountId: 'owner.testnet', sessionId: 'a'.repeat(64) }, busy: false, error: null }
  const auth = { subscribe: () => () => {}, getSnapshot: () => authSnapshot, resume: async () => {} }
  const snapshot = { busy: false, error: null, config: { financialActions: true }, view: {
    job: { jobId: 'job-1', ownerId: 'owner.testnet', ownerCreationRequired: true, scope: { purpose: 'Sample', output: 'Report', budgetAtomic: '30', mandateId: 'mandate.testnet' } },
    order: { quote: { amountAtomic: '8', vendorId: 'vendor.testnet' } }, payment: { status: 'NOT_STARTED' }, run: null,
    ownerOperations: [{ operationId: 'a'.repeat(64), action: 'create', status: 'CONFIRMED', signerId: 'owner.testnet', transactionHash: '1'.repeat(32), receipt: {
      status: 'CONFIRMED', finality: 'final', networkId: 'testnet', ownerId: 'owner.testnet', signerId: 'owner.testnet', action: 'create', mandateId: bound ? 'mandate.testnet' : 'foreign.testnet', transactionHash: '1'.repeat(32) } }],
    disclosures: { principalReturn: 'Only observed return.' },
  } }
  const controller = { ownerApprovalAvailable: true, subscribe: () => () => {}, getSnapshot: () => snapshot, resume: async () => {} }
  render(<PublicTestnetWorkspace auth={auth as any} controller={controller as any} />)
  const run = screen.getByRole('button', { name: 'Run or resume approved job' })
  if (bound) expect(run).toBeEnabled()
  else expect(run).toBeDisabled()
})

test('explicit public-testnet mount stays distinct from unchanged default simulation and auth-only route', async () => {
  window.history.replaceState({}, '', '/?mode=public-testnet')
  try {
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Testnet job' })).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Login not completed: LOCAL_HTTPS_REQUIRED')
    expect(screen.queryByRole('button', { name: 'Approve owner creation in wallet' })).toBeNull()
  } finally { window.history.replaceState({}, '', '/') }
})
