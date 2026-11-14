import { render,screen,within } from '@testing-library/react'
import { expect,test } from 'vitest'
import { createState,transition as go, type State } from '../src/demo/model'
import { Results } from '../src/demo/workspace'
const funding=()=>go(go(createState(),{type:'EXTERNAL'}),{type:'AUTHORIZE'})
function run(s:State,...events:Parameters<typeof go>[1][]) {return events.reduce(go,s)}
test('funding results have independent Not started source statuses, no pending result or partial brief',()=>{
 render(<Results state={funding()} dispatch={()=>{}}/>);
 expect(screen.getByText('Company records · Not started',{exact:true})).toBeVisible()
 expect(screen.getByText('Background research · Not started',{exact:true})).toBeVisible()
 expect(screen.queryByText(/Pending from/)).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'Open partial brief'})).not.toBeInTheDocument()
})
test('received evidence has partial preview and explicit receipt linkage while other source stays not started',()=>{
 const s=run(funding(),{type:'FUNDING_CONFIRMED'},{type:'REQUEST',id:'r',recipient:'records',amount:800,content:'Company records'},{type:'PAID',id:'r'},{type:'DELIVER',id:'r'})
 render(<Results state={s} dispatch={()=>{}}/>);
 expect(screen.getByText('Company records · Received',{exact:true})).toBeVisible()
 expect(screen.getByText('Background research · Not started',{exact:true})).toBeVisible()
 expect(screen.getByText(/Purchase reference · r/)).toBeVisible()
 expect(screen.getByText(/Available evidence preview · Partial, not final/)).toBeVisible()
 expect(screen.getByRole('button',{name:'Open partial brief'})).toBeVisible()
})
test('source statuses distinguish In progress and Blocked without overwriting another received source',()=>{
 const s=run(funding(),{type:'FUNDING_CONFIRMED'},{type:'REQUEST',id:'r',recipient:'records',amount:800,content:'Company records'},{type:'REQUEST',id:'b',recipient:'background',amount:4000,content:'Background research'})
 render(<Results state={s} dispatch={()=>{}}/>);
 expect(screen.getByText('Company records · In progress',{exact:true})).toBeVisible()
 expect(screen.getByText('Background research · Blocked',{exact:true})).toBeVisible()
 expect(within(screen.getByRole('article',{name:'Company records'})).getByText('Payment pending · Funds reserved · 8 TEST')).toBeVisible()
})
