import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { writeFileSync } from 'node:fs'
const evidence = process.env.HALDIR_EVIDENCE_DIR!
async function draft(page: Page) {
  await page.goto('/demo')
  await page.getByRole('textbox', { name: 'Your message' }).fill('budget 30; expiry 2026-11-12T18:00')
  await page.getByRole('textbox', { name: 'Your message' }).press('Enter')
}
async function review(page: Page) {
  await draft(page)
  await expect(page.getByRole('heading', { name: 'Proposed spending mandate', exact:true })).toBeVisible()
}
test.beforeEach(async ({page}) => {
  await page.route('**/*', r => new URL(r.request().url()).origin === new URL(test.info().project.use.baseURL!).origin ? r.continue() : r.abort())
})
for (const width of [1440, 768, 390, 320]) {
  test(`native review defaults and equal primary/secondary controls at ${width}`, async ({page}) => {
    await page.setViewportSize({width, height:1000})
    await review(page)
    const surface = page.getByRole('region', {name:'Spending review'})
    const primary = surface.getByRole('button', {name:'Authorize mandate'})
    const edit = surface.getByRole('button', {name:'Edit details',exact:true})
    const styles = await surface.locator('button').evaluateAll(els => els.map(el => {
      const s = getComputedStyle(el)
      return {height:el.getBoundingClientRect().height, font:s.fontSize, weight:s.fontWeight, padding:s.paddingInline, bg:s.backgroundImage, family:s.fontFamily, radius:s.borderRadius, shadow:s.boxShadow}
    }))
    expect(styles.map(s=>s.height)).toEqual([width < 760 ? 44 : 32, width < 760 ? 44 : 32, width < 760 ? 44 : 32])
    for (const s of styles) {
      expect(s).toMatchObject({font:'14px', weight:'500', padding:'10px', bg:'none', radius:'10px'})
      expect(s.family).not.toContain('Manrope')
      expect(s.shadow).not.toMatch(/24px|inset/)
    }
    expect(await surface.locator('.surface-title').evaluate(el=>getComputedStyle(el).fontWeight)).toBe('600')
    expect(await surface.locator('[data-slot="card"]').evaluate(el=>getComputedStyle(el).backgroundImage)).toBe('none')
    await edit.click()
    const editor = page.getByRole('region', {name:'Edit draft details',exact:true})
    await expect(editor).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const field=page.getByRole('textbox',{name:'Your message'})
    await field.focus(); await expect(field).toBeFocused()
    await page.keyboard.press('Tab'); await expect(page.getByRole('button',{name:'Add context',exact:true})).toBeFocused()
    await editor.getByRole('button',{name:'Back to summary',exact:true}).click()
    await expect(page.getByRole('complementary',{name:'Working bar'}).getByRole('button',{name:'Edit details',exact:true})).toBeFocused()
    await primary.scrollIntoViewIfNeeded()
    await primary.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab')
    await expect(primary).toBeFocused()
    expect(await primary.evaluate(el=>getComputedStyle(el).boxShadow)).not.toBe('none')
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    expect((await new AxeBuilder({page}).analyze()).violations).toEqual([])
    writeFileSync(`${evidence}/native-review-${width}.json`, JSON.stringify(styles,null,2))
    await primary.click()
    await expect(page.getByRole('heading', {name:'Authorization confirmed · Funding pending',exact:true,level:3})).toBeVisible()
    await expect(page.getByTestId('ledger')).toHaveCount(0)
  })
}

test('working Company records keeps native paragraph, reader buttons and truthful retained ledger', async ({page}) => {
  await page.setViewportSize({width:1440,height:1000})
  await review(page)
  await page.getByRole('button',{name:'Authorize mandate'}).click()
  async function control(name:string) {
    const d=page.locator('.demo-controls'); await d.evaluate(el=>(el as HTMLDetailsElement).open=true)
    await d.getByRole('button',{name,exact:true}).click()
    await d.evaluate(el=>(el as HTMLDetailsElement).open=false); await page.evaluate(()=>window.scrollTo(0,0))
  }
  await control('Confirm funding'); await control('S03 · Deliver company records')
  const w=page.getByRole('region',{name:'Conversation',exact:true})
  const result=w.getByRole('article',{name:'Company records',exact:true})
  await expect(result.locator(':scope > p.text-muted-foreground').first()).toHaveText('Paid · Evidence received · 8 TEST')
  await expect(result.locator('[data-slot="badge"], svg')).toHaveCount(0)
  expect(await result.locator('h3').evaluate(el=>getComputedStyle(el).fontWeight)).toBe('500')
  expect(await page.getByRole('complementary',{name:'Working bar'}).getByRole('heading',{name:'Results and receipts',exact:true}).evaluate(el=>getComputedStyle(el).fontWeight)).toBe('600')
  expect(await result.evaluate(el=>getComputedStyle(el).fontFamily)).not.toContain('Manrope')
  for(const b of await result.getByRole('button').all()) {
    expect((await b.boundingBox())!.height).toBe(32)
    const s=await b.evaluate(el=>{ const s=getComputedStyle(el);return {font:s.fontSize,bg:s.backgroundImage,padding:s.paddingInline,radius:s.borderRadius} })
    expect(s).toEqual({font:'14px',bg:'none',padding:'10px',radius:'10px'})
  }
  await expect(page.getByRole('complementary',{name:'Working bar'}).getByTestId('ledger')).toHaveText('Spent8 TESTReserved0 TESTAvailable22 TESTRecovered0 TEST')
  await expect(page.getByRole('complementary',{name:'Working bar'}).getByText('Background research · Not started',{exact:true})).toBeVisible()
  await result.getByRole('button',{name:/^(?:Open company records receipt|Open receipt — company records)$/}).click()
  await expect(page.getByRole('dialog',{name:'Company records receipt'})).toContainText('DEMO-RECORDS-01')
  await page.keyboard.press('Escape')
  await expect(result.getByRole('button',{name:/^(?:Open company records receipt|Open receipt — company records)$/})).toBeFocused()
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([])
})
