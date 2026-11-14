/** Historical-only inverse for task-panel-refinement's A02/DetailA/A05 states.
 * Never used by current product assertions, screenshots, accessibility or financial checks.
 * Browser-serializable: all dependencies intentionally remain inside this function.
 */
export function reconcileTaskPanelHistoricalAgentWork(el: HTMLElement, input: {state: string; historical: string}) {
  if (!['A02', 'DetailA', 'A05'].includes(input.state)) throw new Error('Unreviewed historical state')
  const beforeHTML = el.outerHTML
  const active = input.state === 'A05'
  const historySpeaker = '.conversation-history > div[role="log"] > ol > li.assistant-message > span.agent-name'
  const resultSpeaker = '.conversation-content > article.result-notification > span.agent-name'
  const workSelector = '.conversation-content > section.agent-work[aria-label="Agent work"]'
  const title = active ? 'Your supplier check' : 'Preparing your proposal'
  const step = active ? 'Company records evidence received' : 'Request saved in this local draft'
  const current = active ? 'Background research not started' : 'Budget and expiry need your review'
  const notice = active ? 'Scripted simulation · Only observed local events are shown.' : 'No spending before your review and authorization.'
  function requireContract(ok: boolean, message: string): asserts ok {
    if (!ok) throw new Error(message)
  }
  function inverse(source: HTMLElement) {
    const clone = source.cloneNode(true) as HTMLElement
    const works = [...clone.querySelectorAll(workSelector)]
    requireContract(works.length === 1 && clone.querySelectorAll('.agent-work').length === 1, 'Expected exactly one direct AgentWork block')
    const work = works[0]
    // Read-only outerHTML below is evidence, never assigned/injected into a live DOM.
    // Exact node/attribute/text contract from AgentWork and SimulationAgentWork;
    // checking text alone would hide extra financial/status children during removal.
    const headingId = work.querySelector(':scope > h2')?.id
    requireContract(Boolean(headingId), 'AgentWork heading ID is absent')
    requireContract([...clone.querySelectorAll('[id]')].filter(e => e.id === headingId).length === 1, 'AgentWork heading ID is not unique')
    type Shape = string | {tag: string; attributes: [string, string][]; children: Shape[]}
    const node = (tag: string, attrs: Record<string, string>, children: Shape[]): Shape => ({tag, attributes: Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)), children})
    function shape(element: Node): Shape {
      if (element.nodeType === Node.TEXT_NODE) return element.textContent!
      requireContract(element instanceof Element, 'Unexpected AgentWork node type')
      return node(element.tagName.toLowerCase(), Object.fromEntries([...element.attributes].map(a => [a.name, a.value])), [...element.childNodes].map(shape))
    }
    const mark = (text: string) => node('span', {'class': 'agent-step-mark', 'aria-hidden': 'true'}, [text])
    const expected = node('section', {'aria-label': 'Agent work', 'class': 'agent-work', 'data-tone': 'neutral'}, [
      node('span', {'class': 'agent-name'}, ['Haldir']),
      node('h2', {'id': headingId!}, [title]),
      node('ol', {'class': 'agent-work-steps', 'aria-labelledby': headingId!}, [
        node('li', {}, [mark('✓'), node('span', {}, [step])]),
        node('li', {'class': 'agent-work-current'}, [mark('○'), node('p', {}, [current])]),
      ]),
      node('p', {'class': 'agent-work-notice'}, [notice]),
    ])
    requireContract(JSON.stringify(shape(work)) === JSON.stringify(expected), 'AgentWork differs from the exact reviewed state/node/content contract')
    const speakers = [...clone.querySelectorAll(historySpeaker), ...clone.querySelectorAll(resultSpeaker)]
    requireContract(clone.querySelectorAll(historySpeaker).length === (active ? 1 : 2), 'Historical speaker count changed')
    requireContract(clone.querySelectorAll(resultSpeaker).length === (active ? 1 : 0), 'Result speaker count changed')
    requireContract(clone.querySelectorAll('.agent-name').length === speakers.length + 1, 'Unexpected speaker node')
    for (const speaker of speakers) {
      requireContract(speaker.outerHTML === '<span class="agent-name">Haldir</span>', 'Speaker is not the exact additive Haldir span')
    }
    const additions = [
      ...speakers.map(s => ({kind: 'speaker', selector: s.parentElement!.className, text: s.textContent!, html: s.outerHTML, disposition: 'Exact additive Haldir span; remove only from detached historical comparison'})),
      {kind: 'AgentWork', selector: workSelector, text: work.textContent!, html: work.outerHTML, disposition: 'Exact source-defined additive work block; current truth separately asserted; remove only from detached historical comparison'},
    ]
    speakers.forEach(s => s.remove())
    work.remove()
    // Preserve the previously approved exact Task progress heading normalization.
    const headings = [...clone.querySelectorAll('.conversation-content > h2.sr-only')]
      .filter(h => h.textContent === 'Task progress')
    const headingHTML = headings.map(h => h.outerHTML)
    headings.forEach(h => h.remove())
    const copy = clone.textContent!
    // Preserve the previously approved history-label handling, unchanged.
    const normalizedText = copy.replace(/Earlier in this conversation · \d+ messages/, '')
    return {copy, normalizedText, normalizedCloneHTML: clone.outerHTML, headingCount: headings.length, headingHTML, additions}
  }
  function compare(source: HTMLElement) {
    const result = inverse(source)
    if (result.normalizedText !== input.historical) {
      let i = 0
      while (i < result.normalizedText.length && result.normalizedText[i] === input.historical[i]) i++
      throw new Error(`Residual historical content difference at ${i}: ${JSON.stringify({historical: input.historical.slice(i, i + 120), current: result.normalizedText.slice(i, i + 120)})}`)
    }
  }
  const result = inverse(el)
  const mutations: {name: string; apply: (root: HTMLElement) => void}[] = [
    {name: 'wrong work text', apply: root => {root.querySelector(workSelector + ' .agent-work-current p')!.textContent = 'All research completed; supplier verified'}},
    {name: 'extra work content', apply: root => {const p = document.createElement('p'); p.textContent = 'Unexpected receipt or financial claim'; root.querySelector(workSelector)!.append(p)}},
    {name: 'unexpected outside content', apply: root => {const p = document.createElement('p'); p.textContent = 'Unexpected conversation content'; root.querySelector('.conversation-content')!.append(p)}},
    {name: 'changed financial or authorization copy', apply: root => {
      if (active) {
        const p = root.querySelector('.result-notification > p')!
        requireContract(p.textContent!.includes('8 TEST'), 'Financial mutation precondition')
        p.textContent = p.textContent!.replace('8 TEST', '9 TEST')
      } else {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let node: Node | null
        let changed = false
        while ((node = walker.nextNode())) {
          if (node.textContent!.includes('Not authorized')) {node.textContent = node.textContent!.replace('Not authorized', 'Authorized'); changed = true; break}
        }
        requireContract(changed, 'Authorization mutation precondition')
      }
    }},
    {name: 'wrong speaker label', apply: root => {root.querySelector(historySpeaker)!.textContent = 'Unexpected speaker'}},
    {name: 'duplicate work block', apply: root => {const work = root.querySelector(workSelector)!; work.after(work.cloneNode(true))}},
    {name: 'unexpected work attribute', apply: root => {root.querySelector(workSelector)!.setAttribute('data-unreviewed', 'true')}},
  ]
  const negativeControls = mutations.map(mutation => {
    const root = el.cloneNode(true) as HTMLElement
    mutation.apply(root)
    try { compare(root); return {name: mutation.name, rejected: false, error: 'Mutation was hidden by the adapter'} }
    catch (error) { return {name: mutation.name, rejected: true, error: error instanceof Error ? error.message : String(error)} }
  })
  return {
    ...result, rawCurrentText: el.textContent!, rawCurrentHTML: beforeHTML, historicalText: input.historical,
    expectedLiveWork: {title, step, current, notice},
    historyLabelDisposition: 'Previously approved /Earlier in this conversation · \\d+ messages/ removal from comparison string only',
    headingDisposition: 'Previously approved exact .conversation-content > h2.sr-only with text Task progress; comparison clone only',
    negativeControls, liveUnchanged: el.outerHTML === beforeHTML,
  }
}
