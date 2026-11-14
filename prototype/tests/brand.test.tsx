import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import App from '../src/demo/simulation-app'

// Approved no-avatar continuation: header identity retained; conversation uses Haldir text.
test('text-only UI v1 header keeps the original agent artwork, entry and disabled composer', () => {
  render(<App />)
  expect(document.querySelector('.workspace-header .haldir-wordmark')).toHaveTextContent('Haldir')
  expect(document.querySelector('.conversation .agent-avatar')).toBeNull()
  expect(document.querySelector('.assistant-message .agent-name')).toHaveTextContent('Haldir')
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New task')
  expect(screen.queryByRole('button', { name: 'Shape this job' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'View context' })).toHaveAttribute('data-variant', 'brand-dark')
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
})
