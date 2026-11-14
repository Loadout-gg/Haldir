import '@testing-library/jest-dom/vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import SimulationApp from '../src/demo/simulation-app'
import * as controller from '../src/integration/controller'
import { createState, defaultDraft, ledger, transition, type Event, type Phase } from '../src/demo/model'

const r:Event={type:'REQUEST',id:'DEMO-RECORDS-01',recipient:'records',amount:800,content:'Company records'}
const b:Event={type:'REQUEST',id:'DEMO-BACKGROUND-02',recipient:'background',amount:1500,content:'Background research'}
const excluded:Event={type:'REQUEST',id:'DEMO-EXCLUDED-03',recipient:'excluded',amount:200,content:'Email verification fee'}
const extra:Event={type:'REQUEST',id:'DEMO-EXTRA-04',recipient:'records',amount:1500,content:'Additional company details'}
const e=(type:string,id?:string):Event=>({type,...(id?{id}:{})})
const funding=[e('EXTERNAL'),e('AUTHORIZE')]
const active=[...funding,e('FUNDING_CONFIRMED')]
const pending=[...active,r]
const paid=[...pending,e('PAID',r.id)]
const received=[...paid,e('DELIVER',r.id)]
const refused=[...received,excluded]
const twoPending=[...refused,b,extra]
const twoReceived=[...twoPending,e('PAID',b.id),e('DELIVER',b.id)]
const stopped=[...twoReceived,e('STOP'),e('STOP_CONFIRMED')]
const returning=[...stopped,e('RECONCILE'),e('RETURN')]
export const scenarios:{name:string;phase:Phase;events:Event[]}[]=[
 {name:'S01 initial entry',phase:'entry',events:[]},
 {name:'S01 incomplete chat draft',phase:'draft',events:[{type:'SEND',text:'Check Northwind; a brief with evidence'}]},
 {name:'S01 edited incomplete draft',phase:'draft',events:[e('SHAPE'),{type:'EDIT',draft:{...defaultDraft,budget:''}}]},
 {name:'S01 complete chat review',phase:'review',events:[{type:'SEND',text:'job Check Northwind; output Brief; budget 30; expiry 2026-11-12T18:00'}]},
 {name:'S01 external proposal review',phase:'review',events:[e('EXTERNAL')]},
 {name:'S02 authorization funding pending',phase:'funding',events:funding},
 {name:'S02 funding failure',phase:'funding',events:[...funding,e('FUNDING_FAILED')]},
 {name:'S02 retry same funding',phase:'funding',events:[...funding,e('FUNDING_FAILED'),e('RETRY_FUNDING')]},
 {name:'S02 funding stopped before activation',phase:'funding',events:[...funding,e('STOP')]},
 {name:'S02 late funding remains stopped',phase:'stopped',events:[...funding,e('STOP'),e('FUNDING_CONFIRMED')]},
 {name:'S02 active before purchases',phase:'active',events:active},
 {name:'recovery payment pending',phase:'active',events:pending},
 {name:'recovery payment uncertain',phase:'active',events:[...pending,e('UNCERTAIN',r.id)]},
 {name:'recovery checking same uncertain operation',phase:'active',events:[...pending,e('UNCERTAIN',r.id),e('CHECK',r.id)]},
 {name:'recovery confirmed failure releases reservation',phase:'active',events:[...pending,e('FAILURE_CONFIRMED',r.id)]},
 {name:'recovery paid but delivery missing',phase:'active',events:paid},
 {name:'recovery delivery requested same order',phase:'active',events:[...paid,e('RECOVER_DELIVERY',r.id)]},
 {name:'S03 company records received',phase:'active',events:received},
 {name:'S04 excluded recipient refused',phase:'active',events:refused},
 {name:'S04 continued authorized work',phase:'active',events:[...refused,e('CONTINUE',excluded.id)]},
 {name:'S04 separate amendment proposal',phase:'active',events:[...refused,e('PROPOSE_CHANGE')]},
 {name:'S04 amendment edited not applied',phase:'active',events:[...refused,e('PROPOSE_CHANGE'),{type:'EDIT_PROPOSAL',draft:{...defaultDraft,budget:'40'}}]},
 {name:'S04 amendment reauthorized activation blocked',phase:'active',events:[...refused,e('PROPOSE_CHANGE'),e('REAUTHORIZE_PROPOSAL')]},
 {name:'S05 two ordered requests budget refusal',phase:'active',events:twoPending},
 {name:'S06 two separate results received',phase:'active',events:twoReceived},
 {name:'S07 stop requested not confirmed',phase:'stopRequested',events:[...twoReceived,e('STOP')]},
 {name:'S07 confirmed stop',phase:'stopped',events:stopped},
 {name:'S07 post-stop new request refused',phase:'stopped',events:[...stopped,{type:'REQUEST',id:'DEMO-AFTER-STOP-05',recipient:'records',amount:100,content:'New purchase after stop'}]},
 {name:'S07 unresolved payment prevents reconciliation',phase:'stopped',events:[...pending,e('STOP'),e('STOP_CONFIRMED'),e('RECONCILE'),e('RETURN')]},
 {name:'S08 reconciled free funds only',phase:'stopped',events:[...stopped,e('RECONCILE')]},
 {name:'S08 return pending not recovered',phase:'returnPending',events:returning},
 {name:'S08 return uncertain same request',phase:'returnPending',events:[...returning,e('RETURN_UNCERTAIN')]},
 {name:'S08 return confirmed results retained',phase:'closed',events:[...returning,e('RETURN_CONFIRMED')]},
 {name:'expiry existing pending retained',phase:'active',events:[...pending,e('EXPIRE')]},
 {name:'expiry new purchase refused',phase:'active',events:[...received,e('EXPIRE'),{type:'REQUEST',id:'DEMO-EXPIRED-06',recipient:'records',amount:100,content:'New purchase after expiry'}]},
]
afterEach(()=>vi.restoreAllMocks())
for(const row of scenarios){
 test(`model reset contract: ${row.name}`,()=>{
  const before=row.events.reduce(transition,createState());expect(before.phase).toBe(row.phase)
  const original=structuredClone(before)
  let fresh=transition(before,e('RESET'));expect(fresh).toEqual(createState());expect(before).toEqual(original)
  for(let i=0;i<3;i++)fresh=transition(fresh,e('RESET'))
  for(const event of [e('FUNDING_CONFIRMED'),e('FUNDING_FAILED'),e('PAID',r.id),e('DELIVER',r.id),e('STOP_CONFIRMED'),e('RETURN_CONFIRMED')])fresh=transition(fresh,event)
  expect(fresh).toEqual(createState())
  expect(ledger(fresh)).toEqual({spent:0,reserved:0,available:0,recovered:0})
  const restarted=[...active,r].reduce(transition,fresh)
  expect(restarted.orders).toEqual([{id:r.id,content:r.content,amount:800,recipient:'records',payment:'pending',delivery:'missing'}])
  expect(restarted.authorizationHistory).toHaveLength(1)
 })
 test(`mounted reset and replay: ${row.name}`,async()=>{
  let current:controller.SimulationController
  const original=controller.useSimulationController
  vi.spyOn(controller,'useSimulationController').mockImplementation(()=>{current=original();return current})
  const user=userEvent.setup();render(<SimulationApp/>)
  act(()=>{for(const event of row.events)current.dispatch(event)})
  expect(current!.state.phase).toBe(row.phase)
  await user.type(screen.getByLabelText('Your message'),'unsent composer')
  await user.click(screen.getByText('Demo controls',{exact:true}))
  await user.click(screen.getByRole('button',{name:'Reset demo'}))
  expect(current!.state).toEqual(createState())
  expect(screen.getByRole('heading',{level:1})).toHaveTextContent('New task')
  expect(screen.getByLabelText('Your message')).toHaveValue('')
  expect(screen.getByLabelText('Your message')).toHaveFocus()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByRole('region',{name:'Results and receipts'})).not.toBeInTheDocument()
  expect(screen.queryByRole('region',{name:'Activity'})).not.toBeInTheDocument()
  await user.click(screen.getByText('Demo controls',{exact:true}))
  await user.click(screen.getByRole('button',{name:'Open external proposal'}))
  expect(within(screen.getByRole('region',{name:'Spending review'})).getByRole('button',{name:'Authorize mandate'})).toBeEnabled()
  expect(current!.state.authorized).toBeNull()
 })
}

test('S03–S08 operation identities, uncertainty, two results and residual return remain distinct',()=>{
 const p=pending.reduce(transition,createState());expect(ledger(p)).toEqual({spent:0,reserved:800,available:2200,recovered:0})
 const s=twoReceived.reduce(transition,createState());expect(s.orders.map(o=>[o.id,o.amount,o.delivery])).toEqual([[r.id,800,'received'],[b.id,1500,'received']])
 expect(s.blocks.map(x=>[x.id,x.reason])).toEqual([[excluded.id,'Recipient not allowed'],[extra.id,'Insufficient budget']])
 const waiting=returning.reduce(transition,createState());expect(ledger(waiting).recovered).toBe(0)
 const closed=transition(waiting,e('RETURN_CONFIRMED'));expect(ledger(closed)).toEqual({spent:2300,reserved:0,available:0,recovered:700});expect(closed.orders).toEqual(s.orders)
})
