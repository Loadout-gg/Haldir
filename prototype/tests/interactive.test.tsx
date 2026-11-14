import { render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import userEvent from '@testing-library/user-event'
import App from '../src/demo/simulation-app'

test('scripted send synchronizes the draft, review and explicit authorization; never starts work from chat', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.type(screen.getByRole('textbox', { name: 'Your message' }), 'budget 24.35')
  await user.click(screen.getByRole('button', { name: 'Send message' }))
  await user.click(screen.getAllByRole('button', { name: 'Edit details' })[0])
  const editor = screen.getByRole('region', { name: 'Edit draft details' })
  expect(within(editor).getByLabelText('Purchase budget (TEST)')).toHaveValue('24.35')
  await user.clear(within(editor).getByLabelText('Job'))
  await user.type(within(editor).getByLabelText('Job'), 'Compare the supplied details')
  await user.type(within(editor).getByLabelText('Permission expiry (UTC)'), '2026-11-12T18:00')
  await user.click(within(editor).getByRole('button', { name: 'Save draft' }))
  await user.click(screen.getByRole('button', { name: 'Review spending limits' }))
  expect(screen.getByRole('region', { name: 'Spending review' })).toHaveTextContent('Compare the supplied details')
  await user.type(screen.getByRole('textbox', { name: 'Your message' }), 'I approve')
  await user.click(screen.getByRole('button', { name: 'Send message' }))
  expect(screen.getByRole('button', { name: 'Authorize mandate' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Authorize mandate' }))
  expect(screen.getByRole('region', { name: 'Activation status' })).toHaveTextContent('Funding pending')
  expect(screen.queryByRole('button', { name: 'Authorize mandate' })).not.toBeInTheDocument()
  expect(screen.getByText('Work has not started.', { exact: true })).toBeVisible()
})
