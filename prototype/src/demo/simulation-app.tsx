// In-memory scripted demo only. Never forwards a command to a wallet/backend.
import { useEffect, useRef, useState, type Dispatch } from 'react'
import { ArrowUp, Mail, Paperclip, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { ContextTrigger } from '@/components/reference-context'
import { initialReference } from '@/data/initial-reference'
import { useSimulationController } from '@/integration/controller'
import { Ledger, Terms, Review, Results, Editor, OrderResult } from './workspace'
import { ledger, validDraft, type State, type Event, type Block } from './model'
import { money, labels } from './presentation'
import { DemoControls } from './controls'
import { recipientRecords, suppliedEmail } from './fixtures'
import { HaldirWordmark } from '@/components/haldir-identity'
import { AgentWork } from '@/components/agent-work'

type Panel = 'summary' | 'edit' | 'block' | 'amendment' | 'amendmentEdit'
function SimulationAgentWork({ state:s }: { state:State }) {
 const received=s.orders.filter(o=>o.delivery==='received')
 const pending=s.orders.find(o=>o.delivery!=='received'&&o.payment!=='failed') ?? s.orders.find(o=>o.payment==='failed')
 const current=s.phase==='stopRequested'?'Waiting for stop confirmation · New spending is not yet confirmed disabled':
  s.phase==='returnPending'?'Return requested · Waiting for confirmation':
  ['stopped','closed'].includes(s.phase)?'New spending stopped · Earlier evidence retained':
  s.expired?'Permission expired · No new spending':
  pending?`${pending.content} ${pending.payment==='failed'?'payment failed · No purchase completed':pending.payment==='uncertain'?'payment uncertain · Check the same operation':pending.payment==='pending'?'payment pending':pending.delivery==='requested'?'delivery recovery requested':'paid · Evidence not received'}`:
  received.length && s.authorized?.background && !s.orders.some(o=>o.recipient==='background')?'Background research not started':
  received.length && s.authorized?.records && !s.orders.some(o=>o.recipient==='records')?'Company records not started':
  received.length?'Review the available evidence · No final brief exists in this demo':'No purchase started yet'
 return <AgentWork title="Your supplier check" steps={received.slice(-2).map(o=>`${o.content} evidence received`)} current={current} notice="Only the outcomes selected in Demo controls appear here."/>
}
function SpendingActions({ state:s, dispatch }: { state:State; dispatch:Dispatch<Event> }) {
 return <div className="spending-actions space-y-3">
  {s.phase === 'funding' && !s.fundingStopped && <><Button variant="outline" onClick={()=>dispatch({type:'STOP'})}>Stop new spending</Button><p className="text-muted-foreground">Prevents activation even if funding confirms later. Applies to this mandate, not the conversation.</p></>}
  {s.phase === 'funding' && s.fundingStopped && <p>New spending disabled before activation. Later funding will not start this job.</p>}
  {s.phase === 'active' && <><Button variant="outline" onClick={()=>dispatch({type:'STOP'})}>Stop new spending</Button><p className="text-muted-foreground">Requests a stop, then waits for confirmation. Existing payments are not cancelled.</p></>}
  {s.phase === 'stopRequested' && <p>Waiting for stop confirmation. New spending is not yet confirmed disabled.</p>}
  {s.phase === 'stopped' && <><Button variant="outline" onClick={()=>dispatch({type:'RECONCILE'})}>Check prior payments</Button><Button disabled={!s.reconciled || ledger(s).reserved>0} onClick={()=>dispatch({type:'RETURN'})}>Request return of {money(ledger(s).available)}</Button><p className="text-muted-foreground">Check prior payments first. You can request a return only when no funds are reserved. Only available funds can be returned; purchases are not refunded.</p></>}
  {s.phase === 'returnPending' && <p>Return requested. Waiting for confirmation. Funds are not yet marked returned; do not submit another request.</p>}
 </div>
}
function AuthorizedTerms({state}:{state:State}) {
 return <Dialog><DialogTrigger render={<Button variant="outline"/>}>View authorized terms</DialogTrigger><DialogContent className="context-dialog"><DialogHeader><DialogTitle>Authorized terms</DialogTitle><DialogDescription>Read only · Exact current authorized snapshot in this simulation. Not a wallet signature.</DialogDescription></DialogHeader><Terms draft={state.authorized!}/><details><summary>Authorization history</summary>{state.authorizationHistory.map((d,i)=><div key={i}><p>Authorization {i+1} · Original snapshot retained</p><Terms draft={d}/></div>)}</details>{state.approvedProposal && <p>A separately authorized proposal is saved but not applied. Current permissions are unchanged.</p>}</DialogContent></Dialog>
}
function Activation({state:s}:{state:State}) {
 return <section aria-label="Activation status" className="space-y-3"><h3 className="font-medium">Activation status</h3><dl className="terms"><div><dt>Authorization</dt><dd>{s.authorized?'Confirmed':'Not authorized'}</dd></div><div><dt>Funding</dt><dd>{s.funded?'Confirmed':s.fundingError?'Funding failed':'Funding pending'}</dd></div><div><dt>Mandate</dt><dd>{s.fundingStopped?'Stopped before activation':s.phase==='funding'?'Not active':s.expired && s.phase === 'active' ? 'Permission expired' : s.phase === 'active' ? 'Active' : labels[s.phase]}</dd></div></dl></section>
}
function Activity({state,onBlock,compact=false}:{state:State;onBlock:(b:Block)=>void;compact?:boolean}) {
 return <section aria-label="Activity" className={`space-y-3${compact?' panel-activity':''}`}><h3 className="font-medium">Activity</h3><p className="text-muted-foreground">Retained in this demo session only. Reset or reload clears this log.</p><ol className="activity-list">{state.activity.map(a=><li key={a.sequence} data-tone={a.blockId ? 'warning' : a.type==='DELIVER' && !state.blocks.length ? 'received' : undefined}><span className="text-muted-foreground">{a.sequence}. </span>{a.blockId?'Payment blocked · ':''}{a.text}{a.blockId&&<Button variant="outline" onClick={()=>onBlock(state.blocks.find(b=>b.id===a.blockId)!)}>View details</Button>}</li>)}</ol></section>
}
function Email(){return <section aria-label="Supplied email thread" className="supplied-email"><h3 className="font-medium">Supplied email thread</h3><p className="text-muted-foreground">Untrusted content · Supplied email (fictional fixture) · Not your instruction</p><p>From: {suppliedEmail.sender}</p><blockquote>{suppliedEmail.text}</blockquote></section>}
function BlockDetails({block,state,onContinue,onChange,dispatch}:{block:Block;state:State;onContinue:()=>void;onChange:()=>void;dispatch:Dispatch<Event>}){
 const email=block.id==='DEMO-EXCLUDED-03'
 return <section aria-label="Payment blocked details" className="space-y-4"><h3 className="font-medium">Payment blocked</h3>
  {email&&<section aria-label="What the email claims" className="block-claims"><h4 className="font-medium">What the email claims</h4><p>Untrusted · {suppliedEmail.sender}</p><blockquote>{suppliedEmail.text}</blockquote><p>Requested recipient: {suppliedEmail.recipient}</p></section>}
  <section aria-label="What the system established" className="block-established"><h4 className="font-medium">What the system established</h4><p>Requested amount: {money(block.amount)} · {block.reason}</p>
  <p>{block.amount<=block.available?'Amount fits the budget. Amount was not the reason.':'Request exceeds available funds at the decision.'}</p>
  <h4 className="font-medium">Allowed recipients</h4><ul>{recipientRecords.filter(r=>state.authorized?.[r.key]).map(r=><li key={r.key}>{r.name} · {r.id}</li>)}</ul>{email&&<p>Requested [new recipient] is not in this allowlist.</p>}
  <p>Blocked before payment · No funds moved</p><p>At this request: Spent {money(block.spending.spent)} · Reserved {money(block.spending.reserved)} · Available {money(block.spending.available)} · Unchanged</p>
  <p className="text-muted-foreground">Local demo spending-rule simulator · Local log reference {block.id}. These are established simulator facts, not live enforcement or chain proof. Not every blocked request produces an on-chain transaction.</p></section>
  <div className="action-row"><Button variant="outline" onClick={onContinue}>Continue without this purchase</Button><Button variant="outline" onClick={onChange}>Request mandate change</Button></div><SpendingActions state={state} dispatch={dispatch}/>
 </section>
}
function AddContext({onAdd}:{onAdd:(text:string)=>void}){
 const [open,setOpen]=useState(false),[text,setText]=useState('')
 return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger render={<Button variant="outline"/>}><Paperclip aria-hidden="true"/>Add context</DialogTrigger><DialogContent className="context-dialog"><DialogHeader><DialogTitle>Add local context</DialogTitle><DialogDescription>Paste a note for this job. Local session only; no upload, mailbox or network connection. Context cannot grant spending permission.</DialogDescription></DialogHeader><form className="draft-form" onSubmit={e=>{e.preventDefault();if(text.trim()){onAdd(text.trim());setText('');setOpen(false)}}}><label htmlFor="context-note">Context note</label><Textarea id="context-note" value={text} maxLength={2000} onChange={e=>setText(e.target.value)}/><Button disabled={!text.trim()} type="submit">Add to this job</Button></form></DialogContent></Dialog>
}

export default function SimulationApp(){
 const {state,dispatch}=useSimulationController()
 const [resetVersion,setResetVersion]=useState(0)
 const [message,setMessage]=useState(''),[panelVisible,setPanelVisible]=useState(()=>window.innerWidth>760),[panel,setPanel]=useState<Panel>('summary'),[blockId,setBlockId]=useState(''),[notes,setNotes]=useState<string[]>([]),[seen,setSeen]=useState(0)
 const composer=useRef<HTMLTextAreaElement>(null), opener=useRef<HTMLButtonElement>(null)
 const editButton=useRef<HTMLButtonElement>(null), amendmentEditButton=useRef<HTMLButtonElement>(null)
 const focusFrame=useRef<number|null>(null)
 const focusLater=(target:{current:HTMLElement|null})=>{if(focusFrame.current!==null)cancelAnimationFrame(focusFrame.current);focusFrame.current=requestAnimationFrame(()=>{focusFrame.current=null;target.current?.focus()})}
 useEffect(()=>{if(resetVersion)composer.current?.focus();return()=>{if(focusFrame.current!==null){cancelAnimationFrame(focusFrame.current);focusFrame.current=null}}},[resetVersion])
 const apply:Dispatch<Event>=e=>{if(e.type==='RESET'){setResetVersion(n=>n+1);setMessage('');setPanel('summary');setPanelVisible(window.innerWidth>760);setNotes([]);setSeen(0);setBlockId('')}dispatch(e)}
 const send=()=>{if(message.trim()){apply({type:'SEND',text:message});setMessage('')}}
 const openEditor=()=>{setPanel('edit');setPanelVisible(true)}
 const onBlock=(b:Block)=>{setBlockId(b.id);setPanel('block');setPanelVisible(true)}
 const change=()=>{apply({type:'PROPOSE_CHANGE'});setPanel('amendment');setPanelVisible(true)}
 const continued=()=>{apply({type:'CONTINUE',id:blockId});setPanel('summary')}
 const firstBlock=[...state.blocks].reverse().find(b=>!state.continued.includes(b.id))
 const selectedBlock=state.blocks.find(b=>b.id===blockId)
 const notices=state.activity.filter(a=>a.type==='DELIVER'||a.blockId).length
 const fundingStatus=state.fundingError?'Funding failed':'Funding pending'
 const closeEditor=()=>{setPanel(panel==='amendmentEdit'?'amendment':'summary');focusLater(panel==='amendmentEdit'?amendmentEditButton:editButton)}
 // The delivered nine-state source supersedes the earlier three-state pilot.
 // Keep one lateral-panel anatomy through review, funding and blocked states.
 const panelPilot=true
 const panelBody=panel==='edit'||panel==='amendmentEdit'?<Editor key={panel} state={state} dispatch={apply} onClose={closeEditor} amendment={panel==='amendmentEdit'}/>:
 panel==='block'&&selectedBlock?<><Button variant="outline" onClick={()=>setPanel('summary')}>Back to summary</Button><BlockDetails block={selectedBlock} state={state} dispatch={apply} onContinue={continued} onChange={change}/></>:
 panel==='amendment'&&state.proposal?<section className="space-y-4"><h3 className="font-medium">Separate mandate change proposal</h3><p>Current mandate and all existing accounting remain unchanged. No recipient is imported from untrusted email. Only the two trusted demo records can be proposed.</p><Terms draft={state.proposal}/><Button ref={amendmentEditButton} variant="outline" onClick={()=>setPanel('amendmentEdit')}>Edit proposed terms</Button><Button disabled={!validDraft(state.proposal)||!!state.approvedProposal} onClick={()=>apply({type:'REAUTHORIZE_PROPOSAL'})}>Authorize proposal only (not applied)</Button>{state.approvedProposal&&<p role="alert">Proposal authorized in the simulation, but not applied. This demo cannot transfer the existing balance, reserved funds or expiry to changed permissions. Your original permissions remain unchanged. Use Stop new spending to stop them.</p>}<AuthorizedTerms state={state}/><Button variant="outline" onClick={()=>setPanel('summary')}>Back to current mandate</Button><SpendingActions state={state} dispatch={apply}/></section>:
 state.phase==='entry'?<p className="working-bar-description text-muted-foreground">{initialReference.workingBarEmpty}</p>:<div className="panel-details space-y-5">
  <section aria-label="Task summary" className="space-y-3"><h3 className="font-medium">Task summary</h3><p className="panel-status">{state.authorized?state.phase==='funding'?`Authorized · ${fundingStatus}`:state.expired && state.phase === 'active' ? 'Permission expired' : state.phase === 'active' ? 'Spending permissions: Active' : labels[state.phase]:state.phase==='review'?'Ready for review · Not authorized':'Draft · Not authorized'}</p>{state.authorized?<><p>{state.authorized.job}</p><p className="panel-agent">Research agent · Scripted demo</p>{panelPilot?<div className="panel-summary-actions"><AuthorizedTerms state={state}/><p className="panel-amendment-note">Changes need a separate proposal and authorization. They do not apply to this task in the demo.</p><Button variant="outline" onClick={change}>Request mandate change</Button></div>:<><AuthorizedTerms state={state}/><Button variant="outline" onClick={change}>Request mandate change</Button></>}</>:<><Terms draft={state.draft} panel part="job"/><section aria-label="Before authorization" className="before-authorization"><h4 className="font-medium">Before authorization</h4><Terms draft={state.draft} panel part="spending"/><Button ref={editButton} variant="outline" onClick={openEditor}>Edit details</Button></section><Terms draft={state.draft} panel part="context"/></>}</section>
  {state.authorized&&<><section aria-label="Spending"><h3 className="font-medium">Spending</h3><p className="panel-spending-note">Purchase limit {state.authorized.budget} TEST · Network costs separate · None charged in demo</p>{state.funded?<Ledger state={state}/>:<p>Spent: Not started · Reserved: Not started · Available: {fundingStatus}</p>}</section><Activity state={state} onBlock={onBlock} compact={panelPilot}/><Results state={state} dispatch={apply} panel={panelPilot}/></>}
  <SpendingActions state={state} dispatch={apply}/>
 </div>
 return <div className="preview-page text-sm">
  <section aria-label="Preview notice"><p className="preview-notice text-muted-foreground">Scripted simulation. No live AI calls, real email or real funds. Testnet is not configured. Open Demo controls below to advance or reset the simulation.</p></section>
  <div className="workspace-shell rounded-xl border bg-background">
   <header className="workspace-header border-b"><HaldirWordmark/><Separator orientation="vertical" className="header-separator"/><h1>{state.phase==='entry'?'New task':'Northwind Print check'}</h1><Button className="mobile-panel-button" variant="outline" onClick={()=>setPanelVisible(true)}><PanelRightOpen aria-hidden="true"/>Task panel</Button><Badge variant="outline" className="preview-badge">Demo</Badge></header>
   <main className={`workspace-body restoration ${panelVisible?'':'panel-hidden'}`}>
    <section aria-label="Conversation" className="conversation">
     <div className="conversation-stream" role="region" tabIndex={0} aria-label="Conversation messages"><div className="conversation-content journey native-shadcn space-y-5">
      <details className={`conversation-history${['entry','draft'].includes(state.phase)?' history-current':''}`} open={['entry','draft'].includes(state.phase)||panel==='edit'||undefined}><summary>Earlier in this conversation · {state.messages.length+1} messages</summary><div role="log" aria-label="Conversation history" aria-live="polite"><ol className="space-y-4">
       <li className="assistant-message"><span className="agent-name">Haldir</span><p>{initialReference.question}</p></li>
       {state.entry==='chat'&&(!state.messages.length || /^(budget|expiry|output)\s/i.test(state.messages[0].text))&&<li className="user-intention rounded-lg px-4 py-3"><p>{initialReference.intention}</p><ContextTrigger presentation="demo" key={`context-${resetVersion}`} notes={notes}>Email thread · fictional fixture</ContextTrigger></li>}
       {state.messages.map((m,i)=><li key={i} className={m.from==='user'?'user-intention rounded-lg px-4 py-3':'assistant-message'}>{m.from==='user'&&<span className="message-author text-muted-foreground">You</span>}{m.from!=='user'&&<span className="agent-name">Haldir</span>}<p>{m.text}</p></li>)}
      </ol></div></details>
      {state.phase==='entry'&&<section className="reference-card"><h2 className="surface-title">Example email thread · 3 messages</h2><Card><CardContent><ul className="email-list">{initialReference.messages.map(m=><li key={m.id}><Mail className="size-4 text-muted-foreground" aria-hidden="true"/>{m.subject}</li>)}</ul><p className="text-muted-foreground">Example messages for this supplier check</p></CardContent></Card></section>}
      {state.entry==='external'&&<p>Fictional external proposal · No progress or results have been supplied by an integration.</p>}
      {state.phase!=='entry'&&<p role="status" className="current-note" aria-live="polite">{state.note === state.messages.at(-1)?.text && state.phase==='draft' ? '' : state.note}</p>}
      {['funding','active','stopRequested','returnPending'].includes(state.phase)&&<p className="text-muted-foreground">Open Demo controls below to choose the next scripted outcome. Nothing advances automatically.</p>}
      {['draft','review'].includes(state.phase)&&<><AgentWork title="Preparing your proposal" steps={['Request saved in this local draft']} current={validDraft(state.draft) ? 'Draft ready for your review' : !state.draft.budget && !state.draft.expiry ? 'Budget and expiry need your review' : 'Complete the missing draft details'} notice="No spending before your review and authorization."/><Review state={state} dispatch={apply} onEdit={openEditor} onAsk={()=>composer.current?.focus()}/></>}
      {state.authorized&&<><h2 className="sr-only">Task progress</h2><AuthorizedTerms state={state}/>{state.phase==='funding'&&<Card className={state.fundingError?'funding-error':'funding-pending'}><CardHeader><CardTitle><h3>{state.fundingError?'Funding failed':'Authorization confirmed · Funding pending'}</h3></CardTitle></CardHeader><CardContent className="space-y-3"><Activation state={state}/><p>Work has not started.</p><p>{state.authorized.budget} TEST requested for this job. Permission alone does not make funds available.</p>{state.fundingError&&<Button variant="brand-primary" onClick={()=>apply({type:'RETRY_FUNDING'})}>Retry funding request</Button>}<p className="text-muted-foreground">Simulation only. Presenter selects the funding outcome in Demo controls.</p></CardContent></Card>}
       {state.funded>0&&<><p>Mandate: {state.expired && state.phase === 'active' ? 'Permission expired' : state.phase === 'active' ? 'Active' : labels[state.phase]} · Available {money(ledger(state).available)}</p>{!firstBlock&&<SimulationAgentWork state={state}/>}</>}
       {firstBlock&&<>{firstBlock.id==='DEMO-EXCLUDED-03'&&<Email/>}<AgentWork title={`Payment blocked · ${firstBlock.reason}`} steps={state.orders.filter(o=>o.delivery==='received').slice(-2).map(o=>`${o.content} evidence received`)} current={firstBlock.reason} tone="warning" notice="Local spending-rule simulation · Not live enforcement or chain proof."><div className="agent-work-results"><p>{firstBlock.reason==='Recipient not allowed'?`A ${money(firstBlock.amount)} payment request was blocked. ${firstBlock.amount<=firstBlock.available?'The amount fits the budget, but the recipient is not authorized.':'The recipient is not authorized.'} Email content cannot change your permissions.`:firstBlock.reason==='Insufficient budget'?`This request needed ${money(firstBlock.amount)}, but only ${money(firstBlock.available)} was unreserved at the time. A reservation for another request cannot be spent twice.`:'This new request was refused. Earlier results and receipts are unchanged.'}</p><p>No funds moved for this request.</p><Button variant="outline" onClick={()=>onBlock(firstBlock)}>View details</Button></div></AgentWork><div className="action-row block-optional-actions"><Button variant="outline" onClick={()=>{apply({type:'CONTINUE',id:firstBlock.id});setPanel('summary')}}>Continue without this purchase</Button><Button variant="outline" onClick={change} aria-describedby="mandate-change-requirement">Request mandate change</Button></div><p id="mandate-change-requirement" className="mandate-change-requirement">Requires a new authorization. Opens a separate proposal. Even after authorization, it will not change this task in the demo.</p></>}
       {state.orders.filter(o=>o.delivery==='received').map(o=><article key={o.id} className="result-notification space-y-3"><span className="agent-name">Haldir</span><p>{o.content} received. Evidence and {money(o.amount)} purchase receipt are available in the task panel.</p><p className="text-muted-foreground">Next: {state.orders.some(x=>x.recipient==='background'&&x.delivery==='received')?'Review the received sources and their purchase receipts. The brief is partial, not final.':'Review the received sources and their purchase receipts. The brief is partial, not final.'}</p><OrderResult order={o} dispatch={apply}/></article>)}
      </>}
     </div></div>
     {state.authorized&&<div className="conversation-spending-actions"><SpendingActions state={state} dispatch={apply}/></div>}
     <div className="composer-area"><Card className="composer" data-composer="unitary"><CardContent className="space-y-3"><label className="sr-only" htmlFor="message">Your message</label><Textarea ref={composer} id="message" value={message} maxLength={1000} onChange={e=>setMessage(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send()}}} placeholder="Describe what you need…" aria-describedby="composer-limit"/><div className="composer-actions"><div className="action-row"><AddContext key={resetVersion} onAdd={text=>setNotes(n=>[...n,text])}/><ContextTrigger presentation="demo" key={`context-${resetVersion}`} notes={notes} variant="brand-dark">View context</ContextTrigger></div><Button size="icon" disabled={!message.trim()} onClick={send} aria-label="Send message"><ArrowUp aria-hidden="true"/></Button></div></CardContent></Card><p id="composer-limit" className="meta composer-limit text-muted-foreground">Scripted replies only. Send your task first, then send “budget 30; expiry 2026-11-12T18:00” as a separate message. Dates use the demo clock: 12 Nov 2026, 12:00 UTC. Messages never authorize or stop spending.</p></div>
    </section>
    {panelVisible?<aside aria-label="Working bar" className={`working-bar restoration-panel bg-muted border-l${panelPilot?' panel-refinement':''}`}><div className="working-bar-heading"><h2 className="font-medium">Task panel</h2>{!['edit','amendmentEdit'].includes(panel)&&<Button variant="outline" onClick={()=>{setSeen(notices);setPanelVisible(false);focusLater(opener)}}><PanelRightClose aria-hidden="true"/>Hide panel</Button>}</div>{panelBody}{panel==='summary'&&<div className="working-bar-context"><h3 className="font-medium">Example email thread</h3><ContextTrigger presentation="demo" key={`context-${resetVersion}`} notes={notes} className="thread-button"><Mail aria-hidden="true"/>Selected thread · 3 messages</ContextTrigger><p className="text-muted-foreground">Example thread attached to this task. No live email connection.{notes.length?` ${notes.length} local context note(s).`:''}</p></div>}</aside>:<aside aria-label="Collapsed task panel" className="collapsed-rail"><Button ref={opener} variant="outline" onClick={()=>{setPanelVisible(true);setSeen(notices)}}><PanelRightOpen aria-hidden="true"/>Show task panel</Button><p>{state.phase==='funding'?fundingStatus:state.expired && state.phase === 'active' ? 'Permission expired' : state.phase === 'active' ? 'Active' : labels[state.phase]}</p>{state.authorized&&<p>Available {state.funded?money(ledger(state).available):fundingStatus}</p>}{notices>seen&&<p>{notices-seen} new</p>}<SpendingActions state={state} dispatch={apply}/></aside>}
   </main>
  </div>
  <section aria-label="Presenter simulation"><DemoControls state={state} dispatch={apply}/></section>
 </div>
}
