import { beforeEach, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PublicTestnetWorkspace } from '../src/App'
import { createPublicTestnetController, type PublicJourneySnapshot, type PublicJourneyView } from '../src/integration/testnet'
import { type createWalletAuth, type LoginPrincipal, type LoginSnapshot } from '../src/integration/wallet-auth'

const origin = 'https://127.0.0.1:41991'
const principal: LoginPrincipal = { accountId:'owner.testnet',sessionId:'a'.repeat(64),publicKey:'ed25519:'+'1'.repeat(32),networkId:'testnet',origin,recipient:'127.0.0.1',expiresAt:1900000000000,authenticationOnly:true }
const jobKey = `haldir-public-job-v1:${origin}:${principal.accountId}`
const ownerKey = `haldir-public-owner-v1:${origin}:${principal.accountId}:job-retained:stop`
const ownerGuard = JSON.stringify({operationId:'b'.repeat(64),status:'unknown',transactionHash:null})
const config = {contractVersion:'haldir.public.v1',networkId:'testnet',financialActions:false,missingConfiguration:['qualification-only-disabled-runtime'],vendorData:'FICTIONAL_SAMPLE',maxRunMs:15000}
const noViewStatus = 'Request not completed: READ_FAILED. No job observation is available. Retry explicitly.'
const retainedStatus = 'Request not completed: READ_FAILED. Last observed state is retained. Check the same job; do not submit a replacement transaction.'
function view(delivered: boolean): PublicJourneyView {
  return {contractVersion:'haldir.public.v1',job:{jobId:'job-retained',ownerId:principal.accountId,state:'ACTIVE',ownerCreationRequired:false,qualification:'PUBLIC_TESTNET_FICTIONAL_VENDOR',manifestId:'manifest-retained',scope:{purpose:'Review fictional supplier',output:'Evidence-linked brief',budgetAtomic:'30'}},
    order:{jobId:'job-retained',orderId:'order-retained',quote:{amountAtomic:'8',vendorId:'records.testnet'},lifecycle:delivered?'DELIVERED':'PAYMENT_PENDING',proof:delivered?{proofId:'proof-retained',transactionHash:'1'.repeat(32)}:null,artifact:delivered?{artifactId:'artifact-retained',content:'FICTIONAL SAMPLE: retained company records.',contentDigest:'c'.repeat(64),fictionalSample:true}:null},
    payment:{status:delivered?'SUBMITTED':'NOT_STARTED',transactionHash:delivered?'1'.repeat(32):null},run:null,ownerOperations:[],disclosures:{vendorData:'FICTIONAL_SAMPLE',supplierVerified:false,principalReturn:'No settled return observed.'}}
}
function authFor(snapshot: LoginSnapshot) {
  return {subscribe:()=>()=>{},getSnapshot:()=>snapshot,resume:vi.fn(async()=>{}),connect:vi.fn(),login:vi.fn(),logout:vi.fn()} as unknown as ReturnType<typeof createWalletAuth>
}
function harness({saved=false, failConfig=false, failJob=false, delivered=false}={}) {
  const values = new Map<string,string>([[ownerKey,ownerGuard],...(saved?[[jobKey,'job-retained'] as [string,string]]:[])])
  const before = [...values]
  const auth = authFor({principal,busy:false,error:null})
  const storage = {getItem:(k:string)=>values.get(k)??null,setItem:vi.fn((k:string,v:string)=>{values.set(k,v)}),removeItem:vi.fn((k:string)=>{values.delete(k)})}
  let rejectJob = failJob
  const requests: {path:string;method:string|undefined;body:BodyInit|null|undefined}[]=[]
  const transport: typeof fetch = async (url,init) => {
    const path = new URL(String(url)).pathname
    requests.push({path,method:init?.method,body:init?.body})
    expect(init?.method).toBe('POST'); expect(init?.body).toBe('{}')
    if (path==='/api/public/config') return new Response(JSON.stringify(failConfig?{contractVersion:'haldir.public.v1',error:'READ_FAILED'}:config),{status:failConfig?503:200})
    if (path==='/api/public/jobs/job-retained') return new Response(JSON.stringify(rejectJob?{contractVersion:'haldir.public.v1',error:'READ_FAILED'}:view(delivered)),{status:rejectJob?503:200})
    throw new Error(`Unexpected transport: ${path}`)
  }
  const controller = createPublicTestnetController({origin,approvedOrigin:origin,principal:()=>principal,storage,transport,now:()=>1800000000000})
  const actions = [vi.spyOn(controller,'approve'),vi.spyOn(controller,'run'),vi.spyOn(controller,'open'),vi.spyOn(controller,'retryPreparation'),vi.spyOn(controller,'admitReviewed')]
  render(<PublicTestnetWorkspace auth={auth} controller={controller}/>)
  return {controller,auth,storage,requests,values,before,reject:()=>{rejectJob=true},assertNoActions:()=>{
    for (const action of actions) expect(action).not.toHaveBeenCalled()
    expect(auth.connect).not.toHaveBeenCalled();expect(auth.login).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled();expect(storage.setItem).not.toHaveBeenCalled()
    expect([...values]).toEqual(before)
  }}
}
beforeEach(()=>localStorage.clear())
function appStatus() {
  // Spending has its own incumbent status; select App's explicit live status.
  const statuses=screen.getAllByRole('status').filter(node=>node.getAttribute('aria-live')==='polite')
  expect(statuses).toHaveLength(1)
  return statuses[0]
}

