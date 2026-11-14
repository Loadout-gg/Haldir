import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import SimulationApp from '../src/demo/simulation-app'

test('06 keeps the concise mandate-change action and its separate authorization requirement', async () => {
  const user = userEvent.setup(); render(<SimulationApp />)
  await user.click(screen.getByText('Demo controls', { exact: true }))
  for (const name of ['Open external proposal','Authorize mandate','Confirm funding','S03 · Deliver company records','S04 · Excluded recipient request']) await user.click(screen.getByRole('button',{ name }))
  const conversation = screen.getByRole('region',{name:'Conversation'})
  const change = within(conversation).getByRole('button',{name:'Request mandate change'})
  expect(change).toHaveAccessibleDescription('Requires a new authorization. Opens a separate proposal. Even after authorization, it will not change this task in the demo.')
  expect(within(conversation).getByText('Requires a new authorization. Opens a separate proposal. Even after authorization, it will not change this task in the demo.',{exact:true})).toBeVisible()
  expect(within(conversation).getByRole('button',{name:'Continue without this purchase'})).toBeEnabled()
  expect(within(conversation).getByRole('button',{name:'Stop new spending'})).toBeEnabled()
  await user.click(change)
  expect(screen.getByRole('heading',{name:'Separate mandate change proposal'})).toBeVisible()
  expect(screen.getByText('Current mandate and all existing accounting remain unchanged. No recipient is imported from untrusted email. Only the two trusted demo records can be proposed.')).toBeVisible()
})

test('05 panel names evidence and receipt destinations without losing source identity', async () => {
  const user = userEvent.setup(); render(<SimulationApp />)
  await user.click(screen.getByText('Demo controls', { exact: true }))
  for (const name of ['Open external proposal','Authorize mandate','Confirm funding','S03 · Deliver company records']) await user.click(screen.getByRole('button',{ name }))
  const results = within(screen.getByRole('complementary',{name:'Working bar'})).getByRole('region',{name:'Results and receipts'})
  expect(within(results).getByRole('button',{name:/^(?:Open company records evidence|Open evidence — company records)$/})).toHaveTextContent(/^Open evidence$/)
  expect(within(results).getByRole('button',{name:/^(?:Open company records receipt|Open receipt — company records)$/})).toHaveTextContent(/^Open receipt$/)
  expect(within(results).getByRole('article',{name:'Background research result'})).toHaveTextContent('Receipt — None yet')
})
