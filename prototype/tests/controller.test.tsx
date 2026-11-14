import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { useSimulationController } from '../src/integration/controller'
import { createState, transition, type Event } from '../src/demo/model'

test('simulation controller retains the incumbent reducer and ordered event semantics under StrictMode', () => {
  const { result, rerender } = renderHook(() => useSimulationController(), { wrapper: StrictMode })
  expect(result.current.mode).toBe('simulation')
  expect(result.current.state).toEqual(createState())
  const events: Event[] = [
    { type: 'SEND', text: 'budget 24.35' }, { type: 'REVIEW' }, { type: 'AUTHORIZE' },
    { type: 'FUNDING_CONFIRMED' },
    { type: 'REQUEST', id: 'LOCAL-RECORDS', amount: 800, recipient: 'records' },
    { type: 'UNCERTAIN', id: 'LOCAL-RECORDS' }, { type: 'CHECK', id: 'LOCAL-RECORDS' },
  ]
  act(() => events.forEach(result.current.dispatch))
  const expected = events.reduce(transition, createState())
  expect(result.current.state).toEqual(expected)
  const dispatch = result.current.dispatch
  rerender()
  expect(result.current.state).toEqual(expected)
  expect(result.current.dispatch).toBe(dispatch)
  act(() => result.current.dispatch({ type: 'RESET' }))
  expect(result.current.state).toEqual(createState())
})
