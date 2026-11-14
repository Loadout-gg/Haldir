import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { createState, ledger, transition, type Event, type State } from '../src/demo/model'
import { Results } from '../src/demo/workspace'

const approved = 'Background research · Not started · Task stopped'
// Owner correction section 4/6 supersedes the pre-start pending placeholder.
const pending = 'Background research · Not started'
const records: Event = { type: 'REQUEST', id: 'DEMO-RECORDS-01', recipient: 'records', amount: 800, content: 'Company records' }
const background: Event = { type: 'REQUEST', id: 'DEMO-BACKGROUND-02', recipient: 'background', amount: 1500, content: 'Background research' }
function run(state: State, ...events: (Event | string)[]) {
  return events.reduce<State>((s, e) => transition(s, typeof e === 'string' ? { type: e } : e), state)
}
function active() {
  return run(createState(), { type: 'EXTERNAL' }, 'REVIEW', 'AUTHORIZE', 'FUNDING_CONFIRMED', records,
    { type: 'PAID', id: records.id }, { type: 'DELIVER', id: records.id })
}
const stages = [
  ['active', []],
  ['stop requested', ['STOP']],
  ['stop confirmed', ['STOP', 'STOP_CONFIRMED']],
  ['reconciled', ['STOP', 'STOP_CONFIRMED', 'RECONCILE']],
  ['return pending', ['STOP', 'STOP_CONFIRMED', 'RECONCILE', 'RETURN']],
  ['closed', ['STOP', 'STOP_CONFIRMED', 'RECONCILE', 'RETURN', 'RETURN_CONFIRMED']],
] as const

test.each(stages)('F2 never-started background wording at %s; first result and receipt retained', async (_stage, events) => {
  const user = userEvent.setup()
  const state = run(active(), ...events)
  expect(state.orders).toHaveLength(1)
  expect(state.orders[0]).toMatchObject({ id: records.id, payment: 'paid', delivery: 'received' })
  const original = structuredClone(state)
  render(<Results state={state} dispatch={() => {}} />)
  const confirmed = ['stopped', 'returnPending', 'closed'].includes(state.phase)
  expect(screen.getByText(confirmed ? approved : pending, { exact: true })).toBeVisible()
  expect(screen.queryByText(confirmed ? pending : approved, { exact: true })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /^(?:Open company records evidence|Open evidence — company records)$/ }))
  expect(within(screen.getByRole('dialog')).getByText('Linked purchase: DEMO-RECORDS-01 · 8 TEST.')).toBeVisible()
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: /^(?:Open company records receipt|Open receipt — company records)$/ }))
  const receipt = screen.getByRole('dialog', { name: 'Company records receipt' })
  expect(within(receipt).getByText('DEMO-RECORDS-01', { exact: true })).toBeVisible()
  expect(within(receipt).getByText('Received', { exact: true })).toBeVisible() // F3 stays applied.
  expect(within(receipt).getByText('8 TEST', { exact: true })).toBeVisible()
  expect(state).toEqual(original)
  expect(ledger(state)).toEqual({ spent: 800, reserved: 0, available: state.phase === 'closed' ? 0 : 2200, recovered: state.phase === 'closed' ? 2200 : 0 })
})

test.each([
  [[], 'Payment pending · Funds reserved'],
  [[{ type: 'UNCERTAIN', id: background.id }], 'Payment uncertain · Funds reserved'],
  [[{ type: 'PAID', id: background.id }], 'Paid · Delivery missing'],
  [[{ type: 'PAID', id: background.id }, { type: 'RECOVER_DELIVERY', id: background.id }], 'Paid · Delivery recovery requested'],
  [[{ type: 'PAID', id: background.id }, { type: 'DELIVER', id: background.id }], 'Paid · Evidence received'],
  [[{ type: 'FAILURE_CONFIRMED', id: background.id }], 'Payment failed · No evidence purchased'],
] satisfies [Event[], string][])('F2 existing background order retains truthful status %#', (events, status) => {
  const state = run(active(), background, ...events, 'STOP', 'STOP_CONFIRMED', 'RECONCILE')
  expect(state.orders).toHaveLength(2)
  const original = structuredClone(state)
  render(<Results state={state} dispatch={() => {}} />)
  const order = screen.getByRole('article', { name: 'Background research' })
  expect(within(order).getByText(`${status} · 15 TEST`, { exact: true })).toBeVisible()
  expect(screen.queryByText(approved, { exact: true })).not.toBeInTheDocument()
  expect(screen.queryByText(/Not started/)).not.toBeInTheDocument()
  expect(state).toEqual(original)
})

test('F2 paid missing background remains recoverable even after permission closes', async () => {
  const state = run(active(), background, { type: 'PAID', id: background.id }, 'STOP', 'STOP_CONFIRMED', 'RECONCILE', 'RETURN', 'RETURN_CONFIRMED')
  expect(state.phase).toBe('closed')
  const events: Event[] = []
  render(<Results state={state} dispatch={e => events.push(e)} />)
  const order = screen.getByRole('article', { name: 'Background research' })
  expect(within(order).getByText('Paid · Delivery missing · 15 TEST')).toBeVisible()
  expect(screen.queryByText(approved, { exact: true })).not.toBeInTheDocument()
  await userEvent.setup().click(within(order).getByRole('button', { name: 'Recover background research delivery' }))
  expect(events).toEqual([{ type: 'RECOVER_DELIVERY', id: background.id }])
  const recovered = transition(state, events[0])
  expect(recovered.orders).toHaveLength(2)
  expect(recovered.orders[1]).toMatchObject({ id: background.id, payment: 'paid', delivery: 'requested' })
  expect(ledger(recovered)).toEqual({ spent: 2300, reserved: 0, available: 0, recovered: 700 })
})

test('F2 never-authorized background does not become a stopped task', () => {
  const state = run(createState(), { type: 'EXTERNAL' }, { type: 'EDIT', draft: { ...transition(createState(), { type: 'EXTERNAL' }).draft, background: false } }, 'REVIEW', 'AUTHORIZE', 'FUNDING_CONFIRMED', 'STOP', 'STOP_CONFIRMED')
  render(<Results state={state} dispatch={() => {}} />)
  expect(screen.getByText('Background research · Not authorized', { exact: true })).toBeVisible()
  expect(screen.queryByText(approved, { exact: true })).not.toBeInTheDocument()
})
