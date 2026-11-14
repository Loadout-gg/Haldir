/* Explicit document routes; qualification entries remain separate. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createLocalJourney } from '@/integration/local-journey'
import { createPublicTestnetController, ownerCreationState, creationCostIdentity, type PublicJourneyView } from '@/integration/testnet'
import { createWalletAuth } from '@/integration/wallet-auth'
import { resolveOwnerManifest } from '@/integration/owner-approval'
import { Input } from '@/components/ui/input'
import { WalletLoginQualification } from '@/components/wallet-login-qualification'
import { PanelRightOpen } from 'lucide-react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button as BrandButton } from '@/components/ui/button'
import { Button, Button as PublicButton } from '@/components/ui/base-nova/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import SimulationApp from '@/demo/simulation-app'
import { resolvePage } from '@/routing'
import LandingPage from '@/landing/landing-page'
import { HaldirWordmark } from '@/components/haldir-identity'
import { readPublicDraft, draftFromPreview, type PublicDraft } from '@/integration/public-draft'
import { PublicAgentWork } from '@/integration/public-agent-work'
import { PublicDraftPanel, PublicComposer, PublicPreview, PublicSourceResults, PublicReport, PublicCreationCosts, PublicTaskContext, PublicActivation } from '@/integration/public-workspace'
import './App.css'
import '@/integration/public-ui-latest.css'
import './brand-light.css'

// Explicit document routes; operational permissions stay in the existing workspace.
export default function App() {
  const page = resolvePage(window.location.pathname, window.location.search)
  const title = {
    landing: 'Haldir · Product prototype', app: 'Haldir · Testnet workspace',
    simulation: 'Haldir · Scripted simulation',
    'wallet-auth-qualification': 'Haldir · Wallet authentication qualification',
    'local-qualification': 'Haldir · Local qualification', 'not-found': 'Haldir · Page not found',
  }[page]
  useEffect(() => { document.title = title }, [title])
  if (page === 'landing') return <LandingPage />
  if (page === 'app') return <PublicTestnetWorkspace />
  if (page === 'simulation') return <SimulationApp />
  if (page === 'wallet-auth-qualification') return <WalletLoginQualification />
  if (page === 'local-qualification') return <LocalQualification />
  return <main><h1>Page not found</h1><a href="/">Haldir home</a></main>
}

function LocalQualification() {
  const Button = BrandButton
  const [controller] = useState(() => createLocalJourney({ origin: window.location.origin, storage: window.localStorage }))
  const { job, order, busy, error } = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => { void controller.resume() }, [controller])
  const context = <div className="panel-details space-y-5"><p>Local qualification only. Approval terms and receipts come from the server-side harness, never from presenter controls.</p><p>No email or wallet connected. The backend's testnet schema tag is fixture compatibility, not a live network.</p><a href="/demo">Return to scripted simulation</a></div>
  return <div className="preview-page text-sm">
    <section aria-label="Preview notice"><p className="preview-notice text-muted-foreground">LOCAL backend qualification · Synthetic identity, synthetic receipts and fictional sample data · No wallet, signing or live testnet connection</p></section>
    <div className="workspace-shell rounded-xl border bg-background">
      <header className="workspace-header border-b"><HaldirWordmark /><Separator orientation="vertical" className="header-separator" /><h1>Local job</h1><Sheet><SheetTrigger render={<Button variant="outline" className="mobile-panel-button" />}><PanelRightOpen aria-hidden="true" />Task panel</SheetTrigger><SheetContent><SheetHeader><SheetTitle>Task panel</SheetTitle><SheetDescription>Local qualification boundary and context.</SheetDescription></SheetHeader>{context}</SheetContent></Sheet><Badge variant="outline" className="preview-badge">LOCAL</Badge></header>
      <main className="workspace-body">
        <section aria-label="Conversation" className="conversation"><div className="conversation-stream" role="region" tabIndex={0} aria-label="Local backend evidence"><div className="conversation-content journey space-y-5">
          <h2 className="text-base font-medium">Results and receipts · Local qualification</h2>
          <p>A server-owned synthetic approval opens one persistent job. This does not authorize or make a payment.</p>
          <div className="action-row"><Button variant="brand-preparatory" disabled={busy} onClick={() => void controller.open()}>{job ? 'Refresh local status' : 'Open approved local job'}</Button>{job && <><Button variant="outline" disabled={busy} onClick={() => void controller.check()}>Check local receipt</Button><Button variant="outline" disabled={busy || !order?.proof} onClick={() => void controller.delivery()}>Retrieve same local delivery</Button></>}</div>
          <p role="status" aria-live="polite">{busy ? 'Reading LOCAL backend…' : error ? `Local request failed: ${error}. Last observed evidence is retained; retry with the same job.` : order?.lifecycle === 'PAYMENT_PENDING' ? 'Payment pending or unknown. No verified synthetic receipt; no delivery unlocked.' : order?.lifecycle === 'PAID_NOT_DELIVERED' ? 'Synthetic receipt verified locally · Delivery missing. Retrieve without another payment.' : order?.lifecycle === 'DELIVERED' ? 'Fictional sample retained · Not a verified company finding.' : 'No backend job opened yet.'}</p>
          {job && <Card><CardHeader><CardTitle><h3>Backend job and order</h3></CardTitle></CardHeader><CardContent className="space-y-4"><dl className="terms"><div><dt>Job ID</dt><dd data-testid="local-job-id">{job.jobId}</dd></div><div><dt>Job state</dt><dd>{job.state}</dd></div><div><dt>Job</dt><dd>{job.scope.purpose}</dd></div><div><dt>Output</dt><dd>{job.scope.output}</dd></div><div><dt>Synthetic identity</dt><dd>{job.ownerId}</dd></div>{order && <><div><dt>Order ID</dt><dd>{order.orderId}</dd></div><div><dt>Lifecycle</dt><dd data-testid="local-lifecycle">{order.lifecycle}</dd></div><div><dt>Last receipt check</dt><dd>{order.lastCheckCode ?? 'No rejection recorded'}</dd></div><div><dt>Source</dt><dd>{order.quote.vendorId}</dd></div><div><dt>Synthetic amount · Atomic units, not funds</dt><dd>{order.quote.amountAtomic}</dd></div></>}</dl></CardContent></Card>}
          {order?.proof && <article className="order-result border-t space-y-4" aria-label="Synthetic receipt"><h3 className="font-medium">Synthetic receipt · LOCAL verification only</h3><dl className="terms"><div><dt>Fixture transaction hash · Not chain evidence</dt><dd data-testid="local-transaction">{order.proof.transactionHash}</dd></div><div><dt>Fixture transfer receipt</dt><dd>{order.proof.transferReceiptId}</dd></div></dl></article>}
          {order?.artifact && <article className="order-result border-t space-y-4" aria-label="Fictional local artifact"><h3 className="font-medium">Fictional sample data</h3><p>{order.artifact.content}</p><dl className="terms"><div><dt>Stable artifact ID</dt><dd data-testid="local-artifact-id">{order.artifact.artifactId}</dd></div><div><dt>Content digest · SHA-256</dt><dd data-testid="local-artifact-digest">{order.artifact.contentDigest}</dd></div></dl></article>}
          <p className="text-muted-foreground">Receipt stages change only through the server-side operator harness. These controls read status, check its synthetic evidence or retrieve the same sample; they never sign, pay, stop or withdraw.</p>
          <a href="/demo">Open separate scripted simulation</a>
        </div></div></section>
        <aside aria-label="Working bar" className="working-bar desktop-working-bar bg-muted border-l"><div className="working-bar-heading"><h2 className="text-base font-medium">Task panel</h2></div>{context}</aside>
      </main>
    </div>
  </div>
}

export function PublicTestnetWorkspace({ auth: suppliedAuth, controller: suppliedController }: { auth?: ReturnType<typeof createWalletAuth>; controller?: ReturnType<typeof createPublicTestnetController> }) {
  const [approvedOrigin] = useState(() => import.meta.env.VITE_HALDIR_APPROVED_ORIGIN as string | undefined)
  const [auth] = useState(() => suppliedAuth ?? createWalletAuth({ origin: window.location.origin, recipient: window.location.hostname, secureContext: window.isSecureContext, approvedOrigin }))
  const login = useSyncExternalStore(auth.subscribe, auth.getSnapshot)
  const [controller] = useState(() => suppliedController ?? createPublicTestnetController({ origin: window.location.origin, approvedOrigin,
    principal: () => auth.getSnapshot().principal, storage: window.localStorage, requiredOwnerManifest: resolveOwnerManifest }))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [draft,setDraft] = useState(() => readPublicDraft(window.localStorage,window.location.origin))
  const [messages,setMessages] = useState<string[]>([])
  const saveDraft = (next: PublicDraft) => { controller.invalidateReview?.(); setDraft(next); window.localStorage.setItem(`haldir-public-draft-v1:${window.location.origin}`,JSON.stringify(next)) }
  const [approvalId, setApprovalId] = useState(''), [admissionKey, setAdmissionKey] = useState('')
  const sessionId = login.principal?.sessionId
  useEffect(() => { void auth.resume() }, [auth])
  useEffect(() => { controller.invalidateReview?.(); if (sessionId) void controller.resume() }, [controller, sessionId])
  const view = login.principal && state.view?.job.ownerId === login.principal.accountId ? state.view : null
  const [costReview,setCostReview] = useState<string | null>(null)
  const [panelVisible,setPanelVisible] = useState(true)
  const [mobilePanelOpen,setMobilePanelOpen] = useState(false), [editingDraft,setEditingDraft] = useState(false)
  const costIdentity = view && sessionId ? creationCostIdentity(view,sessionId) : null
  useEffect(() => { setCostReview(null) },[costIdentity])
  const busy = state.busy || login.busy
  const context = <div className="panel-details space-y-5">{view ? <PublicTaskContext view={view} /> : <PublicDraftPanel draft={draft} onSave={saveDraft} editing={editingDraft} onEditingChange={setEditingDraft} />}<details className="public-boundaries"><summary>Testnet boundaries and recovery</summary><p>Native NEAR testnet only. Login is not spending approval. Creation, stop and withdrawal each require a separate explicit owner wallet action.</p><p>The backend agent, not this browser, requests approved purchases. Vendor and source data are fictional samples. Two approved sources share one job, mandate, purchase cap and deadline. Each purchase has its own payment evidence and delivery.</p><p>Withdrawal returns settled free principal only, not deployment, storage, operating float or extra deposits.</p><p>Unknown payment or return stays unresolved. Checking status and reloading never ask for a new signature.</p><p>Email context, a complete spending ledger, a complete event history and active mandate changes are not provided by this public API. No mailbox is connected by this workspace.</p></details></div>
  return <div className="preview-page text-sm" data-public-testnet="">
    <section aria-label="Preview notice"><p className="preview-notice text-muted-foreground">NEAR testnet · Fictional vendor and sample data · No mainnet · Not a verified supplier finding</p></section>
    <div className="workspace-shell rounded-xl border bg-background">
      <header className="workspace-header border-b"><HaldirWordmark /><Separator orientation="vertical" className="header-separator" /><h1>Testnet job</h1><Sheet open={mobilePanelOpen} onOpenChange={setMobilePanelOpen}><SheetTrigger render={<Button variant="outline" className="mobile-panel-button" />}><PanelRightOpen aria-hidden="true" />Task panel</SheetTrigger><SheetContent data-public-testnet=""><SheetHeader><SheetTitle>Task panel</SheetTitle><SheetDescription>Testnet authority and recovery boundaries.</SheetDescription></SheetHeader>{context}</SheetContent></Sheet><Badge variant="outline" className="preview-badge">TESTNET</Badge></header>
      <main className={`workspace-body restoration ${panelVisible ? '' : 'panel-hidden panel-collapsed'}`}><section aria-label="Testnet job" className="conversation"><div className="conversation-stream" role="region" tabIndex={0} aria-label="Testnet results and receipts"><div className="conversation-content journey native-shadcn space-y-5">
        <h2 className="text-base font-medium">{view ? view.job.scope.purpose : 'What would you like to check?'}</h2>
        <PublicAgentWork view={view} draft={draft} busy={busy} error={Boolean(login.error || state.error)} />
        <details className="public-conversation-history" open={!view}><summary>Earlier in this conversation · {messages.length} local messages</summary><div role="log" aria-label="Conversation history"><p>Describe your job, then review the two operator-approved sources and spending limits. Your draft is kept when you log in.</p>{messages.map((m,i) => <p className="user-intention rounded-lg px-4 py-3" key={i}>{m}</p>)}</div></details>
        <div className="action-row">{!view && <Button variant="link" onClick={() => { setPanelVisible(true); setEditingDraft(true); if (window.innerWidth <= 760) setMobilePanelOpen(true) }}>Edit draft details</Button>}<Button variant="link" onClick={() => document.getElementById('public-message')?.focus()}>Ask a question</Button></div>
        <details className="public-session" open={!login.principal}><summary>Account and session</summary><p>Connect an existing testnet account, then log in separately. Neither action authorizes spending.</p>
        <div className="action-row"><Button variant="outline" disabled={busy} onClick={() => void auth.connect()}>Connect testnet account</Button><Button variant="outline" disabled={busy} onClick={() => void auth.login()}>Log in with connected testnet wallet</Button><Button variant="outline" disabled={busy} onClick={() => void auth.logout()}>Log out of session</Button></div>
        {login.connectedAccount && <p>Connected {login.connectedAccount.accountId} · testnet. Connection is not login.</p>}</details>
        <p role="status" aria-live="polite">{busy ? 'Reading testnet status or awaiting the explicit wallet request…' : login.error ? `Login not completed: ${login.error}. Retry explicitly; nothing opens automatically.` : !login.principal ? 'Not logged in. No financial action is enabled.' : state.error ? `Request not completed: ${state.error}. ${view ? 'Last observed state is retained. Check the same job; do not submit a replacement transaction.' : 'No job observation is available. Retry explicitly.'}` : state.wallet?.status === 'cancelled' ? 'Wallet request cancelled. No confirmed change is shown. The same operation is retained for reconciliation.' : state.wallet?.status === 'unknown' ? 'Wallet outcome unknown. No payment or return is assumed. Check the same operation without another signature.' : `Logged in as ${login.principal.accountId} · testnet. Wallet response is not settlement; only observed server receipts are shown below.`}</p>
        {login.principal && <>
          <div className="action-row"><Button variant="outline" disabled={busy} onClick={() => void controller.resume()}>Read testnet configuration and saved job</Button></div>
          {!state.config?.financialActions && <p>Financial actions are unavailable. {state.config?.missingConfiguration.join(', ') || 'No qualified public financial configuration has been read.'}</p>}
          {!controller.ownerApprovalAvailable && <p>Owner transaction transport is not configured. The unsigned request decoder and independent reviewed terms must be qualified before wallet approval can be enabled.</p>}
          {!view && <>
            <p>No approved terms selected yet. An operator must publish an approval for this account; a draft cannot create trusted terms.</p>
            <details open><summary>Support details · Select operator approval</summary><form className="draft-form" onSubmit={event => { event.preventDefault(); void controller.readApproval(approvalId) }}><label htmlFor="public-approval-id">Approved terms ID</label><Input id="public-approval-id" value={approvalId} maxLength={64} onChange={event => { controller.invalidateReview?.(); setApprovalId(event.target.value) }} /><Button variant="outline" type="submit" disabled={busy || !approvalId}>Load operator-approved terms</Button><p>This identifier selects the operator's immutable approval; it cannot provision one.</p></form></details>
            {state.preview && state.preview.ownerId === login.principal.accountId && <PublicPreview preview={state.preview} reviewed={Boolean(state.reviewed)} busy={busy} onUse={() => saveDraft(draftFromPreview(state.preview!))} onReview={() => void controller.reviewDraft(draft)} onAdmit={() => { let key = admissionKey; if (!key) { const saved = window.localStorage.getItem(`haldir-public-admission-v1:${window.location.origin}:${login.principal!.accountId}:${state.preview!.approvalId}`); key = saved ?? crypto.randomUUID(); window.localStorage.setItem(`haldir-public-admission-v1:${window.location.origin}:${login.principal!.accountId}:${state.preview!.approvalId}`,key); setAdmissionKey(key) } void controller.admitReviewed(key,draft) }} />}
          </>}
          {view && <>
            <PublicActivation view={view} />
            {view.contractVersion === 'haldir.public.v2' ? <><dl className="terms"><div><dt>Job</dt><dd>{view.job.scope.purpose}</dd></div><div><dt>Output</dt><dd>{view.job.scope.output}</dd></div><div><dt>Shared purchase cap · yoctoNEAR</dt><dd>{view.job.scope.budgetAtomic}</dd></div></dl><PublicSourceResults view={view} /></> : <dl className="terms"><div><dt>Job ID</dt><dd>{view.job.jobId}</dd></div><div><dt>Job</dt><dd>{view.job.scope.purpose}</dd></div><div><dt>Output</dt><dd>{view.job.scope.output}</dd></div><div><dt>Observed job state</dt><dd>{view.job.state}</dd></div><div><dt>Principal budget · yoctoNEAR</dt><dd>{view.job.scope.budgetAtomic}</dd></div><div><dt>Purchase · yoctoNEAR</dt><dd data-testid="public-purchase-amount">{view.order.quote.amountAtomic}</dd></div><div><dt>Source</dt><dd>{view.order.quote.vendorId}</dd></div><div><dt>Payment and delivery</dt><dd>{view.order.lifecycle}</dd></div><div><dt>Payment attention</dt><dd>{view.payment.status}</dd></div></dl>}
            <div className="action-row"><Button variant="outline" disabled={busy} onClick={() => void controller.refresh()}>Check same job and owner receipts</Button><Button variant="outline" disabled={busy || !state.config?.financialActions || !ownerCreationState(view).canRun} onClick={() => void controller.run(Boolean(view.run))}>Run or resume approved job</Button></div>
            {view.contractVersion !== 'haldir.public.v2' && view.order.lifecycle === 'PAID_NOT_DELIVERED' && <p>Payment receipt observed; delivery missing. Resume retrieves the same order, never a replacement payment.</p>}
            {view.contractVersion !== 'haldir.public.v2' && view.order.proof && <article className="order-result border-t space-y-4" aria-label="Testnet payment receipt"><h3>Payment receipt</h3><dl className="terms"><div><dt>Transaction hash</dt><dd>{view.order.proof.transactionHash}</dd></div><div><dt>Proof ID</dt><dd>{view.order.proof.proofId}</dd></div></dl></article>}
            {view.contractVersion !== 'haldir.public.v2' && view.order.artifact && <article className="order-result border-t space-y-4" aria-label="Fictional source sample"><h3>Fictional source sample</h3><p>{view.order.artifact.content}</p><dl className="terms"><div><dt>Artifact</dt><dd>{view.order.artifact.artifactId}</dd></div><div><dt>Digest</dt><dd>{view.order.artifact.contentDigest}</dd></div></dl></article>}
            {view.run?.report && 'schemaVersion' in view.run.report && <PublicReport report={view.run.report} />}
            {view.run?.report && !('schemaVersion' in view.run.report) && <article className="order-result border-t space-y-4" aria-label="Source-linked report"><h3>Source-linked report · {view.run.report.status}</h3><p>Fictional sample data. Not a verified supplier finding. Report completion does not establish returned funds.</p>{('findings' in view.run.report ? view.run.report.findings : []).map((finding, index) => <div key={`${finding.artifactId}:${index}`}><p>{finding.excerpt}</p><p>Source artifact: {finding.artifactId} · Payment proof: {finding.proofId ?? 'Not observed'}</p></div>)}{view.run.report.missing.map((missing, index) => <p key={index}>{missing}</p>)}</article>}
            <PublicOwnerObservations view={view} />
            {view.contractVersion === 'haldir.public.v2' && ownerCreationState(view).required && <PublicCreationCosts view={view} onReview={() => { void controller.reviewCreationCosts?.(); setCostReview(costIdentity) }} />}
          </>}
        </>}
      </div></div>{view && <div className="conversation-spending-actions"><div className="action-row">{(['create', 'stop', 'withdraw'] as const).filter(action => action !== 'create' || ownerCreationState(view).required).map(action => <Button key={action} variant="outline" disabled={busy || (action === 'create' && (!state.config?.financialActions || view.contractVersion === 'haldir.public.v2' && (!costIdentity || costReview !== costIdentity))) || !controller.ownerApprovalAvailable || view.ownerOperations.some(op => op.action === action) || controller.ownerOperationRetained?.(action)} onClick={() => void controller.approve(action)}>{action === 'create' ? 'Approve owner creation in wallet' : action === 'stop' ? 'Approve owner stop in wallet' : 'Approve owner withdrawal in wallet'}</Button>)}</div><div className="action-row">{(['stop', 'withdraw'] as const).filter(action => controller.canRetryPreparation?.(action)).map(action => <Button key={action} variant="outline" disabled={busy || !controller.ownerApprovalAvailable} onClick={() => void controller.retryPreparation(action)}>Retry {action === 'stop' ? 'stop' : 'withdrawal'} preparation</Button>)}</div></div>}<PublicComposer preparationOnly={!view} onSend={m => { setMessages(ms => [...ms,m]); if (!view) saveDraft({ ...draft,purpose:m }) }} /></section><aside aria-label="Working bar" hidden={!panelVisible} className="working-bar desktop-working-bar restoration-panel public-panel bg-muted border-l"><div className="working-bar-heading"><h2 className="text-base font-medium">Task panel</h2><PublicButton variant="outline" onClick={() => setPanelVisible(false)}>Hide panel</PublicButton></div>{context}</aside>{!panelVisible && <aside aria-label="Collapsed task panel" className="collapsed-rail"><PublicButton variant="outline" onClick={() => setPanelVisible(true)}><PanelRightOpen aria-hidden="true" />Show task panel</PublicButton>{view && <><p>{ownerCreationState(view).canRun ? view.job.state === 'STOPPED' ? 'Stopped' : 'Active · Server observed' : 'Owner creation required'}</p><p>Available · Not exposed</p></>}</aside>}</main>
    </div>
  </div>
}
function PublicOwnerObservations({ view }: { view: PublicJourneyView }) {
  const returned = view.ownerOperations.find(op => op.action === 'withdraw' && op.status === 'CONFIRMED' && op.receipt?.finality === 'final' && op.receipt?.networkId === 'testnet' && op.receipt?.ownerId === view.job.ownerId && op.receipt?.signerId === view.job.ownerId && op.receipt?.action === 'withdraw' && op.receipt?.mandateId === view.job.scope.mandateId && op.receipt?.receiptId && op.receipt?.amountAtomic)
  return <article className="order-result border-t space-y-4" aria-label="Observed owner actions"><h3>Observed owner actions</h3><p>{view.disclosures.principalReturn}</p>{view.ownerOperations.map(op => <dl className="terms" key={op.operationId}><div><dt>{op.action}</dt><dd>{op.status}</dd></div><div><dt>Operation</dt><dd>{op.operationId}</dd></div><div><dt>Transaction</dt><dd>{op.transactionHash ?? 'Unknown hash · Same operation retained'}</dd></div></dl>)}<p>Returned principal · yoctoNEAR: <span data-testid="public-returned-amount">{returned?.receipt?.amountAtomic ?? 'Not observed'}</span></p><p>Available principal is not money returned. Deployment, storage, operating float and extras are excluded.</p></article>
}

