import { test, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SimulationApp from '../src/demo/simulation-app'

test('failed prior payment is not reclassified as a purchase that never started', async () => {
  render(<SimulationApp />)
  const user = userEvent.setup()
  await user.click(screen.getByText('Demo controls', { exact:true }))
  for (const name of ['Open external proposal','Authorize mandate','Confirm funding','Start company records payment','Confirm failed company records payment']) await user.click(screen.getByRole('button',{name}))
  const work=screen.getByRole('region',{name:'Agent work'})
  expect(work).toHaveTextContent('Company records payment failed · No purchase completed')
  expect(work).not.toHaveTextContent('No purchase started yet')
  expect(screen.getByTestId('ledger')).toHaveTextContent('Reserved0 TEST')
})

async function deliverFirst() {
  const user = userEvent.setup()
  await user.click(screen.getByText('Demo controls', { exact: true }))
  for (const name of ['Open external proposal','Authorize mandate','Confirm funding','S03 · Deliver company records']) await user.click(screen.getByRole('button', { name }))
  return user
}

test('conversation uses Haldir text alone for initial, scripted and delivered responses without removing header identity', async () => {
  const { container } = render(<SimulationApp />)
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Your message'), 'Check supplier')
  await user.click(screen.getByRole('button', { name:'Send message' }))
  for (const reply of container.querySelectorAll('.assistant-message')) {
    expect(reply.querySelector('.agent-name')).toHaveTextContent('Haldir')
    expect(reply.querySelector('img,.agent-avatar')).toBeNull()
  }
  await user.click(screen.getByText('Demo controls', { exact:true }))
  await user.click(screen.getByRole('button', { name:'Reset demo' }))
  await user.click(screen.getByRole('button', { name:'Open external proposal' }))
  for (const name of ['Authorize mandate','Confirm funding','S03 · Deliver company records']) await user.click(screen.getByRole('button', { name }))
  expect(container.querySelector('.result-notification .agent-name')).toHaveTextContent('Haldir')
  expect(container.querySelector('.workspace-header .haldir-wordmark')).not.toBeNull()
  expect(container.querySelector('.conversation .agent-avatar')).toBeNull()
})

test('preparation is compact and describes only the actual local draft, not fabricated research checks', async () => {
  render(<SimulationApp />)
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Your message'),'Check the supplier. I need a short brief with the evidence.')
  await user.click(screen.getByRole('button',{ name:'Send message' }))
  const work = screen.getByRole('region',{ name:'Agent work' })
  expect(within(work).getByText('Haldir')).toBeVisible()
  expect(within(work).getByRole('heading',{ name:'Preparing your proposal' })).toBeVisible()
  expect(work).toHaveTextContent('Request saved in this local draft')
  expect(work).toHaveTextContent('Budget and expiry need your review')
  expect(work).toHaveTextContent('No spending before your review and authorization.')
  expect(work).not.toHaveTextContent(/Read the selected email|Checked.*authorized terms|evidence received/i)
  await user.type(screen.getByLabelText('Your message'),'budget 30; expiry 2026-11-12T18:00')
  await user.click(screen.getByRole('button',{ name:'Send message' }))
  expect(work).toHaveTextContent('Draft ready for your review')
  expect(screen.getByRole('button',{ name:'Authorize mandate' })).toBeEnabled()
})

test('work block evolves only from received and pending simulation observations and keeps result readers separate', async () => {
  render(<SimulationApp />)
  const user = await deliverFirst()
  const work = screen.getByRole('region',{ name:'Agent work' })
  expect(work).toHaveTextContent('Company records evidence received')
  expect(work).toHaveTextContent('Background research not started')
  expect(work).not.toHaveTextContent(/Background research evidence received|report complete|verification complete/i)
  expect(within(screen.getByRole('region',{name:'Conversation'})).getByRole('button',{name:'Open company records evidence'})).toBeEnabled()
  await user.click(screen.getByRole('button',{name:'S05 · Two requests together'}))
  await user.click(within(screen.getByRole('region',{name:'Conversation'})).getByRole('button',{name:'Continue without this purchase'}))
  const resumed = screen.getByRole('region',{name:'Agent work'})
  expect(resumed).toHaveTextContent('Background research payment pending')
  expect(resumed).not.toHaveTextContent('Background research evidence received')
  await user.click(screen.getByRole('button',{name:'S06 · Deliver background research'}))
  expect(resumed).toHaveTextContent('Background research evidence received')
  expect(resumed).toHaveTextContent('Review the available evidence · No final brief exists in this demo')
  expect(within(screen.getByRole('complementary',{name:'Working bar'})).getByRole('region',{name:'Activity'})).toBeVisible()
})

test('blocked work explains only the refused request and keeps unchanged spending, details, continuation and stop', async () => {
  render(<SimulationApp />)
  const user = await deliverFirst()
  const before = screen.getByTestId('ledger').textContent
  await user.click(screen.getByRole('button',{name:'S04 · Excluded recipient request'}))
  const work = screen.getByRole('region',{name:'Agent work'})
  expect(work).toHaveTextContent('Payment blocked · Recipient not allowed')
  expect(work).toHaveTextContent('No funds moved for this request.')
  expect(work.textContent?.match(/No funds moved for this request\./g)).toHaveLength(1)
  expect(work).toHaveTextContent('Company records evidence received')
  expect(within(work).getByRole('button',{name:'View details'})).toBeEnabled()
  expect(screen.getByTestId('ledger').textContent).toBe(before)
  const conversation = within(screen.getByRole('region',{name:'Conversation'}))
  expect(conversation.getByRole('button',{name:'Stop new spending'})).toBeEnabled()
  expect(conversation.getByRole('button',{name:'Request mandate change'})).toHaveAccessibleDescription('Requires a new authorization. Opens a separate proposal. Even after authorization, it will not change this task in the demo.')
  await user.click(conversation.getByRole('button',{name:'Continue without this purchase'}))
  expect(screen.getByRole('region',{name:'Agent work'})).not.toHaveTextContent('No funds moved for this request.')
  expect(screen.getByRole('region',{name:'Agent work'})).toHaveTextContent('Background research not started')
})
