import type { Dispatch } from 'react'
import { Button } from '@/components/ui/button'
import { type State, type Event, ledger } from './model'
const recordsRequest: Event = { type: 'REQUEST', id: 'DEMO-RECORDS-01', recipient: 'records', amount: 800, content: 'Company records' }
const backgroundRequest: Event = { type: 'REQUEST', id: 'DEMO-BACKGROUND-02', recipient: 'background', amount: 1500, content: 'Background research' }
export function DemoControls({ state: s, dispatch }: { state: State; dispatch: Dispatch<Event> }) {
  const run = (...events: Event[]) => events.forEach(dispatch)
  const first = s.orders.find(o => o.id === recordsRequest.id)
  const second = s.orders.find(o => o.id === backgroundRequest.id)
  const pending = first && ['pending', 'uncertain'].includes(first.payment)
  return <details className="demo-controls rounded-xl border bg-background" aria-label="Demo controls">
    <summary>Demo controls</summary>
    <p className="text-muted-foreground">Use these controls to choose simulated funding, payment and delivery outcomes. Nothing advances automatically. Restart or reload clears this demo session, including messages, notes, permissions, balances, activity and results. It starts a new demo, not a continuation of this task. Demo clock: 12 Nov 2026, 12:00 UTC.</p>
    <div className="demo-grid">
      <fieldset><legend>Entry and replay</legend><div className="action-row">
        <Button variant="outline" onClick={() => dispatch({ type: 'RESET' })}>Reset demo</Button>
        <Button variant="outline" disabled={s.phase !== 'entry'} onClick={() => dispatch({ type: 'EXTERNAL' })}>Open external proposal</Button>
      </div></fieldset>
      <fieldset><legend>S02 · Activation outcome</legend><div className="action-row">
        <Button variant="outline" disabled={s.phase !== 'funding' || s.fundingError} onClick={() => dispatch({ type: 'FUNDING_CONFIRMED' })}>Confirm funding</Button>
        <Button variant="outline" disabled={s.phase !== 'funding' || s.fundingError} onClick={() => dispatch({ type: 'FUNDING_FAILED' })}>Fail funding</Button>
      </div></fieldset>
      <fieldset><legend>Main storyboard</legend><div className="action-row">
        <Button variant="outline" disabled={s.phase !== 'active' || !!first} onClick={() => run(recordsRequest, { type: 'PAID', id: recordsRequest.id }, { type: 'DELIVER', id: recordsRequest.id })}>S03 · Deliver company records</Button>
        <Button variant="outline" disabled={s.phase !== 'active' || first?.delivery !== 'received' || s.blocks.some(b => b.id === 'DEMO-EXCLUDED-03')} onClick={() => dispatch({ type: 'REQUEST', id: 'DEMO-EXCLUDED-03', amount: 200, recipient: 'excluded', content: 'Email verification fee' })}>S04 · Excluded recipient request</Button>
        <Button variant="outline" disabled={s.phase !== 'active' || first?.delivery !== 'received' || !!second} onClick={() => run(backgroundRequest, { type: 'REQUEST', id: 'DEMO-EXTRA-04', amount: 1500, recipient: 'records', content: 'Additional company details' })}>S05 · Two requests together</Button>
        <Button variant="outline" disabled={!second || !['pending', 'uncertain'].includes(second.payment)} onClick={() => run({ type: 'PAID', id: backgroundRequest.id }, { type: 'DELIVER', id: backgroundRequest.id })}>S06 · Deliver background research</Button>
      </div><p className="text-muted-foreground">For the main story, use a 30 TEST purchase limit and select both recipients. Edited terms may produce different blocks and balances. S05 checks two 15 TEST requests in order; this is not a live simultaneous payment test.</p></fieldset>
      <fieldset><legend>Payment and delivery recovery</legend><div className="action-row">
        <Button variant="outline" disabled={s.phase !== 'active' || !!first} onClick={() => dispatch(recordsRequest)}>Start company records payment</Button>
        <Button variant="outline" disabled={first?.payment !== 'pending'} onClick={() => dispatch({ type: 'UNCERTAIN', id: recordsRequest.id })}>Make company records payment uncertain</Button>
        <Button variant="outline" disabled={!pending} onClick={() => dispatch({ type: 'PAID', id: recordsRequest.id })}>Confirm company records payment</Button>
        <Button variant="outline" disabled={!pending} onClick={() => dispatch({ type: 'FAILURE_CONFIRMED', id: recordsRequest.id })}>Confirm failed company records payment</Button>
        <Button variant="outline" disabled={first?.payment !== 'paid' || first.delivery === 'received'} onClick={() => dispatch({ type: 'DELIVER', id: recordsRequest.id })}>Deliver company records response</Button>
      </div>
        {s.orders.filter(o => o.id !== recordsRequest.id && o.id !== backgroundRequest.id).map(o => <div key={o.id} className="action-row">
          <Button variant="outline" disabled={!['pending', 'uncertain'].includes(o.payment)} onClick={() => dispatch({ type: 'PAID', id: o.id })}>Confirm {o.content.toLowerCase()} payment</Button>
          <Button variant="outline" disabled={o.payment !== 'paid' || o.delivery === 'received'} onClick={() => dispatch({ type: 'DELIVER', id: o.id })}>Deliver {o.content.toLowerCase()} response</Button>
        </div>)}
      </fieldset>
      <fieldset><legend>S07–S08 · Stop and return outcomes</legend><div className="action-row">
        <Button variant="outline" disabled={s.phase !== 'stopRequested'} onClick={() => dispatch({ type: 'STOP_CONFIRMED' })}>Confirm stop</Button>
        <Button variant="outline" disabled={!['stopped', 'closed'].includes(s.phase)} onClick={() => dispatch({ type: 'REQUEST', id: 'DEMO-AFTER-STOP-05', recipient: 'records', amount: 100, content: 'New purchase after stop' })}>Try a new purchase after stop</Button>
        <Button variant="outline" disabled={s.phase !== 'returnPending'} onClick={() => dispatch({ type: 'RETURN_UNCERTAIN' })}>Make return uncertain</Button>
        <Button variant="outline" disabled={s.phase !== 'returnPending' || ledger(s).reserved > 0} onClick={() => dispatch({ type: 'RETURN_CONFIRMED' })}>Confirm return</Button>
      </div></fieldset>
      <fieldset><legend>Expiry</legend><div className="action-row">
        <Button variant="outline" disabled={s.phase !== 'active' || s.expired} onClick={() => dispatch({ type: 'EXPIRE' })}>Advance clock past expiry</Button>
        <Button variant="outline" disabled={!s.expired} onClick={() => dispatch({ type: 'REQUEST', id: 'DEMO-EXPIRED-06', recipient: 'records', amount: 100, content: 'New purchase after expiry' })}>Try purchase after expiry</Button>
      </div></fieldset>
    </div>
  </details>
}
