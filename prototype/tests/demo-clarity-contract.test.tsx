import '@testing-library/jest-dom/vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import SimulationApp from '../src/demo/simulation-app'

test('JUDGE-F01 funding failure is consistent across summary spending and collapsed rail and retries the same authorization',async()=>{
 const current=mount([]);const user=userEvent.setup()
 await user.type(screen.getByLabelText('Your message'),'budget 30; expiry 2026-11-12T18:00')
 await user.click(screen.getByRole('button',{name:'Send message'}))
 await user.click(screen.getByRole('button',{name:'Authorize mandate'}))
 const auth=structuredClone(current().state.authorized)
 await user.click(screen.getByText('Demo controls',{exact:true}))
 await user.click(screen.getByRole('button',{name:'Fail funding'}))
 expect(screen.getByRole('region',{name:'Task summary'})).toHaveTextContent('Authorized · Funding failed')
 const spending=within(screen.getByRole('complementary',{name:'Working bar'})).getByRole('region',{name:'Spending'})
 expect(spending).toHaveTextContent('Available: Funding failed');expect(spending).not.toHaveTextContent('Funding pending')
 await user.click(screen.getByRole('button',{name:'Hide panel'}))
 expect(screen.getByRole('complementary',{name:'Collapsed task panel'})).toHaveTextContent('Funding failed')
 expect(screen.getByRole('complementary',{name:'Collapsed task panel'})).not.toHaveTextContent('Funding pending')
 expect(current().state.funded).toBe(0);expect(current().state.orders).toEqual([])
 await user.click(screen.getByRole('button',{name:'Retry funding request'}))
 expect(current().state.authorized).toEqual(auth);expect(current().state.authorizationHistory).toHaveLength(1)
 expect(current().state.fundingError).toBe(false);expect(current().state.funded).toBe(0)
 await user.click(screen.getByRole('button',{name:'Confirm funding'}))
 expect(current().state.authorized).toEqual(auth);expect(current().state.funded).toBe(3000)
})
test('JUDGE-F02 waiting work points to the existing scripted outcome controls',()=>{
 mount(active)
 expect(screen.getByRole('region',{name:'Conversation'})).toHaveTextContent('Open Demo controls below to choose the next scripted outcome. Nothing advances automatically.')
})
test('JUDGE-F03 helper explains separate bounded input rather than free-form parsing',()=>{
 mount([])
 expect(screen.getByText(/Send your task first, then send/)).toHaveTextContent('as a separate message')
})
import * as controllers from '../src/integration/controller'
import { createState, ledger, transition, type Event } from '../src/demo/model'
import { Editor, Results } from '../src/demo/workspace'
const e=(type:string,id?:string):Event=>({type,id})
const active=[e('EXTERNAL'),e('AUTHORIZE'),e('FUNDING_CONFIRMED')]
const request:Event={type:'REQUEST',id:'DEMO-RECORDS-01',amount:800,recipient:'records',content:'Company records'}
afterEach(()=>vi.restoreAllMocks())
function mount(events:Event[]){let current:controllers.SimulationController;const original=controllers.useSimulationController;vi.spyOn(controllers,'useSimulationController').mockImplementation(()=>{current=original();return current});render(<SimulationApp/>);act(()=>events.forEach(event=>current.dispatch(event)));return()=>current!}
test('demo explicitly discloses no live AI or funds and never claims a connected real mailbox',()=>{
 mount([])
 expect(screen.getByRole('region',{name:'Preview notice'})).toHaveTextContent('No live AI calls, real email or real funds')
 expect(screen.getByRole('region',{name:'Preview notice'})).toHaveTextContent('Open Demo controls below to advance or reset the simulation.')
 expect(screen.queryByText(/Email connected|From your email/)).not.toBeInTheDocument()
 expect(screen.getAllByText(/Example email thread/).length).toBeGreaterThan(0)
 expect(screen.getByText(/Use these controls to choose simulated funding, payment and delivery outcomes/)).toBeInTheDocument()
})
test('a failed payment is not relabeled as a pre-payment block',()=>{
 const state=[...active,request,e('FAILURE_CONFIRMED',request.id)].reduce(transition,createState());render(<Results state={state} dispatch={()=>{}} panel/>)
 expect(document.querySelector('.source-statuses')).toHaveTextContent('Company records · Payment failed')
 expect(state.blocks).toEqual([]);expect(ledger(state)).toEqual({spent:0,reserved:0,available:3000,recovered:0})
})
test('expired active permissions display expired in summary conversation and collapsed rail',async()=>{
 const current=mount([...active,e('EXPIRE')]);const user=userEvent.setup()
 expect(within(screen.getByRole('region',{name:'Task summary'})).getByText('Permission expired')).toBeVisible()
 expect(screen.getByRole('region',{name:'Conversation'})).not.toHaveTextContent('Work in progress')
 await user.click(screen.getByRole('button',{name:'Hide panel'}))
 expect(screen.getByRole('complementary',{name:'Collapsed task panel'})).toHaveTextContent('Permission expired')
 expect(current().state.phase).toBe('active');expect(current().state.expired).toBe(true)
})
for(const type of ['stopRequested','stopped','returnPending','closed'])test(`expired display does not override ${type}`,()=>{
 const events=[...active,e('EXPIRE'),e('STOP')];if(type!=='stopRequested')events.push(e('STOP_CONFIRMED'));if(['returnPending','closed'].includes(type))events.push(e('RECONCILE'),e('RETURN'));if(type==='closed')events.push(e('RETURN_CONFIRMED'))
 const current=mount(events);expect(current().state.phase).toBe(type)
 expect(screen.getByRole('region',{name:'Task summary'})).not.toHaveTextContent('Permission expired')
})
test('paid missing evidence receipt is a purchase reference, not received evidence',async()=>{
 mount([...active,request,e('PAID',request.id)]);const user=userEvent.setup()
 await user.click(within(screen.getByRole('complementary',{name:'Working bar'})).getByRole('button',{name:/Open.*receipt/}))
 const dialog=screen.getByRole('dialog',{name:'Company records receipt'})
 expect(dialog).toHaveTextContent('Purchase reference · DEMO-RECORDS-01')
 expect(dialog).not.toHaveTextContent('Receipt linked to evidence')
 expect(dialog).toHaveTextContent('Evidence is not yet received')
})
test('return action explicitly requests confirmation without marking funds returned',async()=>{
 const current=mount([...active,e('STOP'),e('STOP_CONFIRMED'),e('RECONCILE')]);const user=userEvent.setup()
 await user.click(within(screen.getByRole('region',{name:'Conversation'})).getByRole('button',{name:'Request return of 30 TEST'}))
 expect(current().state.phase).toBe('returnPending');expect(current().state.recovered).toBe(0)
 expect(screen.getByRole('region',{name:'Conversation'})).toHaveTextContent('Funds are not yet marked returned')
})
test('amendment editor truthfully describes a separate proposal rather than the chat draft',()=>{
 const state=[...active,e('PROPOSE_CHANGE')].reduce(transition,createState());render(<Editor state={state} amendment dispatch={()=>{}}/>)
 expect(screen.getByRole('region',{name:'Edit draft details'})).toHaveTextContent('separate permission proposal')
 expect(screen.getByRole('region',{name:'Edit draft details'})).not.toHaveTextContent('Edits here and in chat update one draft')
})
