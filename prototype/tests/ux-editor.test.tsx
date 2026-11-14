import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import App from '../src/demo/simulation-app'

async function draft() { const user=userEvent.setup(); render(<App/>); await user.type(screen.getByRole('textbox',{name:'Your message'}),'Check Northwind Print before I sign. I need a short brief with the evidence.'); await user.click(screen.getByRole('button',{name:'Send message'})); return user }
test('conversation stays visible; both Edit details entries open the same right-panel editor; Save confirms without new message',async()=>{
 const user=await draft()
 expect(screen.getByRole('log',{name:'Conversation history'})).toHaveTextContent('What would you like to get done?')
 expect(within(screen.getByRole('region',{name:'Conversation'})).getAllByText(/What budget and expiry should I use/)).toHaveLength(1)
 const entries=screen.getAllByRole('button',{name:'Edit details'});expect(entries).toHaveLength(2)
 await user.click(entries[0]);expect(screen.queryByRole('dialog',{name:/Edit/})).not.toBeInTheDocument()
 let editor=screen.getByRole('region',{name:'Edit draft details'})
 expect(within(editor).getByText('From your request',{exact:true})).toBeVisible()
 expect(within(editor).getByText('Proposed by agent · Based on your request; includes purchase receipts',{exact:true})).toBeVisible()
 expect(within(editor).getByText(/Proposed by agent · Needs review/)).toBeVisible()
 expect(within(editor).getByText(/Recipients need review before authorization/)).toBeVisible()
 await user.type(within(editor).getByLabelText('Purchase budget (TEST)'),'30')
 await user.type(screen.getByRole('textbox',{name:'Your message'}),'expiry 2026-11-12T18:00');await user.click(screen.getByRole('button',{name:'Send message'}))
 expect(within(editor).getByLabelText('Permission expiry (UTC)')).toHaveValue('2026-11-12T18:00')
 const count=within(screen.getByRole('log')).getAllByRole('listitem').length
 await user.click(within(editor).getByRole('button',{name:'Save draft'}))
 expect(screen.getByRole('status')).toHaveTextContent(/Draft updated/)
 expect(within(screen.getByRole('log')).getAllByRole('listitem')).toHaveLength(count)
 await user.click(within(screen.getByRole('complementary',{name:'Working bar'})).getByRole('button',{name:'Edit details'}))
 editor=screen.getByRole('region',{name:'Edit draft details'})
 expect(within(editor).getByLabelText('Purchase budget (TEST)')).toHaveValue('30')
})
test('Back and Cancel require explicit discard; same-field chat conflict cannot silently overwrite',async()=>{
 const user=await draft();await user.click(screen.getAllByRole('button',{name:'Edit details'})[0])
 const editor=screen.getByRole('region',{name:'Edit draft details'})
 await user.type(within(editor).getByLabelText('Purchase budget (TEST)'),'40')
 await user.click(within(editor).getByRole('button',{name:'Back to summary'}))
 expect(within(editor).getByRole('alert')).toHaveTextContent('Unsaved changes')
 await user.click(within(editor).getByRole('button',{name:'Keep editing'}))
 await user.type(screen.getByLabelText('Your message'),'budget 20');await user.click(screen.getByRole('button',{name:'Send message'}))
 expect(within(editor).getByRole('button',{name:'Save draft'})).toBeDisabled()
 await user.click(within(editor).getByRole('button',{name:'Use latest chat values'}))
 expect(within(editor).getByLabelText('Purchase budget (TEST)')).toHaveValue('20')
 await user.clear(within(editor).getByLabelText('Job'));await user.type(within(editor).getByLabelText('Job'),'Unsaved job')
 await user.click(within(editor).getByRole('button',{name:'Cancel'}))
 await user.click(within(editor).getByRole('button',{name:'Discard changes'}))
 expect(screen.queryByRole('region',{name:'Edit draft details'})).not.toBeInTheDocument()
 expect(within(screen.getByRole('complementary',{name:'Working bar'})).queryByText('Unsaved job')).not.toBeInTheDocument()
})
