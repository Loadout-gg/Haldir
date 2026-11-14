import { test, expect, vi } from 'vitest'
import { createHash, webcrypto } from 'node:crypto'
import { resolveOwnerManifest } from '../src/integration/owner-approval'
import type { PublicOwnerOperation, PublicJourneyView } from '../src/integration/testnet'

function fixture() {
  const manifest = { network: 'testnet', owner: 'alice.testnet', mandate: 'mandate.testnet', kind: 'stop', gas: '100000000000000' }
  const operation = { operationId: 'a'.repeat(64), action: 'stop', status: 'AWAITING_WALLET', signerId: 'alice.testnet',
    transactionHash: null, receipt: null, request: { network: 'testnet', signerId: 'alice.testnet', receiverId: 'mandate.testnet',
      methodName: 'stop', args: {}, gas: '100000000000000', deposit: '0' } } as PublicOwnerOperation
  // Bounded terms-projector fixture, not a complete rendered/chain journey.
  const view = { job: { jobId: 'job-1', manifestId: 'approved', ownerId: 'alice.testnet', scope: { networkId: 'testnet', mandateId: 'mandate.testnet' } },
    ownerApproval: { jobId: 'job-1', manifestId: 'approved', ownerId: 'alice.testnet', mandateId: 'mandate.testnet',
      actions: { create: null, stop: manifest, withdraw: { ...manifest, kind: 'withdraw' } } } }
  return { manifest, operation, view }
}

test('uses independently projected immutable owner terms, not the unsigned candidate as its own authority', async () => {
  const { manifest, operation, view } = fixture()
  const result = await resolveOwnerManifest(operation, view as unknown as PublicJourneyView)
  expect(result).toEqual(manifest)
  expect(result).not.toBe(manifest)
  operation.request = { ...(operation.request as object), receiverId: 'attacker.testnet' }
  await expect(resolveOwnerManifest(operation, view as unknown as PublicJourneyView)).rejects.toThrow()
})

for (const field of ['jobId', 'manifestId', 'ownerId', 'mandateId'] as const) test(`rejects owner approval bound to another ${field}`, async () => {
  const { operation, view } = fixture()
  view.ownerApproval[field] = 'other.testnet'
  await expect(resolveOwnerManifest(operation, view as unknown as PublicJourneyView)).rejects.toThrow()
})

test('missing approved terms never falls back to the operation request', async () => {
  const { operation, view } = fixture()
  const { ownerApproval: _ignored, ...unconfigured } = view
  await expect(resolveOwnerManifest(operation, unconfigured as unknown as PublicJourneyView)).rejects.toThrow()
})

test('creation terms bind the exact approved cap, recipients, deadline, child and deposit before wallet transport', async () => {
  vi.stubGlobal('crypto', webcrypto)
  try {
    const owner = 'alice.testnet', factory = 'factory.testnet', job_label = 'supplier'
    const mandate = `j${createHash('sha256').update(`${owner}:${job_label}`).digest('hex').slice(0, 32)}.${factory}`
    const expiresAt = '2026-11-13T18:00:00Z'
    const creation = { network: 'testnet', owner, mandate, kind: 'create', gas: '300000000000000', factory, job_label,
      agent: 'agent.testnet', allowlist: ['vendor.testnet'], cap: '30', deadline_ns: String(BigInt(Date.parse(expiresAt)) * 1000000n), operating_float: '10' }
    const candidate = { network: 'testnet', signerId: owner, receiverId: factory, methodName: 'create_job', gas: creation.gas,
      deposit: String(BigInt(creation.cap) + BigInt(creation.operating_float)), args: { job_label, agent: creation.agent,
        allowlist: creation.allowlist, cap: creation.cap, deadline_ns: creation.deadline_ns, operating_float: creation.operating_float } }
    const operation = { ...fixture().operation, action: 'create', request: candidate } as PublicOwnerOperation
    const view = { job: { jobId: 'job-1', manifestId: 'approved', ownerId: owner, scope: { mandateId: mandate,
      budgetAtomic: creation.cap, vendorIds: creation.allowlist, expiresAt } },
      ownerApproval: { jobId: 'job-1', manifestId: 'approved', ownerId: owner, mandateId: mandate, actions: { create: creation } } }
    expect(await resolveOwnerManifest(operation, view as unknown as PublicJourneyView)).toEqual(creation)
    for (const [key, bad] of [['budgetAtomic', '31'], ['vendorIds', ['attacker.testnet']], ['expiresAt', '2026-11-13T18:01:00Z']] as const) {
      const altered = structuredClone(view)
      Object.assign(altered.job.scope, { [key]: bad })
      await expect(resolveOwnerManifest(operation, altered as unknown as PublicJourneyView)).rejects.toThrow()
    }
    const altered = structuredClone(operation)
    Object.assign(altered.request as object, { deposit: '41' })
    await expect(resolveOwnerManifest(altered, view as unknown as PublicJourneyView)).rejects.toThrow()
  } finally { vi.unstubAllGlobals() }
})
