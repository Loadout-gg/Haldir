// Local preparation only. Never a spending authorization or simulator ledger.
export type PublicDraft = { purpose: string; output: string; budgetAtomic: string; expiresAt: string; sourceIds: ['company-records','background-research'] }
export type PublicJobTerms = { networkId: 'testnet'; mandateId: string; purpose: string; output: string; budgetAtomic: string; vendorIds: string[]; expiresAt: string }
export type PublicQuote = { networkId: 'testnet'; mandateId: string; vendorId: string; amountAtomic: string; orderId: string; content: string }
export type PublicApprovalPreview = { contractVersion: 'haldir.public.v1' | 'haldir.public.v2'; approvalId: string; manifestId: string; ownerId: string; ownerCreationRequired: boolean; approved: { job: PublicJobTerms; quote: PublicQuote } | { schemaVersion: 'haldir.approved.two-source.v1'; job: PublicJobTerms; sources: [{ sourceId: 'company-records'; quote: PublicQuote },{ sourceId: 'background-research'; quote: PublicQuote }] } }
export function draftFromPreview(preview: PublicApprovalPreview): PublicDraft { const j = preview.approved.job; return { purpose:j.purpose, output:j.output, budgetAtomic:j.budgetAtomic, expiresAt:j.expiresAt, sourceIds:['company-records','background-research'] } }
export function draftMatchesPreview(draft: PublicDraft, preview: PublicApprovalPreview): boolean { return preview.contractVersion === 'haldir.public.v2' && JSON.stringify(draft.sourceIds) === JSON.stringify(['company-records','background-research']) && (['purpose','output','budgetAtomic','expiresAt'] as const).every(k => draft[k] === preview.approved.job[k]) }
export const emptyPublicDraft = (): PublicDraft => ({ purpose: '', output: '', budgetAtomic: '', expiresAt: '', sourceIds: ['company-records','background-research'] })
export function readPublicDraft(storage: Pick<Storage,'getItem'>, origin: string): PublicDraft {
  try {
    const d = JSON.parse(storage.getItem(`haldir-public-draft-v1:${origin}`) ?? 'null')
    if (d && Object.keys(d).sort().join('|') === 'budgetAtomic|expiresAt|output|purpose|sourceIds' && ['purpose','output','budgetAtomic','expiresAt'].every(k => typeof d[k] === 'string') && JSON.stringify(d.sourceIds) === JSON.stringify(['company-records','background-research'])) return d
  } catch { /* Invalid local preparation cannot become authority. */ }
  return emptyPublicDraft()
}
