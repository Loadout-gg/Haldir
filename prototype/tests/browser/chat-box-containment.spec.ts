import { test, expect, type Page } from '@playwright/test'

async function containment(page: Page) {
  // Let React's post-close focus RAF and Chrome layout settle before measuring.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const measured = await page.locator('.restoration > .conversation').evaluate(shell => {
    const style = getComputedStyle(shell), box = shell.getBoundingClientRect()
    return { fill: style.backgroundColor, radius: style.borderRadius, padding: style.padding,
      descendants: ['.conversation-stream', '.conversation-content', '.composer-area', '.composer-limit', '.conversation-spending-actions'].flatMap(selector => {
        const element = shell.querySelector(selector)
        if (!element) return []
        const r = element.getBoundingClientRect()
        return [{ selector, shell: box.toJSON(), child: r.toJSON(), contained: r.left >= box.left && r.right <= box.right + 1 && (selector === '.conversation-content' || (r.top >= box.top && r.bottom <= box.bottom + 1)) }]
      }) }
  })
  expect(measured.fill).toBe('rgb(255, 255, 255)')
  expect(measured.radius).toBe('0px')
  for (const child of measured.descendants) expect(child.contained, JSON.stringify(child)).toBe(true)
  const panel = page.locator('.restoration > aside')
  const chrome = await panel.evaluate(e => { const s=getComputedStyle(e);return {fill:s.backgroundColor,border:s.borderLeftWidth,shadow:s.boxShadow} })
  expect(chrome).toEqual({fill:'rgb(249, 251, 248)',border:'1px',shadow:'none'})
  await expect(panel).toHaveCSS('overflow-y','auto')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

for (const width of [1440,768,390,320]) test(`continuous chat shell and unboxed task panel at ${width}`, async ({page,baseURL}) => {
  await page.setViewportSize({width,height:width>760?1000:844})
  await page.route('**/*',r=>new URL(r.request().url()).origin===new URL(baseURL!).origin&&!new URL(r.request().url()).pathname.startsWith('/api/')?r.continue():r.abort())
  await page.goto('/demo')
  await containment(page)
  await page.getByLabel('Your message').fill('Check Northwind Print before I sign. I need a short brief with the evidence.')
  await page.getByRole('button',{name:'Send message'}).click()
  await page.getByRole('region',{name:'Conversation',exact:true}).getByRole('button',{name:'Edit details',exact:true}).click()
  if (width <= 760) await page.getByRole('log').getByText('What would you like to get done?',{exact:true}).scrollIntoViewIfNeeded()
  await expect(page.getByRole('log').getByText('What would you like to get done?',{exact:true})).toBeInViewport()
  await expect(page.getByLabel('Your message')).toBeInViewport()
  await containment(page)
  const editor=page.getByRole('region',{name:'Edit draft details'})
  await editor.getByRole('button',{name:'Cancel',exact:true}).click()
  if(width<=760) await page.getByRole('button',{name:'Hide panel'}).click()
  await page.getByLabel('Your message').fill('budget 30; expiry 2026-11-12T18:00')
  await page.getByRole('button',{name:'Send message'}).click()
  await containment(page)
  const review=page.getByRole('region',{name:'Spending review'})
  for(const name of ['Company records source','Background research source']) await review.getByRole('group',{name,exact:true}).getByText('Details',{exact:true}).click()
  await review.getByText('How this limit is enforced',{exact:true}).click()
  await review.locator('summary').filter({hasText:/^Spending permissions and costs$/}).click()
  const stream=page.locator('.conversation-stream')
  expect(await stream.evaluate(e=>e.scrollHeight>e.clientHeight)).toBe(true)
  await page.getByRole('button',{name:'Authorize mandate',exact:true}).click()
  for(const fraction of [0,0.5,1]) {
    await stream.evaluate((e,f)=>e.scrollTop=(e.scrollHeight-e.clientHeight)*f,fraction)
    await expect(page.locator('.conversation-spending-actions').getByRole('button',{name:'Stop new spending'})).toBeInViewport()
    await expect(page.getByLabel('Your message')).toBeInViewport()
    await containment(page)
  }
  await page.locator('.conversation-spending-actions').getByRole('button',{name:'Stop new spending'}).click()
  await page.getByText('Demo controls',{exact:true}).click()
  await page.getByRole('button',{name:'Confirm funding',exact:true}).click()
  await expect(page.getByRole('button',{name:'S03 · Deliver company records'})).toBeDisabled()
  await page.evaluate(()=>window.scrollTo(0,0))
  await containment(page)
  await page.getByRole('button',{name:'Reset demo'}).click()
  await page.getByRole('button',{name:'Open external proposal'}).click()
  await page.getByRole('button',{name:'Authorize mandate',exact:true}).click()
  await page.getByRole('button',{name:'Confirm funding',exact:true}).click()
  if(width<=760) {
    await page.getByRole('button',{name:'S03 · Deliver company records'}).click()
    await page.getByRole('button',{name:'S04 · Excluded recipient request'}).click()
    await page.getByRole('region',{name:'Conversation',exact:true}).getByRole('button',{name:'View details',exact:true}).click()
    await page.evaluate(()=>window.scrollTo(0,0))
    const working=page.getByRole('complementary',{name:'Working bar',exact:true})
    await working.getByRole('button',{name:'Continue without this purchase'}).click()
    await working.getByRole('region',{name:'Activity'}).getByRole('button',{name:'View details'}).click()
    await containment(page)
    const panelBox=await page.locator('.restoration-panel').boundingBox()
    const stopBox=await page.locator('.conversation-spending-actions').getByRole('button',{name:'Stop new spending'}).boundingBox()
    expect(panelBox!.y+panelBox!.height).toBeLessThanOrEqual(stopBox!.y-4)
  }
})
