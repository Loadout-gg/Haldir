import { prepareOwnerRequest, type OwnerManifest, type UnsignedOwnerCall } from './native-owner-wallet'
import type { PublicOwnerOperation, PublicJourneyView } from './testnet'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function requireTerms(v: unknown): asserts v { if (!v) throw new Error('OWNER_TERMS_NOT_CONFIGURED') }

/** Accept only the same-origin server's independent persisted-terms projection.
 * The candidate operation is compared against it, never used to construct it.
 * Returning terms does not approve a signature or establish chain settlement.
 */
export async function resolveOwnerManifest(operation: PublicOwnerOperation, view: PublicJourneyView): Promise<OwnerManifest> {
  const envelope = (view as unknown as Record<string, unknown>).ownerApproval
  requireTerms(object(envelope) && envelope.manifestId === view.job.manifestId && envelope.jobId === view.job.jobId &&
    envelope.ownerId === view.job.ownerId && envelope.mandateId === view.job.scope.mandateId && object(envelope.actions))
  const source = envelope.actions[operation.action]
  requireTerms(object(source) && source.network === 'testnet' && source.owner === view.job.ownerId &&
    source.mandate === view.job.scope.mandateId && source.kind === operation.action && operation.signerId === view.job.ownerId)
  const manifest = structuredClone(source) as OwnerManifest
  if (manifest.kind === 'create') {
    requireTerms(manifest.cap === view.job.scope.budgetAtomic &&
      JSON.stringify(manifest.allowlist) === JSON.stringify(view.job.scope.vendorIds) &&
      typeof view.job.scope.expiresAt === 'string' && Number.isSafeInteger(Date.parse(view.job.scope.expiresAt)))
    requireTerms(manifest.deadline_ns === String(BigInt(Date.parse(view.job.scope.expiresAt)) * 1_000_000n))
  }
  await prepareOwnerRequest(manifest, operation.request as UnsignedOwnerCall)
  return manifest
}