test.each([
  ['failed configuration, no saved job',{failConfig:true}],
  ['failed configuration, saved identity',{failConfig:true,saved:true}],
  ['failed saved-job read, no snapshot',{failJob:true,saved:true}],
])('mounted live status is truthful after %s', async (_name, options) => {
  const h=harness(options)
  await waitFor(()=>expect(h.controller.getSnapshot()).toMatchObject({view:null,busy:false,error:'READ_FAILED'}))
  expect(appStatus()).toHaveTextContent(noViewStatus)
  expect(appStatus()).not.toHaveTextContent(/retained|check the same job|no execution|nothing happened/i)
  const work=screen.getByRole('region',{name:'Agent work'})
  expect(work).toHaveTextContent('No job observation is available · Retry explicitly')
  expect(work).not.toHaveTextContent(/No research or spending has started|no execution|nothing happened|no funds moved/i)
  expect(work).toHaveTextContent('Local draft only · Creating or editing a draft does not authorize spending. Review and authorization are separate.')
  expect(screen.getByRole('button',{name:'Read testnet configuration and saved job'})).toBeEnabled()
  expect(screen.queryByRole('button',{name:'Run or resume approved job'})).toBeNull()
  expect(h.requests.map(r=>r.path)).toEqual('failJob' in options?['/api/public/config','/api/public/jobs/job-retained']:['/api/public/config'])
  h.assertNoActions()
})

test.each([false,true])('mounted read error retains the same observed state, with proof/artifact=%s', async delivered => {
  const h=harness({saved:true,delivered})
  await waitFor(()=>expect(h.controller.getSnapshot().view?.job.jobId).toBe('job-retained'))
  const previous=h.controller.getSnapshot().view!
  expect(previous.order.proof!==null).toBe(delivered);expect(previous.order.artifact!==null).toBe(delivered)
  const controls=screen.getAllByRole('button').map(b=>({text:b.textContent,disabled:(b as HTMLButtonElement).disabled}))
  const refresh=screen.getByRole('button',{name:'Check same job and owner receipts'})
  refresh.focus();h.reject();fireEvent.click(refresh)
  await waitFor(()=>expect(h.controller.getSnapshot()).toMatchObject({busy:false,error:'READ_FAILED'}))
  expect(appStatus()).toHaveTextContent(retainedStatus)
  expect(appStatus()).not.toHaveTextContent('Last observed evidence')
  expect(h.controller.getSnapshot().view).toBe(previous)
  expect(h.controller.getSnapshot().view?.order).toBe(previous.order)
  expect(h.controller.getSnapshot().view?.order.proof).toBe(previous.order.proof)
  expect(h.controller.getSnapshot().view?.order.artifact).toBe(previous.order.artifact)
  expect(refresh).toHaveFocus()
  expect(screen.getAllByRole('button').map(b=>({text:b.textContent,disabled:(b as HTMLButtonElement).disabled}))).toEqual(controls)
  expect(screen.getByRole('button',{name:'Run or resume approved job'})).toBeDisabled()
  const work=screen.getByRole('region',{name:'Agent work'})
  expect(work).toHaveTextContent('Last observed state retained · Check the same job; no outcome is assumed')
  if (delivered) expect(work).toHaveTextContent('Source evidence received')
  else expect(work).not.toHaveTextContent('evidence received')
  expect(h.requests.map(r=>r.path)).toEqual(['/api/public/config','/api/public/jobs/job-retained','/api/public/jobs/job-retained'])
  h.assertNoActions()
})

test.each([
  ['controller busy',{busy:true,error:'READ_FAILED'}, {principal,busy:false,error:'LOGIN_FAILED'},'Reading testnet status or awaiting the explicit wallet request…'],
  ['login busy',{busy:false,error:'READ_FAILED'}, {principal,busy:true,error:'LOGIN_FAILED'},'Reading testnet status or awaiting the explicit wallet request…'],
  ['login error',{busy:false,error:'READ_FAILED'}, {principal,busy:false,error:'LOGIN_FAILED'},'Login not completed: LOGIN_FAILED. Retry explicitly; nothing opens automatically.'],
  ['logged out',{busy:false,error:'READ_FAILED'}, {principal:null,busy:false,error:null},'Not logged in. No financial action is enabled.'],
  ['wallet cancelled',{busy:false,error:null,wallet:{status:'cancelled',transactionHash:null}}, {principal,busy:false,error:null},'Wallet request cancelled. No confirmed change is shown. The same operation is retained for reconciliation.'],
  ['wallet unknown',{busy:false,error:null,wallet:{status:'unknown',transactionHash:null}}, {principal,busy:false,error:null},'Wallet outcome unknown. No payment or return is assumed. Check the same operation without another signature.'],
] as const)('existing %s status precedence remains unchanged', async (_name,patch,login,expected) => {
  const snapshot: PublicJourneySnapshot={view:null,config:null,wallet:null,...patch}
  const controller={getSnapshot:()=>snapshot,subscribe:()=>()=>{},resume:vi.fn(),invalidateReview:vi.fn(),approve:vi.fn(),run:vi.fn(),ownerApprovalAvailable:false} as unknown as ReturnType<typeof createPublicTestnetController>
  const auth=authFor(login)
  await act(async()=>{render(<PublicTestnetWorkspace auth={auth} controller={controller}/>)})
  expect(appStatus()).toHaveTextContent(expected)
  expect(controller.approve).not.toHaveBeenCalled();expect(controller.run).not.toHaveBeenCalled()
  expect(auth.connect).not.toHaveBeenCalled();expect(auth.login).not.toHaveBeenCalled()
})
