import { useState } from 'react'
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { ReactNode } from 'react'
import { Dialog, DialogTrigger } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { initialReference } from '@/data/initial-reference'

export function ContextTrigger({ children, className, variant = 'outline', notes = [], presentation }: { children: ReactNode; className?: string; variant?: 'outline' | 'brand-dark'; notes?: string[]; presentation?: 'demo' }) {
  return <Dialog>
    <DialogTrigger render={<Button variant={variant} className={className} />}>{children}</DialogTrigger>
    <ReferenceContext notes={notes} presentation={presentation} />
  </Dialog>
}

export function ReferenceContext({ notes = [], presentation }: { notes?: string[]; presentation?: 'demo' }) {
  const [search, setSearch] = useState('')
  const messages = initialReference.messages.filter(message => message.subject.toLowerCase().includes(search.trim().toLowerCase()))
  return <DialogContent className="context-dialog">
    <DialogHeader>
      <DialogTitle>Selected email thread</DialogTitle>
      <DialogDescription>Three fictional messages for this preview. No real email is connected.</DialogDescription>
    </DialogHeader>
    <div className="context-search">
      <label htmlFor="context-search">Find a message</label>
      <Input id="context-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by subject" />
    </div>
    <p>Linked to the original request and this job draft. Context is not spending permission.</p>
    {notes.map((note,i) => <article key={i} className="context-message"><h3>Local context note {i+1}</h3><p>{note}</p></article>)}
    {messages.length ? messages.map(message => <article key={message.id} className="context-message">
      <h3>{message.subject}</h3><p>{presentation === 'demo' && message.id === 'email-reply-2' ? 'Example of the latest reply in this thread. This email does not show whether any purchase or delivery has completed.' : message.body}</p>
    </article>) : <p role="status">No messages match. Try another search.</p>}
  </DialogContent>
}
