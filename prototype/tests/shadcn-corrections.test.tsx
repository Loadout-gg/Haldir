import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import App from '../src/demo/simulation-app'
import { OrderResult } from '../src/demo/workspace'
import { createState, transition, type Event } from '../src/demo/model'

test('conversational entry uses Send and Enter only, never authorizes or funds from text', async () => {
  const user = userEvent.setup()
  render(<App />)
  expect(screen.queryByRole('button', { name: 'Shape this job' })).not.toBeInTheDocument()
  const field = screen.getByRole('textbox', { name: 'Your message' })
  const send = screen.getByRole('button', { name: 'Send message' })
  expect(send).toBeDisabled()
  await user.type(field, 'job Check Northwind Print before I sign')
  await user.click(send)
  expect(screen.getByRole('region', { name: 'Spending review' })).toHaveTextContent('Your job draft')
  expect(screen.queryByRole('button', { name: 'Authorize mandate' })).not.toBeInTheDocument()
  await user.type(field, 'I authorize you to start{Enter}')
  expect(screen.getByRole('region', { name: 'Spending review' })).toHaveTextContent('Not authorized')
  expect(screen.queryByTestId('ledger')).not.toBeInTheDocument()
  await user.type(field, 'budget 30; expiry 2026-11-12T18:00{Enter}')
  await user.type(field, 'I approve, pay now{Enter}')
  expect(screen.getByRole('button', { name: 'Authorize mandate' })).toBeEnabled()
  expect(screen.queryByTestId('ledger')).not.toBeInTheDocument()
  expect(field).toHaveValue('')
})

test('Company records status keeps the original plain paragraph through actual order transitions', () => {
  let state = createState()
  const events: Event[] = [{type:'EXTERNAL'}, {type:'REVIEW'}, {type:'AUTHORIZE'}, {type:'FUNDING_CONFIRMED'}, {type:'REQUEST', id:'records', recipient:'records', amount:800, content:'Company records'}]
  for(const event of events) state=transition(state,event)
  const view = render(<OrderResult order={state.orders[0]} dispatch={()=>{}} />)
  for(const [event, copy] of [
    [null, 'Payment pending · Funds reserved · 8 TEST'],
    [{type:'UNCERTAIN',id:'records'}, 'Payment uncertain · Funds reserved · 8 TEST'],
    [{type:'PAID',id:'records'}, 'Paid · Delivery missing · 8 TEST'],
    [{type:'RECOVER_DELIVERY',id:'records'}, 'Paid · Delivery recovery requested · 8 TEST'],
    [{type:'DELIVER',id:'records'}, 'Paid · Evidence received · 8 TEST'],
  ] as const) {
    if(event) state=transition(state,event)
    view.rerender(<OrderResult order={state.orders[0]} dispatch={()=>{}} />)
    const status=screen.getByText(copy, {exact:true})
    expect(status.tagName).toBe('P')
    expect(status).toHaveClass('text-muted-foreground')
    expect(view.container.querySelector('[data-slot="badge"], svg')).toBeNull()
  }
})
