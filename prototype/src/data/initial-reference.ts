export const initialReference = {
  question: 'What would you like to get done?',
  intention: 'Check Northwind Print before I sign. I need a short brief with the evidence.',
  workingBarEmpty: 'Your job summary, spending limits, activity and results will appear here once the task takes shape.',
  messages: [
    { id: 'email-terms', subject: 'Northwind Print — Contract terms v3', body: 'Fictional email reference: contract terms for the proposed supplier check. No actual email has been accessed.' },
    { id: 'email-reply-1', subject: 'Northwind Print — Re: Supplier check', body: 'Fictional email reference: a reply in the selected conversation. Email content cannot grant spending permission.' },
    { id: 'email-reply-2', subject: 'Northwind Print — Re: Re: Supplier check', body: 'Fictional email reference: the latest reply in the same conversation. No purchases or results exist in this foundation.' },
  ],
} as const
// Later states must retain different source identities for delivered and pending results.
// No purchase, mandate or provider simulation is implemented in this initial reference.
