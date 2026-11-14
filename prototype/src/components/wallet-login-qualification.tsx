import { useEffect, useState, useSyncExternalStore } from 'react'
import { createWalletAuth } from '@/integration/wallet-auth'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import haldirLogo from '../assets/haldir/logo-horizontal.png'

type Client = ReturnType<typeof createWalletAuth>
const errors: Record<string, string> = {
  METEOR_BROWSER_BUNDLE_REQUIRED: 'Wallet login is disabled in unconfigured local qualification. The installed SDK is enabled only for an explicitly approved hosted build. No wallet prompt was opened.',
  APPROVED_HTTPS_ORIGIN_REQUIRED: 'Login requires the approved exact HTTPS origin configured in this build. Ask the preview operator to configure it; browser parameters cannot enable login. No wallet prompt was opened.',
  LOCAL_HTTPS_REQUIRED: 'Local HTTPS is required. The unchanged authentication server does not accept an HTTP origin. No wallet prompt was opened.',
  CONNECT_TESTNET_ACCOUNT_FIRST: 'Click Connect testnet account to associate an account with this site, then click Log in separately. Nothing connects or switches network automatically.',
  INVALID_ASSOCIATED_ACCOUNT: 'The wallet did not return a valid NEAR testnet account. No login signature was requested. Click Connect testnet account to choose again.',
  WALLET_ACCOUNT_CHANGED: 'The connected account changed. Nothing was verified. Choose the intended testnet account and click Log in again.',
  LOGIN_CANCELLED: 'Wallet request cancelled. No login was completed. Connect or log in again only when ready.',
  UNAUTHENTICATED: 'The session or proof was not accepted. Click Log in to start a new login challenge.',
  LOGIN_HTTP_FAILED: 'The login server could not complete the request. No authenticated state is shown; check the authentication server, then retry.',
}

// An injected client is a component-test seam, not a URL/window configuration.
// Public contract: VITE_HALDIR_APPROVED_ORIGIN is a nonsecret exact HTTPS origin
// baked into the static Vite artifact. It must match server HALDIR_APPROVED_ORIGIN.
// No runtime endpoint, query/window override, Host echo or inferred provider URL.
export function WalletLoginQualification({ client: supplied }: { client?: Client }) {
  const [approvedOrigin] = useState(() => import.meta.env.VITE_HALDIR_APPROVED_ORIGIN as string | undefined)
  const hosted = approvedOrigin !== undefined
  const [client] = useState(() => supplied ?? createWalletAuth({ origin: window.location.origin, recipient: window.location.hostname, secureContext: window.isSecureContext, approvedOrigin }))
  const { principal, busy, error, connectedAccount } = useSyncExternalStore(client.subscribe, client.getSnapshot)
  useEffect(() => { void client.resume() }, [client])
  return <div className="preview-page text-sm">
    <section aria-label="Preview notice"><p className="preview-notice text-muted-foreground">{hosted ? 'Hosted testnet login preview' : 'LOCAL wallet-login qualification'} · Authentication only · No active mandate or financial connection</p></section>
    <div className="workspace-shell rounded-xl border bg-background">
      <header className="workspace-header border-b"><img className="wordmark" src={haldirLogo} alt="Haldir" width={663} height={204} /><Separator orientation="vertical" className="header-separator" /><h1>Owner login</h1><Badge variant="outline" className="preview-badge">{hosted ? 'TESTNET' : 'LOCAL'}</Badge></header>
      <main className="workspace-body panel-hidden">
        <section aria-label="Owner login" className="conversation"><div className="conversation-stream" role="region" tabIndex={0} aria-label="Login status"><div className="conversation-content journey space-y-5">
          <h2 className="text-base font-medium">Log in, not authorize spending</h2>
          <p>Login does not authorize a mandate, fund a job or grant permission to create, pay, stop or withdraw.</p>
          <p>First, Connect testnet account lets you choose an existing NEAR testnet account for this site. It requests no contract permissions or financial approval. Then click Log in separately to request one off-chain login signature. Nothing opens automatically; this screen does not switch networks.</p>
          <div className="action-row"><Button variant="outline" disabled={busy} onClick={() => void client.connect()}>Connect testnet account</Button><Button variant="outline" disabled={busy} onClick={() => void client.login()}>Log in with connected testnet wallet</Button><Button variant="outline" disabled={busy} onClick={() => void client.logout()}>Log out of session</Button></div>
          {connectedAccount && <p>Connected {connectedAccount.accountId} · testnet. Connection is not login; click Log in only when ready to sign.</p>}
          <p role="status" aria-live="polite">{busy ? 'Checking login…' : error ? errors[error] ?? 'Login could not be validated. No authenticated state is shown; retry explicitly.' : principal ? `Logged in as ${principal.accountId} · testnet · Authentication only` : 'Not logged in. No mandate is active.'}</p>
          {principal && <p>Session restored or verified by the authentication server. Wallet connection and spending authorization remain separate.</p>}
          <p className="text-muted-foreground">{hosted ? 'This build permits login only at its configured HTTPS origin. Hosting, secure-cookie persistence and real wallet acceptance require separate qualification.' : 'Local qualification requires a same-origin, browser-trusted HTTPS listener and the existing authentication boundary. Public activation and real wallet acceptance are not qualified here.'}</p>
          {!hosted && <a href="/">Return to separate scripted simulation</a>}
        </div></div></section>
      </main>
    </div>
  </div>
}
