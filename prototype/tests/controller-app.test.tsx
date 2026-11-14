import { StrictMode } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import * as controllers from '../src/integration/controller'
import type { Event } from '../src/demo/model'
import App from '../src/demo/simulation-app'

afterEach(() => vi.restoreAllMocks())

test('preview discloses simulation mode and unconfigured testnet without offering wallet actions', () => {
  render(<App />)
  const notice = screen.getByRole('region', { name: 'Preview notice' })
  expect(notice).toHaveTextContent('Scripted simulation. No live AI calls, real email or real funds. Testnet is not configured.')
  expect(screen.queryByRole('button', { name: /connect wallet|approve testnet|switch.*testnet/i })).not.toBeInTheDocument()
})

test('App sends composer and action events through the same simulation controller', async () => {
  const events: Event[] = []
  const useController = controllers.useSimulationController
  vi.spyOn(controllers, 'useSimulationController').mockImplementation(() => {
    const controller = useController()
    return { ...controller, dispatch: event => { events.push(event); controller.dispatch(event) } }
  })
  const user = userEvent.setup()
  render(<StrictMode><App /></StrictMode>)
  expect(screen.queryByRole('button', { name: 'Shape this job' })).not.toBeInTheDocument()
  const composer = screen.getByRole('textbox', { name: 'Your message' })
  await user.type(composer, 'budget 24.35')
  await user.click(screen.getByRole('button', { name: 'Send message' }))
  await user.type(composer, 'output A shared result{Enter}')
  expect(events).toEqual([
    { type: 'SEND', text: 'budget 24.35' },
    { type: 'SEND', text: 'output A shared result' },
  ])
  // UX restoration: draft terms live in the panel, not a duplicated central form.
  const panel = screen.getByRole('complementary', { name: 'Working bar' })
  expect(panel).toHaveTextContent('24.35 TEST')
  expect(panel).toHaveTextContent('A shared result')
  expect(screen.getByRole('log', { name: 'Conversation history' })).toHaveTextContent('budget 24.35')
  expect(screen.getByRole('log', { name: 'Conversation history' })).toHaveTextContent('output A shared result')
  expect(screen.getByRole('region', { name: 'Spending review' })).toHaveTextContent('Not authorized')
  expect(composer).toHaveValue('')
  await user.click(screen.getByText('Demo controls', { exact: true }))
  await user.click(screen.getByRole('button', { name: 'Reset demo' }))
  expect(events.at(-1)).toEqual({ type: 'RESET' })
  expect(within(screen.getByRole('region', { name: 'Conversation' })).queryByRole('button', { name: 'Shape this job' })).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New task')
})
