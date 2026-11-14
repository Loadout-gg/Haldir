import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { Terms } from '../src/demo/workspace'
import { defaultDraft } from '../src/demo/model'
import App from '../src/demo/simulation-app'

async function draft() {
  const user = userEvent.setup(); render(<App />)
  await user.type(screen.getByLabelText('Your message'), 'Check Northwind Print before I sign. I need a short brief with the evidence.')
  await user.click(screen.getByRole('button', { name: 'Send message' }))
  return user
}

test('incomplete A02 summary presents missing terms as Not set, never an input error or orphan UTC', async () => {
  await draft()
  const summary = screen.getByRole('region', { name: 'Task summary' })
  for (const label of ['Purchase limit', 'Permission expires']) {
    const term = within(summary).getByText(label, { exact: true }).closest('div')!
    expect(term.querySelector('dd')).toHaveTextContent(/^Not set$/)
  }
  expect(summary).not.toHaveTextContent('Enter a valid budget')
  expect(within(summary).getByRole('button', { name: 'Edit details' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Review spending limits' })).toBeDisabled()
})

test('active Activity stays non-collapsible with every event after Hide and Show task panel', async () => {
  const user = userEvent.setup(); render(<App />)
  await user.click(screen.getByText('Demo controls', { exact: true }))
  for (const name of ['Open external proposal', 'Authorize mandate', 'Confirm funding', 'S03 · Deliver company records']) {
    await user.click(screen.getByRole('button', { name }))
  }
  const activity = () => screen.getByRole('region', { name: 'Activity' })
  const events = within(activity()).getAllByRole('listitem').map(e => e.textContent)
  expect(events).toHaveLength(6)
  expect(activity().querySelector('details, summary')).toBeNull()
  for (const event of within(activity()).getAllByRole('listitem')) expect(event).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Hide panel' }))
  await user.click(screen.getByRole('button', { name: 'Show task panel' }))
  expect(activity().querySelector('details, summary')).toBeNull()
  expect(within(activity()).getAllByRole('listitem').map(e => e.textContent)).toEqual(events)
  for (const event of within(activity()).getAllByRole('listitem')) expect(event).toBeVisible()
})

test('pilot missing-value copy does not replace an actual invalid budget or confirmed terms', () => {
  const view = render(<Terms draft={{ ...defaultDraft, budget: 'invalid' }} panel />)
  expect(screen.getByText('Purchase limit').closest('div')!.querySelector('dd')).toHaveTextContent('Enter a valid budget')
  view.rerender(<Terms draft={defaultDraft} panel />)
  expect(screen.getByText('Purchase limit').closest('div')!.querySelector('dd')).toHaveTextContent('30 TEST')
  expect(screen.getByText('Permission expires').closest('div')!.querySelector('dd')).toHaveTextContent('2026-11-12 · 18:00 UTC')
})
