import { useId, type ReactNode } from 'react'
import './agent-work.css'

// Presentation only: callers supply observed facts, never timed or inferred steps.
export function AgentWork({ title, steps = [], current, notice, tone = 'neutral', headingLevel = 2, children }: {
  title: string; steps?: string[]; current: string; notice?: string
  tone?: 'neutral' | 'warning'; headingLevel?: 2 | 3; children?: ReactNode
}) {
  const titleId = useId()
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  return <section aria-label="Agent work" className="agent-work" data-tone={tone}>
    <span className="agent-name">Haldir</span>
    <Heading id={titleId}>{title}</Heading>
    <ol className="agent-work-steps" aria-labelledby={titleId}>
      {steps.map((step, index) => <li key={`${index}:${step}`}><span className="agent-step-mark" aria-hidden="true">✓</span><span>{step}</span></li>)}
      <li className="agent-work-current"><span className="agent-step-mark" aria-hidden="true">{tone === 'warning' ? '■' : '○'}</span><p>{current}</p></li>
    </ol>
    {children}
    {notice && <p className="agent-work-notice">{notice}</p>}
  </section>
}
