import { useReducer, type Dispatch } from 'react'
import { createState, transition, type Event, type State } from '../demo/model'

export type SimulationController = {
  mode: 'simulation'
  state: State
  dispatch: Dispatch<Event>
}

// One reducer owner for the conversation, desktop panel and mobile Sheet.
// Presenter events remain local; this boundary has no transport or wallet.
export function useSimulationController(): SimulationController {
  const [state, dispatch] = useReducer(transition, undefined, createState)
  return { mode: 'simulation', state, dispatch }
}
