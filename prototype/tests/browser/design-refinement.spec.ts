import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
const stream = (page: Page) => page.locator('.conversation-stream')
const conversation = (page: Page) => page.getByRole('region', {name:'Conversation', exact:true})
async function control(page: Page, name: string) {
 const d=page.locator('.demo-controls'); await d.evaluate(el => (el as HTMLDetailsElement).open=true)
 await d.getByRole('button',{name,exact:true}).click()
 await d.evaluate(el => (el as HTMLDetailsElement).open=false)
 await page.evaluate(()=>window.scrollTo(0,0))
}
async function review(page: Page) {
 await page.goto('/demo')
 await page.getByRole('textbox', { name: 'Your message' }).fill('budget 30; expiry 2026-11-12T18:00')
 await page.getByRole('textbox', { name: 'Your message' }).press('Enter')
 await expect(page.getByRole('heading',{name:'Proposed spending mandate',exact:true})).toBeVisible()
 await page.evaluate(()=>document.fonts.ready)
}
async function working(page: Page) {
 await review(page)
 await page.getByRole('button',{name:'Authorize mandate'}).click()
 await control(page,'Confirm funding'); await control(page,'S03 · Deliver company records')
 await stream(page).evaluate(el=>el.scrollTop=0)
}
test('conversational entry has no shortcut and fields separate default stroke from focus',async ({page})=>{
 await page.setViewportSize({width:1440,height:1000}); await page.goto('/demo')
 await expect(page.getByRole('button',{name:'Shape this job'})).toHaveCount(0)
 const field=page.getByRole('textbox',{name:'Your message'})
 expect(await field.evaluate(el=>getComputedStyle(el).borderTopColor)).not.toBe('rgb(23, 61, 50)')
 await field.focus()
 await expect.poll(()=>field.evaluate(el=>getComputedStyle(el).outlineColor)).toBe('rgb(23, 61, 50)')
})

test('blocked event retains live semantics with one warning surface',async ({page})=>{
 await page.setViewportSize({width:1440,height:1000}); await working(page)
 await control(page,'S04 · Excluded recipient request')
 const note=conversation(page).getByRole('status')
 await expect(note).toHaveText(/Recipient not allowed/)
 await expect.poll(()=>note.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
 await expect(note).toHaveAttribute('aria-live','polite')
 // Approved inline work response retains warning meaning without the old filled card.
 await expect(page.locator('.agent-work[data-tone="warning"]')).toHaveCSS('background-color','rgba(0, 0, 0, 0)')
 await expect(page.locator('.agent-work[data-tone="warning"] .agent-work-current')).toHaveCSS('color','rgb(133, 90, 19)')
 const next=conversation(page).getByRole('button',{name:'Continue without this purchase'})
 // Approved installed primitive: desktop 32px; mobile targets remain 44px below.
 expect((await next.boundingBox())!.height).toBe(32)
 await next.click()
 await expect(page.locator('.agent-work[data-tone="warning"]')).toHaveCount(0)
 await expect(conversation(page).getByText(/Paid · Evidence received/)).toBeVisible()
})

test('spending boundary never overlays results or blocked recovery controls',async ({page})=>{
 await page.setViewportSize({width:1440,height:1000}); await working(page)
 const actions=conversation(page).locator('.spending-actions')
 const frame=(await stream(page).boundingBox())!, footer=(await actions.boundingBox())!
 expect(frame.y+frame.height).toBeLessThanOrEqual(footer.y)
 await control(page,'S04 · Excluded recipient request')
 const next=conversation(page).getByRole('button',{name:'Continue without this purchase'})
 await next.scrollIntoViewIfNeeded()
 const b=(await next.boundingBox())!, f=(await actions.boundingBox())!
 expect(b.y+b.height+5).toBeLessThanOrEqual(f.y)
})

test.beforeEach(async ({page})=>{
 await page.route('**/*',r=>new URL(r.request().url()).origin === new URL(test.info().project.use.baseURL!).origin?r.continue():r.abort())
})
for (const width of [1440,768,390,320]) {
 test(`Stop remains fully visible at stream boundaries and keyboard reachable at ${width}`,async ({page})=>{
  await page.setViewportSize({width,height:width===768?1024:844})
  if(width===1440) await page.setViewportSize({width,height:1000})
  await working(page)
  const stop=conversation(page).getByRole('button',{name:'Stop new spending',exact:true})
  if(width<760) expect((await stop.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  const frame=(await stream(page).boundingBox())!
  const composer=(await page.locator('.composer').boundingBox())!
  for(const fraction of [0,0.25,0.5,1]) {
   await stream(page).evaluate((el,f)=>el.scrollTop=f*(el.scrollHeight-el.clientHeight),fraction)
   const b=(await stop.boundingBox())!
   expect(b.y).toBeGreaterThanOrEqual(frame.y+frame.height)
   expect(b.y+b.height).toBeLessThanOrEqual(composer.y-5)
   expect((await page.locator('.composer').boundingBox())!.y).toBe(composer.y)
  }
  await stream(page).focus()
  await page.keyboard.press('End')
  for(let n=0;n<12 && !(await stop.evaluate(el=>el===document.activeElement));n++) await page.keyboard.press('Tab')
  await expect(stop).toBeFocused()
  expect(await stop.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('solid')
  await expect(page.getByText('Requests a stop, then waits for confirmation. Existing payments are not cancelled.',{exact:true}).first()).toBeVisible()
  await stop.press('Enter')
  await expect(conversation(page).getByText('Waiting for stop confirmation. New spending is not yet confirmed disabled.',{exact:true})).toBeVisible()
 })
}
for (const width of [1440,768,390,320]) {
 test(`review action pair has exactly equal rendered heights at ${width}`,async ({page})=>{
  await page.setViewportSize({width,height:1000}); await review(page)
  const primary=page.getByRole('button',{name:'Authorize mandate'})
  const edit=conversation(page).getByRole('button',{name:'Edit details',exact:true})
  const a=(await primary.boundingBox())!,b=(await edit.boundingBox())!
  expect(b.height).toBe(a.height)
  expect(b.height).toBe(width<760 ? 44 : 32)
  if(b.y===a.y) expect(b.x-a.x-a.width).toBe(12)
  else expect(b.y-a.y-a.height).toBe(12)
  await edit.click()
  const editor=page.getByRole('region',{name:'Edit draft details',exact:true})
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('textbox',{name:'Your message'})).toBeEnabled()
  await editor.getByRole('button',{name:'Cancel',exact:true}).click()
  const panelEdit=page.getByRole('complementary',{name:'Working bar'}).getByRole('button',{name:'Edit details',exact:true})
  await expect(panelEdit).toBeFocused()
  await edit.click(); await editor.getByRole('button',{name:'Save draft',exact:true}).click()
  // Gaia G2: Save updates the shared draft without authorizing or requiring chat.
  await expect(conversation(page).getByText('Your job draft · Not authorized. The task panel holds the same draft; keep chatting to complete it.',{exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'Authorize mandate'})).toHaveCount(0)
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([])
 })
}
