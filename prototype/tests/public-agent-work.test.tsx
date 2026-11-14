import { test, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { PublicTestnetWorkspace } from '../src/App'
import reportFixture from './fixtures/operational-supplier-report.json'

function view() {
  const order = { orderId:'records-order',quote:{amountAtomic:'8',vendorId:'records.testnet'},lifecycle:'DELIVERED',proof:{transactionHash:'fixture-hash',proofId:'fixture-proof'},artifact:{artifactId:'fixture-artifact',content:'Fictional supplied excerpt',contentDigest:'fixture-digest',fictionalSample:true} }
  const payment = {status:'SUBMITTED'}
  return { contractVersion:'haldir.public.v2',job:{jobId:'job-fixture',ownerId:'owner.testnet',state:'ACTIVE',ownerCreationRequired:false,scope:{purpose:'Review supplied details',output:'Evidence-linked brief',budgetAtomic:'30'}},
    order,payment,orders:[{sourceId:'company-records',order,payment},{sourceId:'background-research',order:{...order,orderId:'background-order',lifecycle:'PAYMENT_PENDING',proof:null,artifact:null},payment:{status:'NOT_STARTED'}}],run:null,ownerOperations:[],disclosures:{principalReturn:'No settled return observed.'} }
}
function mount(snapshot: any) {
  const approve=vi.fn(),run=vi.fn(),refresh=vi.fn()
  const authSnap:any={principal:{accountId:'owner.testnet',sessionId:'fixture-session'},busy:false,error:null}
  const auth:any={getSnapshot:()=>authSnap,subscribe:()=>()=>{},resume:vi.fn()}
  const controller:any={getSnapshot:()=>snapshot,subscribe:()=>()=>{},resume:vi.fn(),approve,run,refresh,ownerApprovalAvailable:false}
  const rendered=render(<PublicTestnetWorkspace auth={auth} controller={controller}/> )
  return {...rendered,approve,run,refresh}
}

test('public preparation and generic loading never invent email reads, reasoning or live work events', () => {
  localStorage.clear()
  const {rerender}=mount({view:null,busy:false,error:null,config:null})
  let work=screen.getByRole('region',{name:'Agent work'})
  expect(within(work).getByText('Haldir')).toBeVisible()
  expect(work).toHaveTextContent('Preparing your proposal')
  expect(work).toHaveTextContent('Local draft only · Creating or editing a draft does not authorize spending. Review and authorization are separate.')
  expect(work).not.toHaveTextContent(/email read|sources checked|evidence received/i)
  rerender(<></>)
})

test.each([
  ['retained evidence',null,false,null,'Company records evidence received','Background research · Not started'],
  ['generic request',null,true,null,'Waiting for the current request','No live activity details are available'],
  ['unknown stage',{stage:'FUTURE_STAGE',report:null},false,null,'Last observed state','Activity details unavailable'],
  ['blocked snapshot',{stage:'BLOCKED',report:null},false,null,'Work needs your attention','Last observed · Work blocked'],
  ['unresolved payment',{stage:'PAYMENT_UNKNOWN',report:null},false,null,'Payment outcome unresolved','Check the same payment'],
  ['request failure',null,false,'READ_FAILED','Request not completed','Check the same job'],
])('public work presents %s from snapshot only and never invokes a financial action', (_name,runState,busy,error,title,current) => {
  const v:any=view(); v.run=runState
  const {approve,run,refresh}=mount({view:v,busy,error,config:{financialActions:false,missingConfiguration:['model']}})
  const work=screen.getByRole('region',{name:'Agent work'})
  expect(work).toHaveTextContent(title)
  expect(work).toHaveTextContent(current)
  expect(work).not.toHaveTextContent(/No funds moved|Read the selected email|Checked the request|Background research evidence received|verification complete/i)
  expect(work).toHaveTextContent('Retained server observations · Not a live event stream')
  expect(within(screen.getByRole('complementary',{name:'Working bar'})).getByRole('region',{name:'Activity'})).toBeVisible()
  expect(screen.getByRole('button',{name:'Run or resume approved job'})).toBeDisabled()
  expect(approve).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();expect(refresh).not.toHaveBeenCalled()
})

test.each([null, {stage:'MODEL_PENDING',report:null}])('required owner authorization never erases retained observations or implies work never started (%s)', runState => {
  const v:any=view(); v.job.ownerCreationRequired=true; v.run=runState
  mount({view:v,busy:false,error:null,config:{financialActions:false,missingConfiguration:[]}})
  const work=screen.getByRole('region',{name:'Agent work'})
  expect(work).toHaveTextContent('Owner authorization required')
  expect(work).toHaveTextContent('Earlier observations retained')
  expect(work).toHaveTextContent('Company records evidence received')
  expect(work).not.toHaveTextContent('Work not started')
})

test.each([
  ['create','PREPARING','Owner creation · Preparation pending'],
  ['create','AWAITING_WALLET','Owner creation · Awaiting wallet'],
  ['create','UNKNOWN','Owner creation · Outcome unresolved'],
  ['create','FAILED','Owner creation · Failed'],
  ['stop','SUBMITTED','Stop requested · Not confirmed'],
  ['stop','UNKNOWN','Stop outcome unresolved · Not confirmed'],
  ['stop','FAILED','Stop failed · New spending is not confirmed disabled'],
  ['withdraw','SUBMITTED','Return requested · Settlement not established'],
  ['withdraw','UNKNOWN','Return outcome unresolved · Settlement not established'],
  ['withdraw','FAILED','Return failed · No settled return is assumed'],
  ['withdraw','CONFIRMED','Review the observed return below · Available funds are not returned funds'],
])('owner %s / %s is not hidden behind a generic source state', (action,status,current) => {
  const v:any=view(); v.ownerOperations=[{action,status,operationId:'b'.repeat(64),signerId:v.job.ownerId,transactionHash:null,receipt:null,request:null}]
  if(action==='create')v.job.ownerCreationRequired=true
  mount({view:v,busy:false,error:null,config:{financialActions:false,missingConfiguration:[]}})
  const work=screen.getByRole('region',{name:'Agent work'})
  expect(work).toHaveTextContent(current)
  expect(work).toHaveTextContent('Company records evidence received')
  expect(work).not.toHaveTextContent(/funds returned|work not started|no funds moved/i)
})

test.each(['READY','REPORT_PENDING','PARTIAL'])('stage %s alone establishes neither absence of prior execution nor retained evidence', stage => {
  const v:any=view();for(const member of v.orders){member.order={...member.order,lifecycle:'PAYMENT_PENDING',proof:null,artifact:null};member.payment={status:'NOT_STARTED'}}
  v.order=v.orders[0].order;v.payment=v.orders[0].payment;v.run={stage,report:null}
  mount({view:v,busy:false,error:null,config:{financialActions:false,missingConfiguration:[]}})
  expect(screen.getByRole('region',{name:'Agent work'})).not.toHaveTextContent(/No execution observed|Partial evidence retained|evidence received/)
})

test('failed preparation with no snapshot does not invent retained evidence or an existing job', () => {
  mount({view:null,busy:false,error:'READ_FAILED',config:null})
  const work=screen.getByRole('region',{name:'Agent work'})
  expect(work).toHaveTextContent('No job observation is available · Retry explicitly')
  expect(work).not.toHaveTextContent(/evidence retained|check the same job/i)
})

test.each(['PARTIAL','EVIDENCE_REVIEW_REQUIRED'])('report summary preserves %s without claiming verification or returned funds', status => {
  const v:any=view();v.run={stage:status==='PARTIAL'?'PARTIAL':'COMPLETE',report:{...reportFixture,status}}
  mount({view:v,busy:false,error:null,config:{financialActions:false,missingConfiguration:[]}})
  const work=screen.getByRole('region',{name:'Agent work'})
  expect(work).toHaveTextContent(status==='PARTIAL'?'Partial brief available':'Evidence ready for review')
  expect(work).toHaveTextContent('Review the source-linked report below · No signing assurance')
  expect(work).not.toHaveTextContent(/supplier verified|funds returned|safe to sign/i)
  expect(screen.getByRole('article',{name:'Source-linked report'})).toBeVisible()
})
