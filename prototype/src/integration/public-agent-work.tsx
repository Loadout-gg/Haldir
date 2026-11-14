import { AgentWork } from '@/components/agent-work'
import { ownerCreationState, type PublicJourneyView } from './testnet'
import type { PublicDraft } from './public-draft'

// This API exposes snapshots, not an event stream. Never infer completed checks,
// a purchase attempt, an execution timeline or a no-funds-moved claim from a stage.
const stageCopy: Record<string, string> = {
  READY: 'Ready · Check the same job', PAYMENT_PRECHECK: 'Payment precheck',
  MODEL_PENDING: 'Planning response pending', QUOTE_READY: 'Approved purchase ready',
  PAYMENT_SUBMITTING: 'Payment submission in progress · Outcome not established',
  PAYMENT_RECONCILING: 'Payment reconciliation pending',
  DELIVERY_PENDING: 'Delivery pending · Evidence not received',
  REPORT_PENDING: 'Full report pending',
  PARTIAL: 'Partial run · Review what is missing',
}
export function PublicAgentWork({ view, draft, busy, error }: {
  view: PublicJourneyView | null; draft: PublicDraft; busy: boolean; error: boolean
}) {
  const members = view?.orders ?? (view ? [{sourceId:'legacy',order:view.order,payment:view.payment}] : [])
  const name = (id:string) => id==='company-records' ? 'Company records' : id==='background-research' ? 'Background research' : 'Source'
  const steps = members.flatMap(m => m.order.artifact && m.order.lifecycle==='DELIVERED' ? [`${name(m.sourceId)} evidence received`] : m.order.proof ? [`${name(m.sourceId)} purchase receipt observed · Evidence not received`] : []).slice(-2)
  const report = view?.run?.report, stage = view?.run?.stage
  let title = 'Preparing your proposal'
  let current = draft.purpose ? 'Local draft saved · Review its details in the task panel' : 'Describe the job to start a local draft'
  if (view) {
    title = 'Your supplier check'
    const missing = members.find(m=>!m.order.artifact)
    current = missing ? `${name(missing.sourceId)} · ${missing.order.proof ? 'Paid · Evidence not received' : missing.payment.status==='NOT_STARTED' ? 'Not started' : 'Payment outcome unresolved'}` : 'Evidence retained · No report observed'
    if (stage) { title = 'Last observed state'; current = stageCopy[stage] ? `Last observed · ${stageCopy[stage]}` : 'Activity details unavailable · Check the same job' }
    if (report) { title = report.status==='PARTIAL' ? 'Partial brief available' : 'Evidence ready for review'; current = 'Review the source-linked report below · No signing assurance' }
    if (stage==='BLOCKED') { title = 'Work needs your attention'; current = 'Last observed · Work blocked. Check the same job before continuing.' }
    if (stage==='PAYMENT_UNKNOWN') { title = 'Payment outcome unresolved'; current = 'Check the same payment · Do not make a replacement purchase' }
    if (!ownerCreationState(view).canRun) { title = 'Owner authorization required'; current = 'Review owner authorization · Earlier observations retained' }
    if (view.job.state==='STOPPED') { title = 'New spending stopped'; current = 'Server-observed stop · Earlier purchases and their evidence are retained' }
    const operation = view.ownerOperations.find(op=>op.action==='withdraw') ?? view.ownerOperations.find(op=>op.action==='stop') ?? view.ownerOperations.find(op=>op.action==='create' && !ownerCreationState(view).canRun)
    if (operation) {
      const pending = operation.status==='UNKNOWN' ? 'Outcome unresolved' : operation.status==='FAILED' ? 'Failed' : operation.status==='PREPARING' ? 'Preparation pending' : operation.status==='AWAITING_WALLET' ? 'Awaiting wallet' : 'Confirmation pending'
      if (operation.action==='create') { title='Owner authorization required'; current=`Owner creation · ${pending} · Earlier observations retained` }
      if (operation.action==='stop' && view.job.state!=='STOPPED') {
        title='Check the same stop operation'
        current=operation.status==='FAILED' ? 'Stop failed · New spending is not confirmed disabled' : operation.status==='UNKNOWN' ? 'Stop outcome unresolved · Not confirmed' : operation.status==='CONFIRMED' ? 'Stop receipt observed · Check the current job state' : `Stop requested · Not confirmed · ${pending}`
      }
      if (operation.action==='withdraw') {
        title='Check the same return operation'
        current=operation.status==='FAILED' ? 'Return failed · No settled return is assumed' : operation.status==='UNKNOWN' ? 'Return outcome unresolved · Settlement not established' : operation.status==='CONFIRMED' ? 'Review the observed return below · Available funds are not returned funds' : `Return requested · Settlement not established · ${pending}`
      }
    }
  }
  if (error) { title = 'Request not completed'; current = view ? 'Last observed state retained · Check the same job; no outcome is assumed' : 'No job observation is available · Retry explicitly' }
  if (busy) { title = 'Waiting for the current request'; current = 'Waiting for a response · No live activity details are available' }
  return <AgentWork headingLevel={3} title={title} steps={steps} current={current} tone={error || stage==='BLOCKED' || stage==='PAYMENT_UNKNOWN' ? 'warning' : 'neutral'} notice={view ? 'Retained server observations · Not a live event stream' : 'Local draft only · Creating or editing a draft does not authorize spending. Review and authorization are separate.'}/>
}
