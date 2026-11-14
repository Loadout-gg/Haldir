export type Page = 'landing' | 'app' | 'simulation' | 'local-qualification' | 'wallet-auth-qualification' | 'not-found'

export function resolvePage(pathname: string, search: string): Page {
  const modes = new URLSearchParams(search).getAll('mode')
  if (modes.length > 1) return 'not-found'
  if (pathname !== '/') {
    if (modes.length !== 0) return 'not-found'
    if (pathname === '/app') return 'app'
    if (pathname === '/demo') return 'simulation'
    return 'not-found'
  }
  if (modes.length === 0) return 'landing'
  switch (modes[0]) {
    case 'public-testnet': return 'app'
    case 'simulation':
    case 'testnet': return 'simulation'
    case 'local-qualification': return 'local-qualification'
    case 'wallet-auth-qualification': return 'wallet-auth-qualification'
    default: return 'not-found'
  }
}
