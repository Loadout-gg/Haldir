import { afterEach, expect, test, vi } from 'vitest'
import { createTestnetController } from '../src/integration/testnet'

afterEach(() => vi.unstubAllGlobals())

test('isolated testnet boundary reports unavailable owner approval, never simulated readiness', () => {
  const controller = createTestnetController()
  expect(controller.mode).toBe('testnet')
  expect(controller.state).toEqual({
    mode: 'testnet', readiness: 'not-configured', ownerApproval: 'unavailable',
    unresolvedOperations: [],
  })
})

test.each(['create', 'stop', 'withdraw'] as const)('%s owner approval fails closed without configuration or network', action => {
  const forbidden = vi.fn(() => { throw new Error('No network or wallet allowed') })
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'near', 'wallet']) vi.stubGlobal(name, forbidden)
  const controller = createTestnetController()
  const state = controller.state
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(controller.dispatch({ type: 'REQUEST_OWNER_APPROVAL', action })).toEqual({
      status: 'blocked', reason: 'TESTNET_NOT_CONFIGURED',
    })
    expect(controller.state).toBe(state)
    expect(controller.state.ownerApproval).toBe('unavailable')
  }
  expect(controller.dispatch({ type: 'CHECK_STATUS' })).toEqual({ status: 'blocked', reason: 'TESTNET_NOT_CONFIGURED' })
  expect(forbidden).not.toHaveBeenCalled()
})

const unresolvedCases = (['create', 'pay', 'stop', 'withdraw'] as const).flatMap(kind =>
  (['pending', 'unknown'] as const).map(status => ({ kind, status, jobId: 'fixture-job', operationId: `fixture-${kind}`, transactionHash: null })))

test.each(unresolvedCases)('retains $kind $status without a hash when approval/status are unavailable', operation => {
  const input = [{ ...operation }]
  const controller = createTestnetController(input)
  const before = structuredClone(controller.state)
  expect(controller.state.unresolvedOperations).toEqual([operation])
  controller.dispatch({ type: 'CHECK_STATUS' })
  for (const action of ['create', 'stop', 'withdraw'] as const) controller.dispatch({ type: 'REQUEST_OWNER_APPROVAL', action })
  expect(controller.state).toEqual(before)
  // An upstream array/object must not mutate the controller's retained identity.
  input[0].operationId = 'changed-input'
  input.length = 0
  expect(controller.state.unresolvedOperations).toEqual([operation])
  expect(Object.isFrozen(controller.state)).toBe(true)
  expect(Object.isFrozen(controller.state.unresolvedOperations)).toBe(true)
  expect(Object.isFrozen(controller.state.unresolvedOperations[0])).toBe(true)
})

test('testnet does not consume presenter confirmations/reset or owner-wallet pay commands (negative characterization)', () => {
  const controller = createTestnetController()
  const state = controller.state
  for (const type of ['AUTHORIZE', 'FUNDING_CONFIRMED', 'PAID', 'STOP_CONFIRMED', 'RETURN_CONFIRMED', 'RESET', 'SEND']) {
    // @ts-expect-error Simulation events are not testnet commands.
    expect(controller.dispatch({ type })).toEqual({ status: 'blocked', reason: 'UNSUPPORTED_COMMAND' })
    expect(controller.state).toBe(state)
  }
  // @ts-expect-error pay belongs to the backend runner, never the owner wallet.
  expect(controller.dispatch({ type: 'REQUEST_OWNER_APPROVAL', action: 'pay' })).toEqual({ status: 'blocked', reason: 'UNSUPPORTED_COMMAND' })
})
