import type { State } from './model'
export const money = (n: number) => `${Math.trunc(n / 100)}${n % 100 ? `.${String(n % 100).padStart(2, '0')}` : ''} TEST`
export const labels: Record<State['phase'], string> = { entry: 'New task', draft: 'Job draft', review: 'Ready for your review', funding: 'Funding pending', active: 'Work in progress', stopRequested: 'Stop requested', stopped: 'Stop confirmed', returnPending: 'Return pending', closed: 'Spending permission closed' }
