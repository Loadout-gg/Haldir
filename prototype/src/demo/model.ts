// Local scripted simulation only. No transport, wallet or chain evidence.
export type Draft = { job: string; output: string; budget: string; expiry: string; records: boolean; background: boolean }
export type Phase = 'entry' | 'draft' | 'review' | 'funding' | 'active' | 'stopRequested' | 'stopped' | 'returnPending' | 'closed'
export type Order = { id: string; content: string; recipient: 'records' | 'background' | 'excluded'; amount: number; payment: 'pending' | 'uncertain' | 'paid' | 'failed'; delivery: 'missing' | 'requested' | 'received' }
export type Block = { id: string; amount: number; reason: string; content?: string; recipient?: Order['recipient']; available: number; spending: ReturnType<typeof ledger> }
export type ActivityEvent = { sequence: number; type: string; text: string; blockId?: string }
export type Provenance = Record<keyof Draft, string>
export type State = { activity: ActivityEvent[]; continued: string[]; fundingStopped: boolean; proposal: Draft | null; approvedProposal: Draft | null; authorizationHistory: Draft[]; provenance: Provenance; phase: Phase; entry: 'chat' | 'external'; draft: Draft; authorized: Draft | null; funded: number; recovered: number; orders: Order[]; blocks: Block[]; messages: { from: 'user' | 'reply'; text: string }[]; note: string; fundingError: boolean; reconciled: boolean; expired: boolean }
export type Event = { type: string; draft?: Draft; text?: string; id?: string; content?: string; recipient?: Order['recipient']; amount?: number }
export const defaultDraft: Draft = { job: 'Check Northwind Print before I sign', output: 'A short brief with the evidence and purchase receipts', budget: '30', expiry: '2026-11-12T18:00', records: true, background: true }
export function createState(): State { return { activity: [], continued: [], fundingStopped: false, proposal: null, approvedProposal: null, authorizationHistory: [], provenance: { job: 'From your request', output: 'Proposed by agent · Based on your request; includes purchase receipts', budget: 'Missing', expiry: 'Missing', records: 'Proposed by agent · Needs review', background: 'Proposed by agent · Needs review' }, phase: 'entry', entry: 'chat', draft: { ...defaultDraft, output: 'A short brief with the evidence and purchase receipts', budget: '', expiry: '' }, authorized: null, funded: 0, recovered: 0, orders: [], blocks: [], messages: [], note: '', fundingError: false, reconciled: false, expired: false } }
export function units(value: string): number | null {
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return n > 0 ? n : null
}
export function ledger(s: State) {
  const spent = s.orders.filter(o => o.payment === 'paid').reduce((n, o) => n + o.amount, 0)
  const reserved = s.orders.filter(o => ['pending', 'uncertain'].includes(o.payment)).reduce((n, o) => n + o.amount, 0)
  return { spent, reserved, available: s.funded - s.recovered - spent - reserved, recovered: s.recovered }
}
export function validDraft(d: Draft): boolean {
  const date = new Date(`${d.expiry}:00Z`)
  const future = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d.expiry) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === d.expiry && d.expiry > '2026-11-12T12:00'
  return Boolean(d.job.trim() && d.output.trim() && units(d.budget) && future && (d.records || d.background))
}
function reduce(s: State, e: Event): State {
  switch (e.type) {
    case 'EDIT': return ['draft', 'review'].includes(s.phase) && e.draft ? { ...s, phase: 'draft', draft: { ...e.draft }, provenance: Object.fromEntries((Object.keys(s.draft) as (keyof Draft)[]).map(key => [key, s.draft[key] === e.draft![key] ? s.provenance[key] : 'Reviewed in editor'])) as Provenance, note: 'Draft updated. Saving is not authorization.' } : s
    case 'SEND': {
      const text = e.text?.trim().slice(0, 1000)
      if (!text) return s
      let draft = s.draft
      const provenance = { ...s.provenance }
      let reply = 'This is a scripted demo. Use “job …; output …; budget 30; expiry 2026-11-12T18:00”. Messages never authorize spending.'
      if (['entry', 'draft', 'review'].includes(s.phase) && !/\b(approv|authoriz|start|pay|send money)/i.test(text)) {
        const fields = text.split(';').map(part => /^(budget|job|output|expiry)\s+(.+)$/i.exec(part.trim())).filter(Boolean)
        for (const match of fields) {
          const key = match![1].toLowerCase() as 'budget' | 'job' | 'output' | 'expiry'
          draft = { ...draft, [key]: match![2].replace(/\s+TEST$/i, '') }
          provenance[key] = s.phase === 'entry' ? 'From your request' : 'From chat'
        }
        if (!fields.length && s.phase === 'entry') {
          draft = { ...draft, job: text, output: /brief.*evidence/i.test(text) ? 'A short brief with the evidence and purchase receipts' : '' }
          provenance.output = draft.output ? 'Proposed by agent · Based on your request; includes purchase receipts' : 'Missing'
        }
        // Bounded demo grammar: explicit TEST amount and ISO UTC date only.
        // Unsupported dates are asked for, never guessed against the wall clock.
        const amount = /\b(?:up to|budget|limit(?: of)?)\s+(\d{1,4}(?:\.\d{1,2})?)\s*TEST\b/i.exec(text)
        const expiry = /\b(?:until|expiry)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\s*UTC\b/i.exec(text)
        if (amount) { draft = { ...draft, budget: amount[1] }; provenance.budget = s.phase === 'entry' ? 'From your request' : 'From chat' }
        if (expiry) { draft = { ...draft, expiry: expiry[1] }; provenance.expiry = s.phase === 'entry' ? 'From your request' : 'From chat' }
        const missing = [!draft.job && 'job', !draft.output && 'output', !units(draft.budget) && 'budget', !draft.expiry && 'expiry'].filter(Boolean)
        reply = validDraft(draft) ? 'Here is the proposed spending mandate. Review the recipients, limit and expiry. Nothing is authorized yet.' : `What ${missing.join(' and ') || 'valid future expiry and allowed recipients'} should I use? Please confirm the missing information; no values have been assumed.`
      } else if (s.authorized) reply = 'Your authorized terms are unchanged. Messages cannot change permissions or stop spending. Use the spending controls; this is a scripted demo.'
      return { ...s, draft, provenance, phase: ['entry', 'draft', 'review'].includes(s.phase) ? validDraft(draft) ? 'review' : 'draft' : s.phase, messages: [...s.messages, { from: 'user', text }, { from: 'reply', text: reply }], note: reply }
    }
    case 'SHAPE': return s.phase === 'entry' ? { ...s, phase: 'draft', note: 'Your draft is ready. Review the spending limits before authorizing.' } : s
    case 'EXTERNAL': return s.phase === 'entry' ? { ...s, entry: 'external', draft: { ...defaultDraft }, provenance: { job: 'External proposal · Needs review', output: 'External proposal · Needs review', budget: 'External proposal · Needs review', expiry: 'External proposal · Needs review', records: 'Proposed by agent · Needs review', background: 'Proposed by agent · Needs review' }, phase: 'review', note: 'Fictional external proposal. No progress or results have been supplied.' } : s
    case 'REVIEW': return s.phase === 'draft' && validDraft(s.draft) ? { ...s, phase: 'review' } : s
    case 'AUTHORIZE': return s.phase === 'review' && validDraft(s.draft) ? { ...s, phase: 'funding', authorized: { ...s.draft }, authorizationHistory: [...s.authorizationHistory, { ...s.draft }], note: 'Authorization confirmed in this demo. Funding pending; work has not started.' } : s
    case 'FUNDING_CONFIRMED': return s.phase === 'funding' && !s.fundingError ? { ...s, phase: s.fundingStopped ? 'stopped' : 'active', funded: units(s.authorized!.budget)!, note: s.fundingStopped ? 'Funding confirmed after stop. New spending remains disabled; work has not started.' : 'Funding confirmed in this demo. Spending is now active.' } : s
    case 'REQUEST': {
      const block = (reason: string): State => ({ ...s, blocks: [...s.blocks.filter(b => b.id !== e.id), { id: e.id || 'invalid', amount: e.amount || 0, reason, content: e.content || e.id, recipient: e.recipient, available: ledger(s).available, spending: ledger(s) }], note: `${reason}. No money moved for this request.` })
      if (!e.id || !Number.isSafeInteger(e.amount) || e.amount! <= 0 || !e.recipient) return block('Invalid request')
      const old = s.orders.find(o => o.id === e.id)
      if (old) return old.amount === e.amount && old.recipient === e.recipient && old.content === (e.content || e.id) ? s : block('Operation details changed')
      const priorBlock = s.blocks.find(b => b.id === e.id)
      if (priorBlock) return priorBlock.amount === e.amount && priorBlock.recipient === e.recipient && priorBlock.content === (e.content || e.id) ? s : { ...s, note: 'Operation details changed. Original blocked attempt retained; no money moved.' }
      if (['stopped', 'returnPending', 'closed'].includes(s.phase)) return block('Spending stopped')
      if (s.expired) return block('Spending permission expired')
      if (s.phase !== 'active') return block('Spending not active')
      if (e.recipient === 'excluded' || !s.authorized?.[e.recipient]) return block('Recipient not allowed')
      if (e.amount! > ledger(s).available) return block('Insufficient budget')
      return { ...s, reconciled: false, orders: [...s.orders, { id: e.id, content: e.content || e.id, amount: e.amount!, recipient: e.recipient, payment: 'pending', delivery: 'missing' }], note: `${e.content || e.id}: payment pending. Funds are reserved, not spent.` }
    }
    case 'PAID': {
      const order = s.orders.find(o => o.id === e.id)
      return order && ['pending', 'uncertain'].includes(order.payment) ? { ...s, orders: s.orders.map(o => o.id === e.id ? { ...o, payment: 'paid' } : o), note: 'Payment confirmed in this demo. Delivery is still missing.' } : s
    }
    case 'DELIVER': {
      const order = s.orders.find(o => o.id === e.id)
      return order?.payment === 'paid' && order.delivery !== 'received' ? { ...s, orders: s.orders.map(o => o.id === e.id ? { ...o, delivery: 'received' } : o), note: `${order.content} received. Its evidence and purchase receipt are kept together.` } : s
    }
    case 'UNCERTAIN': return s.orders.some(o => o.id === e.id && o.payment === 'pending') ? { ...s, orders: s.orders.map(o => o.id === e.id ? { ...o, payment: 'uncertain' } : o), note: 'Payment outcome uncertain. Funds stay reserved. Check the same operation; do not pay again.' } : s
    case 'CHECK': return s.orders.some(o => o.id === e.id && ['pending', 'uncertain'].includes(o.payment)) ? { ...s, note: 'Checking the same payment. No new payment created; funds remain reserved until a demo outcome is confirmed.' } : s
    case 'RECOVER_DELIVERY': return s.orders.some(o => o.id === e.id && o.payment === 'paid' && o.delivery === 'missing') ? { ...s, orders: s.orders.map(o => o.id === e.id ? { ...o, delivery: 'requested' } : o), note: 'Delivery recovery requested on the same order. No second payment and no implied refund.' } : s
    case 'FAILURE_CONFIRMED': return s.orders.some(o => o.id === e.id && ['pending', 'uncertain'].includes(o.payment)) ? { ...s, orders: s.orders.map(o => o.id === e.id ? { ...o, payment: 'failed' } : o), note: 'Payment failure confirmed in this demo. Its reservation was released once; no purchase was completed.' } : s
    case 'CONTINUE': return e.id && s.blocks.some(b => b.id === e.id) && !s.continued.includes(e.id) ? { ...s, continued: [...s.continued, e.id], note: 'Continuing with authorized activities only. The blocked purchase was not executed; its details remain in Activity.' } : s
    case 'PROPOSE_CHANGE': return s.authorized && !s.proposal ? { ...s, proposal: { ...s.authorized }, approvedProposal: null, note: 'Separate amendment proposal. The current mandate remains unchanged. No recipient has been imported from email.' } : s
    case 'EDIT_PROPOSAL': return s.proposal && e.draft ? { ...s, proposal: { job: e.draft.job, output: e.draft.output, budget: e.draft.budget, expiry: e.draft.expiry, records: e.draft.records, background: e.draft.background }, approvedProposal: null, note: 'Amendment proposal saved, not authorized or active.' } : s
    case 'REAUTHORIZE_PROPOSAL': return s.proposal && !s.approvedProposal && validDraft(s.proposal) ? { ...s, approvedProposal: { ...s.proposal }, note: 'Proposal explicitly reauthorized in simulation only. Activation blocked: carryover of existing funds, reservations and expiry is not defined. Current authorized snapshot, history and accounting are unchanged.' } : s
    case 'RESET': return createState()
    case 'FUNDING_FAILED': return s.phase === 'funding' ? { ...s, fundingError: true, note: 'Funding failed in this demo: funds not available. Work has not started. Retry the same funding request.' } : s
    case 'RETRY_FUNDING': return s.phase === 'funding' && s.fundingError ? { ...s, fundingError: false, note: 'Retrying the same funding request. Authorization unchanged; work has not started.' } : s
    case 'STOP': return s.phase === 'funding' && !s.fundingStopped ? { ...s, fundingStopped: true, note: 'New spending disabled before activation in this demo. Later funding cannot start this job. Authorization remains recorded.' } : s.phase === 'active' ? { ...s, phase: 'stopRequested', note: 'Stop requested, not yet confirmed. Do not assume new spending is disabled. Prior payments still need checking.' } : s
    case 'STOP_CONFIRMED': return s.phase === 'stopRequested' ? { ...s, phase: 'stopped', note: 'Stop confirmed in this demo. New spending is refused. Check prior operations before recovering free funds.' } : s
    case 'RECONCILE': return s.phase === 'stopped' ? { ...s, reconciled: ledger(s).reserved === 0, note: ledger(s).reserved ? 'Unresolved payment: funds remain reserved. Check the same operation before recovery.' : 'Prior payments reconciled. Only free funds can be recovered; paid orders are not refunded.' } : s
    case 'RETURN': return s.phase === 'stopped' && s.reconciled && !ledger(s).reserved ? { ...s, phase: 'returnPending', note: 'Return requested. Free funds are not yet recovered. Waiting for confirmation.' } : s
    case 'RETURN_UNCERTAIN': return s.phase === 'returnPending' ? { ...s, note: "We're still waiting for confirmation that your remaining funds have been returned. You don't need to send another request." } : s
    case 'RETURN_CONFIRMED': return s.phase === 'returnPending' ? { ...s, phase: 'closed', recovered: s.recovered + ledger(s).available, note: 'Return confirmed in this demo. Spending permission closed. Results and purchase receipts remain available.' } : s
    case 'EXPIRE': return s.phase === 'active' ? { ...s, expired: true, note: 'Spending permission expired in this demo. New purchases are refused; existing orders can still be resolved.' } : s
    default: return s
  }
}
export function transition(s: State, e: Event): State {
  const next = reduce(s, e)
  if (e.type === 'RESET' || next === s || JSON.stringify(next) === JSON.stringify(s)) return e.type === 'RESET' ? next : s
  if (e.type === 'SEND') return next
  return { ...next, activity: [...s.activity, { sequence: s.activity.length + 1, type: e.type, text: next.note || e.type, ...(e.type === 'REQUEST' && next.blocks.some(b => b.id === e.id) ? { blockId: e.id } : {}) }] }
}
