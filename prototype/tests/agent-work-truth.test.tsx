import { test, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { createState, transition, defaultDraft, type State, type Event } from '../src/demo/model'
import SimulationApp from '../src/demo/simulation-app'
const fixture=vi.hoisted(()=>({state:null as unknown as State}))
vi.mock('@/integration/controller',()=>({useSimulationController:()=>({state:fixture.state,dispatch:()=>{}})}))
function active() { let s=createState(); for(const e of [{type:'EXTERNAL'},{type:'AUTHORIZE'},{type:'FUNDING_CONFIRMED'}])s=transition(s,e);return s }
function drive(s:State,...events:Event[]) {for(const e of events)s=transition(s,e);return s}
const request:Event={type:'REQUEST',id:'truth-records',recipient:'records',content:'Company records',amount:800}
test.each(['records','background'] as const)('only authorized %s evidence does not imply another source is pending',source=>{
 let s=transition(createState(),{type:'EXTERNAL'})
 s=drive(s,{type:'EDIT',draft:{...defaultDraft,records:source==='records',background:source==='background'}},{type:'REVIEW'},{type:'AUTHORIZE'},{type:'FUNDING_CONFIRMED'},
 {type:'REQUEST',id:'only-order',recipient:source,content:source==='records'?'Company records':'Background research',amount:800},{type:'PAID',id:'only-order'},{type:'DELIVER',id:'only-order'})
 expect(s.orders[0].delivery).toBe('received'); fixture.state=s;render(<SimulationApp />)
 const work=screen.getByRole('region',{name:'Agent work'})
 expect(work).toHaveTextContent('Review the available evidence · No final brief exists in this demo')
 expect(work).not.toHaveTextContent(/not started|No purchase started/)
})
test.each(['pending','uncertain','paid','failed'] as const)('prior %s operation survives stop and expiry without financial reinterpretation',payment=>{
 let s=drive(active(),request)
 if(payment!=='pending')s=transition(s,{type:payment==='uncertain'?'UNCERTAIN':payment==='paid'?'PAID':'FAILURE_CONFIRMED',id:request.id})
 for(const end of ['expiry','stop','return']) {
  let current=end==='expiry'?transition(s,{type:'EXPIRE'}):drive(s,{type:'STOP'},{type:'STOP_CONFIRMED'})
  if(end==='return' && (payment==='failed'||payment==='paid'))current=drive(current,{type:'RECONCILE'},{type:'RETURN'},{type:'RETURN_CONFIRMED'})
  fixture.state=current;render(<SimulationApp />)
  const panel=screen.getByRole('complementary',{name:'Working bar'})
  expect(panel).toHaveTextContent(payment==='pending'?'Payment pending':payment==='uncertain'?'Payment uncertain':payment==='paid'?'Paid · Delivery missing':'Payment failed')
  expect(screen.getByRole('region',{name:'Agent work'})).not.toHaveTextContent('No purchase started yet')
  expect(current.orders[0].id).toBe(request.id);expect(current.orders[0].payment).toBe(payment);cleanup()
 }
})
