import { render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import userEvent from '@testing-library/user-event'
import { createState, ledger, transition } from '../src/demo/model'
import { OrderResult } from '../src/demo/workspace'

// Receipt wording changes presentation only; the same paid order remains recoverable.
test.each([
  ['missing', 'Awaiting data'],
  ['requested', 'Retrieval requested'],
  ['received', 'Received'],
] as const)('F3 receipt presents %s as %s without changing payment or order identity', async (delivery, label) => {
  const user = userEvent.setup()
  render(<OrderResult order={{ id: 'DEMO-RECORDS-01', content: 'Company records', recipient: 'records', amount: 800, payment: 'paid', delivery }} dispatch={() => {}} />)
  await user.click(screen.getByRole('button', { name: /^(?:Open company records receipt|Open receipt — company records)$/ }))
  const receipt = screen.getByRole('dialog', { name: 'Company records receipt' })
  const row = within(receipt).getByText('Delivery', { exact: true }).parentElement!
  expect(row.querySelector('dd')).toHaveTextContent(new RegExp(`^${label}$`))
  expect(within(receipt).getByText('DEMO-RECORDS-01', { exact: true })).toBeVisible()
  expect(within(receipt).getByText('8 TEST', { exact: true })).toBeVisible()
  expect(within(receipt).getByText('Confirmed in simulation', { exact: true })).toBeVisible()
  expect(within(receipt).queryByText(delivery, { exact: true })).not.toBeInTheDocument()
})

test('F1 uncertain return explains passive waiting without changing funds or confirming recovery', () => {
  let state = transition(createState(), { type: 'EXTERNAL' })
  for (const type of ['REVIEW', 'AUTHORIZE', 'FUNDING_CONFIRMED', 'STOP', 'STOP_CONFIRMED', 'RECONCILE', 'RETURN']) {
    state = transition(state, { type })
  }
  expect(state.phase).toBe('returnPending')
  const uncertain = transition(state, { type: 'RETURN_UNCERTAIN' })
  expect(uncertain.note).toBe("We're still waiting for confirmation that your remaining funds have been returned. You don't need to send another request.")
  expect({ ...uncertain, note: state.note, activity: state.activity }).toEqual(state)
  expect(uncertain.activity.at(-1)?.type).toBe('RETURN_UNCERTAIN')
  expect(ledger(uncertain)).toEqual(ledger(state))
  expect(uncertain.recovered).toBe(0)
  expect(transition(createState(), { type: 'RETURN_UNCERTAIN' })).toEqual(createState())
})
