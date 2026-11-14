import { useId, useState } from 'react'
import type { Dispatch, ReactNode } from 'react'
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button as NativeButton } from '@/components/ui/base-nova/button'
import { Card as NativeCard, CardContent as NativeCardContent } from '@/components/ui/base-nova/card'

import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ledger, units, validDraft, type State, type Draft, type Event, type Order } from './model'

import { money } from './presentation'
import { recipientRecords } from './fixtures'

export function Ledger({ state }: { state: State }) {
  const l = ledger(state)
  return <dl className="ledger" data-testid="ledger">{(['spent', 'reserved', 'available', 'recovered'] as const).map(key => <div key={key}><dt className="text-muted-foreground">{key[0].toUpperCase() + key.slice(1)}</dt><dd className="tabular-nums font-medium">{money(l[key])}</dd></div>)}</dl>
}
export function Terms({ draft, panel = false, part = 'all' }: { draft: Draft; panel?: boolean; part?: 'all' | 'job' | 'spending' | 'context' }) {
  return <dl className={`terms${panel ? ' panel-terms' : ''}`}>
    {(part === 'all' || part === 'job') && <><div><dt className="text-muted-foreground">Job</dt><dd>{draft.job || 'Missing job'}</dd></div>
    <div><dt className="text-muted-foreground">Output</dt><dd>{draft.output || 'Missing output'}</dd></div></>}
    {(part === 'all' || part === 'context') && <div><dt className="text-muted-foreground">Working for you</dt><dd>Research agent · Scripted demo</dd></div>}
    {(part === 'all' || part === 'spending') && <><div className={panel ? 'term-numeric' : undefined}><dt className="text-muted-foreground">Purchase limit</dt><dd className={panel ? 'tabular-nums' : undefined}>{units(draft.budget) ? money(units(draft.budget)!) : panel && !draft.budget ? 'Not set' : 'Enter a valid budget'}</dd></div>
    <div><dt className="text-muted-foreground">Permission expires</dt><dd>{panel && !draft.expiry ? 'Not set' : `${draft.expiry.replace('T', ' · ')} UTC`}</dd></div></>}
    {(part === 'all' || part === 'context') && <div><dt className="text-muted-foreground">Who can receive funds</dt><dd>{[draft.records && 'Company records source', draft.background && 'Background research source'].filter(Boolean).join(' and ') || 'No recipients selected'}</dd></div>}
  </dl>
}
export function Editor({ state, dispatch, onClose = () => {}, amendment = false }: { state: State; dispatch: Dispatch<Event>; onClose?: () => void; amendment?: boolean }) {
  const source = amendment ? state.proposal! : state.draft
  const [base, setBase] = useState(source)
  const [edits, setEdits] = useState<Partial<Draft>>({})
  const [leaving, setLeaving] = useState(false)
  const draft = { ...source, ...edits }
  const keys = Object.keys(edits) as (keyof Draft)[]
  const conflict = keys.some(key => base[key] !== source[key])
  const id = useId()
  const field = (key: keyof Draft, value: string | boolean) => { setEdits(d => ({ ...d, [key]: value })); setLeaving(false) }
  const close = () => keys.length ? setLeaving(true) : onClose()
  const complete = [Boolean(draft.job.trim()), Boolean(draft.output.trim()), Boolean(units(draft.budget)), Boolean(draft.expiry), draft.records || draft.background, true].filter(Boolean).length
  const origin = (key: keyof Draft) => edits[key] !== undefined ? 'Your unsaved edit' : amendment ? 'From current authorized snapshot · Proposal only' : state.provenance[key]
  return <section role="region" aria-label="Edit draft details" className={`native-shadcn space-y-4${amendment ? '' : ' panel-editor'}`}>
    {amendment ? <><h3 className="font-medium">Edit amendment proposal</h3><NativeButton variant="outline" onClick={close}>Back to summary</NativeButton></> : <div className="editor-heading"><h3 className="font-medium">Edit draft details</h3>
    <NativeButton variant="outline" onClick={close}>Back to summary</NativeButton></div>}
    <p className="editor-completeness">{amendment ? 'SEPARATE PROPOSAL — NOT ACTIVE' : 'DRAFT — NOT AUTHORIZED'} · {complete} of 6 complete</p>
    {!amendment && (state.provenance.records.includes('Needs review') || state.provenance.background.includes('Needs review')) && <p className="text-muted-foreground">Recipients need review before authorization. Inspect the selected trusted records at review.</p>}
    <p className="text-muted-foreground">{amendment ? 'This editor changes a separate permission proposal, not the chat draft or current permissions. Save to update the proposal only; authorization will not apply it to this task in the demo.' : 'Chat and this editor share the same draft. Save to apply your edits to the draft, not to authorize spending. The research agent cannot be changed here.'}</p>
    <form className="draft-form" onSubmit={e => { e.preventDefault(); if (!conflict) { dispatch({ type: amendment ? 'EDIT_PROPOSAL' : 'EDIT', draft }); onClose() } }}>
      {(['job', 'output', 'budget', 'expiry'] as const).map(key => <div className="draft-field" key={key}>
        <label htmlFor={`${id}-${key}`}>{{job:'Job',output:'Output',budget:'Purchase budget (TEST)',expiry:'Permission expiry (UTC)'}[key]}</label>
        {amendment && <p id={`${id}-${key}-origin`} className="text-muted-foreground">{origin(key)}{!draft[key] ? ' · Missing' : ''}</p>}
        {key === 'job' || key === 'output' ? <Textarea id={`${id}-${key}`} aria-describedby={`${id}-${key}-origin`} maxLength={key === 'job' ? 1000 : 250} value={draft[key]} onChange={e => field(key,e.target.value)} /> : <Input id={`${id}-${key}`} aria-describedby={`${id}-${key}-origin`} type={key === 'expiry' ? 'datetime-local' : 'text'} inputMode={key === 'budget' ? 'decimal' : undefined} value={draft[key]} onChange={e => field(key,e.target.value)} />}
        {!amendment && <p id={`${id}-${key}-origin`} className="text-muted-foreground field-provenance">{origin(key)}{!draft[key] ? ' · Missing' : ''}</p>}
      </div>)}
      <p className="text-muted-foreground">Illustrative TEST only · Network fees separate. Demo clock: 12 Nov 2026, 12:00 UTC. Choose a later expiry.</p>
      <fieldset className="permission-fields"><legend>Who can receive funds</legend><p className="text-muted-foreground">{origin('records')} · Only trusted demo records; never recipients from email.</p>
        <label><input type="checkbox" checked={draft.records} onChange={e => field('records',e.target.checked)} />Company records source</label>
        <label><input type="checkbox" checked={draft.background} onChange={e => field('background',e.target.checked)} />Background research source</label>
      </fieldset>
      {!validDraft(draft) && <p>Needs completion: job, output, valid budget, future expiry and at least one recipient. Incomplete drafts can be saved, not authorized.</p>}
      {conflict && <div role="alert"><p>Chat changed a field you are editing. Choose before saving; no value has been overwritten.</p><div className="action-row"><NativeButton variant="outline" type="button" onClick={() => { setEdits({}); setBase(source) }}>Use latest chat values</NativeButton><NativeButton variant="outline" type="button" onClick={() => setBase(source)}>Keep my edits</NativeButton></div></div>}
      <div className="action-row"><NativeButton disabled={conflict} type="submit">Save draft</NativeButton><NativeButton variant="outline" type="button" onClick={close}>Cancel</NativeButton></div>
      <p className="text-muted-foreground">Saving a draft does not authorize spending.</p>
    </form>
    {leaving && <div role="alert"><p>Unsaved changes. Discard them or keep editing?</p><div className="action-row"><NativeButton variant="outline" onClick={onClose}>Discard changes</NativeButton><NativeButton variant="outline" onClick={() => setLeaving(false)}>Keep editing</NativeButton></div></div>}
  </section>
}
export function Review({ state, dispatch, onEdit = () => {}, onAsk = () => {} }: { state: State; dispatch: Dispatch<Event>; onEdit?: () => void; onAsk?: () => void }) {
  const review = state.phase === 'review'
  if (!review) return <section aria-label="Spending review" className="native-shadcn space-y-3">
    <p>Your job draft · Not authorized. The task panel holds the same draft; keep chatting to complete it.</p>
    {!validDraft(state.draft) && <p className="text-muted-foreground">Missing or needs review: {(!state.draft.budget || !units(state.draft.budget)) && 'budget · '}{!state.draft.expiry && 'expiry · '}check the proposed recipients before authorization.</p>}
    <div className="action-row"><NativeButton disabled={!validDraft(state.draft)} onClick={() => dispatch({ type: 'REVIEW' })}>Review spending limits</NativeButton><NativeButton variant="outline" onClick={onEdit}>Edit details</NativeButton></div>
  </section>
  return <section aria-label="Spending review" className="spending-review native-shadcn">
    <NativeCard className="mandate-card">
    <div className="mandate-heading"><h2 className="surface-title">Proposed spending mandate</h2><p>Ready for review · Not authorized</p></div>
    <NativeCardContent className="space-y-4">
      <h3 className="font-medium">Spending permissions and costs</h3>
      <Terms draft={state.draft} />
      <fieldset aria-label="Who can receive funds"><legend>Who can receive funds</legend>{recipientRecords.filter(r => state.draft[r.key]).map(r => <div role="group" aria-label={r.name} key={r.key} className="recipient-record"><p>{r.name}</p><details><summary>Details</summary><p>{r.id} · Fictional identifier, not a live account.</p><p>{r.detail}</p></details></div>)}</fieldset>
      <details className="text-muted-foreground"><summary>How this limit is enforced</summary><p>The local simulator checks authorization, confirmed funding, stop state, expiry, allowed recipient and available funds before reserving a purchase. A request within budget is still refused for an unlisted recipient. This is not live financial enforcement.</p></details>
      <p className="text-muted-foreground">TEST is a fictional unit. No live network or asset selected. Network costs are separate from this purchase limit, not quoted; none are charged in the demo.</p>
      <details className="text-muted-foreground"><summary>Spending permissions and costs</summary>
        <p>The agent may request purchases only from the selected recipients, within this limit and expiry. It cannot add recipients, increase the budget or recover your funds. Job wording is not a guaranteed spending rule.</p>
        <p>TEST is a fictional unit, not money. Network: simulated only; live network and asset not selected. Network fees are separate from the purchase limit and not quoted. No fees are charged in this demo.</p>
        <p>Setting a limit does not fund it. Activation needs both authorization and funding confirmation. No wallet or real signature is involved.</p>
      </details>
      {!validDraft(state.draft) && <p role="status">Draft incomplete: review the job, output, budget, expiry and recipients in the editor.</p>}
    </NativeCardContent></NativeCard>
      <div className="action-row mandate-actions">
        <NativeButton disabled={!validDraft(state.draft)} onClick={() => dispatch({ type: review ? 'AUTHORIZE' : 'REVIEW' })}>{review ? 'Authorize mandate' : 'Review spending limits'}</NativeButton>
        <NativeButton variant="outline" onClick={onEdit}>Edit details</NativeButton>
        {review && <NativeButton variant="outline" onClick={onAsk}>Ask a question</NativeButton>}
      </div>
      <p className="text-muted-foreground">{review ? 'Authorizes the permissions shown here in the simulation. It does not add funds or start work. Funding must be confirmed separately in Demo controls.' : 'Not authorized. Edit here or update the same draft in the conversation.'}</p>
  </section>
}
function Reading({ title, children, button, label = button }: { title: string; children: ReactNode; button: string; label?: string }) {
  return <Dialog><DialogTrigger render={<NativeButton variant="outline" aria-label={label} />}>{button}</DialogTrigger><DialogContent className="context-dialog native-shadcn"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Fictional sample · Local simulation, not a verified company finding or financial proof.</DialogDescription></DialogHeader><div className="reading-content">{children}</div></DialogContent></Dialog>
}
export function OrderResult({ order, dispatch, panel = false, highlightReceived = false }: { order: Order; dispatch: Dispatch<Event>; panel?: boolean; highlightReceived?: boolean }) {
  const name = order.content.toLowerCase()
  const title = order.content
  return <article className="order-result native-shadcn border-t" aria-label={title}>
    <h3 className="font-medium">{title}</h3>
    <p className="text-muted-foreground" data-tone={highlightReceived && order.delivery === 'received' ? 'received' : undefined}>{order.payment === 'paid' ? order.delivery === 'received' ? 'Paid · Evidence received' : order.delivery === 'requested' ? 'Paid · Delivery recovery requested' : 'Paid · Delivery missing' : order.payment === 'failed' ? 'Payment failed · No evidence purchased' : order.payment === 'uncertain' ? 'Payment uncertain · Funds reserved' : 'Payment pending · Funds reserved'} · {money(order.amount)}</p>
    {order.delivery === 'received' && <p className="text-muted-foreground" data-tone={highlightReceived ? 'received' : undefined}>Purchase reference · {order.id}</p>}
    <div className="action-row">
      {order.delivery === 'received' && <Reading title={`${title} evidence`} label={panel ? `Open evidence — ${name}` : `Open ${name} evidence`} button={panel ? 'Open evidence' : `Open ${name} evidence`}><p>Fictional sample for Northwind Print. {title} source received on this order.</p><p>{order.recipient === 'records' ? 'Compare the supplied company details with the contract. This placeholder does not establish an identity match.' : 'Background information is supplied as a demonstration excerpt only. No rating, legal or compliance conclusion is made.'}</p><p>Linked purchase: {order.id} · {money(order.amount)}.</p></Reading>}
      {order.payment === 'paid' && <Reading title={`${title} receipt`} label={panel ? `Open receipt — ${name}` : `Open ${name} receipt`} button={panel ? 'Open receipt' : `Open ${name} receipt`}><dl className="terms"><div><dt>Local reference</dt><dd>{order.id}</dd></div><div><dt>Recipient</dt><dd>{title} source</dd></div><div><dt>Amount</dt><dd>{money(order.amount)}</dd></div><div><dt>Payment</dt><dd>Confirmed in simulation</dd></div><div><dt>Delivery</dt><dd>{{ missing: 'Awaiting data', requested: 'Retrieval requested', received: 'Received' }[order.delivery]}</dd></div></dl><p>Purchase reference · {order.id}. {order.delivery === 'received' ? `${title} evidence is received on this same order.` : 'Evidence is not yet received.'}</p><p>No real transaction, signature, network hash or independently verified receipt exists. Reference links evidence to this local order only.</p></Reading>}
      {['pending', 'uncertain'].includes(order.payment) && <NativeButton variant="outline" onClick={() => dispatch({ type: 'CHECK', id: order.id })}>Check {name} payment</NativeButton>}
      {order.payment === 'paid' && order.delivery === 'missing' && <NativeButton variant="outline" onClick={() => dispatch({ type: 'RECOVER_DELIVERY', id: order.id })}>Recover {name} delivery</NativeButton>}
    </div>
  </article>
}
export function Results({ state, dispatch, panel = false }: { state: State; dispatch: Dispatch<Event>; panel?: boolean }) {
  const received = state.orders.filter(o => o.delivery === 'received')
  const statuses = recipientRecords.map(r => {
      const order = state.orders.find(o => o.recipient === r.key)
      const status = !state.authorized?.[r.key] ? 'Not authorized' : order ? order.delivery === 'received' ? 'Received' : order.payment === 'failed' ? 'Payment failed' : 'In progress' : state.blocks.some(b => b.recipient === r.key) ? 'Blocked' : 'Not started'
      const text = <>{r.key === 'records' ? 'Company records' : 'Background research'} · {status}{!order && status === 'Not started' && ['stopped','returnPending','closed'].includes(state.phase) ? ' · Task stopped' : ''}</>
      return panel ? <li key={r.key}>{text}</li> : <p key={r.key}>{text}</p>
    })
  const content = <>{panel ? <ul className="source-statuses">{statuses}</ul> : statuses}{state.orders.map(o => <OrderResult key={o.id} order={o} dispatch={dispatch} panel={panel} highlightReceived={panel && state.blocks.length === 0} />)}
    {recipientRecords.filter(r => !state.orders.some(o => o.recipient === r.key)).map(r => <article key={r.key} className="order-result source-result" aria-label={`${r.key === 'records' ? 'Company records' : 'Background research'} result`}><h4 className="font-medium">{r.key === 'records' ? 'Company records' : 'Background research'}</h4><p>Evidence — {!state.authorized?.[r.key] ? 'Not authorized' : state.blocks.some(b => b.recipient === r.key) ? 'Blocked' : 'Not started'}{state.authorized?.[r.key] && !state.blocks.some(b => b.recipient === r.key) && ['stopped','returnPending','closed'].includes(state.phase) ? ' · Task stopped' : ''}</p><p>Receipt — None yet</p></article>)}
    {received.length > 0 && <div className="brief-preview"><h3 className="font-medium">Available evidence preview · Partial, not final</h3><p>{received.map(o => o.content).join(' · ')} received. Compare source details with the contract. No final brief or signing assurance exists in this demo.</p></div>}
    {received.length >= 1 ? <Reading title="Northwind Print · Partial brief" button="Open partial brief">
      <h3 className="font-medium">Received</h3><p>Each source is linked to its separate evidence and purchase receipt here.</p>
      {received.map(o => <OrderResult key={o.id} order={o} dispatch={dispatch} />)}
      <h3 className="font-medium">Open check</h3><p>Compare received company details with the contract. Payment confirms spending, not accuracy or suitability.</p>
      <h3 className="font-medium">Additional company details · {state.orders.some(o => o.content === 'Additional company details') ? 'See order status above' : 'Not purchased'}</h3><p>{state.blocks.some(b => b.id === 'DEMO-EXTRA-04') ? 'The extra request did not fit the budget. ' : 'Only supplied evidence is included. '}This brief is partial, not an assurance that it is safe to sign.</p>
    </Reading> : <p className="text-muted-foreground">No brief is available yet. A payment receipt does not mean evidence has arrived.</p>}
    </>
  if (panel) return <section aria-label="Results and receipts" className="results panel-results native-shadcn"><h3 className="font-medium">Results and receipts</h3><div className="panel-result-content">{content}</div></section>
  return <div className="results native-shadcn space-y-4">
    <h2 className="font-medium">Results and receipts</h2>
    <NativeCard className="results-group"><NativeCardContent className="space-y-5">{content}</NativeCardContent></NativeCard>
  </div>
}
