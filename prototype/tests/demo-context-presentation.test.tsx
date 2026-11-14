import '@testing-library/jest-dom/vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import SimulationApp from '../src/demo/simulation-app'
import { ContextTrigger } from '../src/components/reference-context'
import { initialReference } from '../src/data/initial-reference'
import * as controller from '../src/integration/controller'
import { ledger, type Event } from '../src/demo/model'

afterEach(() => vi.restoreAllMocks())

test('purchased demo context describes an example, preserves purchase identity, state, search and focus without network', async () => {
  let current!: controller.SimulationController
  const original = controller.useSimulationController
  vi.spyOn(controller, 'useSimulationController').mockImplementation(() => { current = original(); return current })
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Demo must not fetch') })
  const fixture = structuredClone(initialReference)
  const user = userEvent.setup()
  render(<SimulationApp />)
  const events: Event[] = [{ type: 'EXTERNAL' }, { type: 'AUTHORIZE' }, { type: 'FUNDING_CONFIRMED' }, { type: 'REQUEST', id: 'DEMO-RECORDS-01', recipient: 'records', amount: 800, content: 'Company records' }, { type: 'PAID', id: 'DEMO-RECORDS-01' }, { type: 'DELIVER', id: 'DEMO-RECORDS-01' }]
  act(() => { for (const event of events) current.dispatch(event) })
  expect(current.state.orders[0]).toMatchObject({ id: 'DEMO-RECORDS-01', payment: 'paid', delivery: 'received', amount: 800 })
  const before = current.state
  const balance = ledger(before)
  const opener = screen.getByRole('button', { name: 'View context' })
  await user.click(opener)
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText('Example of the latest reply in this thread. This email does not show whether any purchase or delivery has completed.')).toBeInTheDocument()
  expect(dialog.queryByText(/No purchases or results exist in this foundation/)).not.toBeInTheDocument()
  await user.type(dialog.getByLabelText('Find a message'), 'Re: Re:')
  expect(dialog.getAllByRole('heading', { level: 3 })).toHaveLength(1)
  await user.keyboard('{Escape}')
  expect(opener).toHaveFocus()
  expect(current.state).toBe(before)
  expect(ledger(current.state)).toEqual(balance)
  expect(initialReference).toEqual(fixture)
  expect(network).not.toHaveBeenCalled()
})

test('default shared context retains the exact foundation fixture and description', async () => {
  const user = userEvent.setup()
  render(<ContextTrigger>Default context</ContextTrigger>)
  await user.click(screen.getByRole('button', { name: 'Default context' }))
  const dialog = within(screen.getByRole('dialog'))
  for (const message of initialReference.messages) expect(dialog.getByText(message.body)).toBeInTheDocument()
  expect(dialog.getByText('Linked to the original request and this job draft. Context is not spending permission.')).toBeInTheDocument()
  expect(dialog.queryByText(/^Example of the latest reply/)).not.toBeInTheDocument()
})
