import { render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import App from '../src/demo/simulation-app'
import userEvent from '@testing-library/user-event'

test('working bar can hide and reopen without clearing the local message draft', async () => {
  const user = userEvent.setup()
  render(<App />)
  const message = screen.getByRole('textbox', { name: 'Your message' })
  await user.type(message, 'Keep this local draft')
  await user.click(screen.getByRole('button', { name: 'Hide panel' }))
  expect(screen.queryByRole('complementary', { name: 'Working bar' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Show task panel' }))
  expect(screen.getByRole('complementary', { name: 'Working bar' })).toBeVisible()
  expect(message).toHaveValue('Keep this local draft')
  expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
})

test('reference context opens, filters and reports an empty search without changing the initial task', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: 'View context' }))
  const dialog = screen.getByRole('dialog', { name: 'Selected email thread' })
  const search = within(dialog).getByRole('textbox', { name: 'Find a message' })
  expect(within(dialog).getAllByRole('article')).toHaveLength(3)
  await user.type(search, 'Contract terms')
  expect(within(dialog).getAllByRole('article')).toHaveLength(1)
  await user.clear(search)
  await user.type(search, 'no matching subject')
  expect(within(dialog).getByRole('status')).toHaveTextContent('No messages match. Try another search.')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'View context' })).toHaveFocus()
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
})

test('initial reference keeps conversation primary and a contextual working bar, without spending authority', () => {
  render(<App />)
  expect(screen.getByRole('heading', { level: 1, name: 'New task' })).toBeVisible()
  expect(screen.getByText('What would you like to get done?')).toBeVisible()
  expect(screen.getByText('Check Northwind Print before I sign. I need a short brief with the evidence.')).toBeVisible()
  expect(screen.getByRole('region', { name: 'Conversation' })).toBeVisible()
  const panel = screen.getByRole('complementary', { name: 'Working bar' })
  expect(within(panel).getByText('Your job summary, spending limits, activity and results will appear here once the task takes shape.')).toBeVisible()
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  expect(screen.getByText(/Scripted simulation/)).toBeVisible()
  expect(document.body).not.toHaveTextContent(/RepCheck|Registry API/)
})
