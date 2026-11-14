import '@testing-library/jest-dom/vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'

// Reset is the only new-task/restart action; it must leave a usable keyboard entry.
import SimulationApp from '../src/demo/simulation-app'
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})

test('reset clears the previous context reader search',async()=>{
 const user=userEvent.setup();render(<SimulationApp/>)
 await user.click(screen.getByRole('button',{name:'View context'}))
 await user.type(screen.getByLabelText('Find a message'),'no matches in old task')
 await user.keyboard('{Escape}')
 await reset(user)
 await user.click(screen.getByRole('button',{name:'View context'}))
 expect(screen.getByLabelText('Find a message')).toHaveValue('')
})

async function reset(user: ReturnType<typeof userEvent.setup>) {
 const controls=screen.getByText('Demo controls',{exact:true})
 if(!controls.closest('details')!.open) await user.click(controls)
 await user.click(screen.getByRole('button',{name:'Reset demo'}))
}

test('reset discards an unsent local context note, including after the context reader is dismissed', async()=>{
 const user=userEvent.setup(); render(<SimulationApp/>)
 await user.click(screen.getByRole('button',{name:'Add context'}))
 await user.type(screen.getByLabelText('Context note'),'Unsent note from the previous task')
 await user.keyboard('{Escape}')
 await reset(user)
 await user.click(screen.getByRole('button',{name:'Add context'}))
 expect(within(screen.getByRole('dialog',{name:'Add local context'})).getByLabelText('Context note')).toHaveValue('')
})

test('reset restores keyboard focus to the new task composer on every replay',async()=>{
 const user=userEvent.setup(); render(<SimulationApp/>)
 for(let i=0;i<3;i++){
  await user.type(screen.getByLabelText('Your message'),'Unsent draft')
  await reset(user)
  expect(screen.getByLabelText('Your message')).toHaveFocus()
  expect(screen.getByLabelText('Your message')).toHaveValue('')
 }
})

test('reset retires a pending panel focus callback instead of focusing the next task rail',async()=>{
 vi.stubGlobal('innerWidth',390)
 const frames=new Map<number,FrameRequestCallback>();let id=0
 vi.spyOn(window,'requestAnimationFrame').mockImplementation(cb=>{frames.set(++id,cb);return id})
 vi.spyOn(window,'cancelAnimationFrame').mockImplementation(n=>{frames.delete(n)})
 const user=userEvent.setup();render(<SimulationApp/>)
 await user.click(screen.getByRole('button',{name:'Task panel'}))
 await user.click(screen.getByRole('button',{name:'Hide panel'}))
 expect(frames.size).toBe(1)
 await reset(user)
 act(()=>{for(const cb of frames.values())cb(16)})
 expect(screen.getByLabelText('Your message')).toHaveFocus()
 expect(frames.size).toBe(0)
})

test.each(['Cancel','Save draft','Discard changes'])('amendment editor returns focus to Edit proposed terms after %s',async(action)=>{
 const user=userEvent.setup();render(<SimulationApp/>)
 await user.click(screen.getByText('Demo controls',{exact:true}))
 for(const name of ['Open external proposal','Authorize mandate','Confirm funding'])await user.click(screen.getByRole('button',{name}))
 const panel=screen.getByRole('complementary',{name:'Working bar'})
 await user.click(within(panel).getByRole('button',{name:'Request mandate change'}))
 await user.click(within(panel).getByRole('button',{name:'Edit proposed terms'}))
 const editor=screen.getByRole('region',{name:'Edit draft details'})
 if(action==='Discard changes'){
  await user.type(within(editor).getByLabelText('Job'),' unsaved')
  await user.click(within(editor).getByRole('button',{name:'Cancel'}))
 }
 await user.click(within(editor).getByRole('button',{name:action}))
 await waitFor(()=>expect(within(panel).getByRole('button',{name:'Edit proposed terms'})).toHaveFocus())
})
