import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
const evidence = process.env.HALDIR_EVIDENCE_DIR || fileURLToPath(new URL('../../../test-results/brand', import.meta.url))

test.beforeEach(async ({ page, baseURL }) => {
  await page.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL!).origin && !new URL(route.request().url()).pathname.startsWith('/api/') ? route.continue() : route.abort())
})

test('reference-light tokens and platform font drive preserved composition and interactive states', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/demo')
  await page.evaluate(() => document.fonts.ready)
  const appearance = await page.evaluate(() => {
    const s = (q: string) => getComputedStyle(document.querySelector(q)!)
    return { background: s('body').backgroundColor, font: s('body').fontFamily,
      loaded: document.fonts.check('400 14px Manrope'), panel: s('.working-bar').backgroundColor,
      radius: s('.reference-card [data-slot="card"]').borderTopLeftRadius, composer: s('.composer').borderTopLeftRadius,
      fieldSize: s('textarea').fontSize, placeholder: getComputedStyle(document.querySelector('textarea')!, '::placeholder').color,
      cols: s('.workspace-body').gridTemplateColumns, measure: s('.conversation-content').maxWidth }
  })
  expect(appearance.background).toBe('rgb(253, 253, 251)')
  expect(appearance.font).not.toContain('Manrope')
  expect(appearance.panel).toBe('rgb(249, 251, 248)')
  expect(appearance.radius).toBe('16px')
  expect(appearance.composer).toBe('16px')
  expect(appearance.fieldSize).toBe('14px')
  expect(appearance.placeholder).toBe('rgb(68, 87, 74)')
  expect(appearance.cols).toMatch(/ 400px$/)
  expect(appearance.measure).toBe('720px')
  await expect(page.getByRole('button', { name: 'Shape this job' })).toHaveCount(0)
  const view = page.getByRole('button', { name: 'View context' })
  const disabled = page.getByRole('button', { name: 'Send message' })
  const style = async (control: typeof view) => control.evaluate(el => {
    const s = getComputedStyle(el); return { bg: s.backgroundImage, color: s.color, shadow: s.boxShadow, opacity: s.opacity, outline: s.outlineStyle, outlineColor: s.outlineColor, outlineWidth: s.outlineWidth, outlineOffset: s.outlineOffset }
  })
  await page.getByRole('textbox', { name: 'Your message' }).focus()
  expect(await page.getByRole('textbox', { name: 'Your message' }).evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid')
  expect((await style(view)).color).toBe('rgb(23, 61, 50)')
  await view.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  // Wait for the committed reduced-motion color, not its previous event-tick color.
  await expect.poll(async () => (await style(view)).outlineColor).toBe('rgb(23, 61, 50)')
  expect((await style(view)).outline).toBe('solid')
  const disabledStyle = await style(disabled)
  expect(disabledStyle).toMatchObject({ bg: 'none', opacity: '1' })
  // Tailwind shadow-none serializes zero-alpha ring/shadow layers in Chrome;
  // accept only literal none or entirely transparent, zero-extent layers.
  expect(disabledStyle.shadow === 'none' || disabledStyle.shadow.replaceAll('rgba(0, 0, 0, 0) 0px 0px 0px 0px', '').replaceAll(', ', '') === '').toBe(true)
  await page.getByRole('textbox', { name: 'Your message' }).fill('budget 30')
  expect((await style(disabled)).bg).toBe('none')
  await page.getByRole('textbox', { name: 'Your message' }).fill('')
  // Approved no-avatar anatomy replaces the conversation artwork; header identity is unchanged.
  await expect(page.locator('.conversation .agent-avatar')).toHaveCount(0)
  await expect(page.locator('.assistant-message .agent-name').first()).toHaveText('Haldir')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  mkdirSync(evidence, { recursive: true })
  const session = await page.context().newCDPSession(page)
  await session.send('DOM.enable')
  await session.send('CSS.enable')
  const { root } = await session.send('DOM.getDocument')
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.assistant-message' })
  const rendered = await session.send('CSS.getPlatformFontsForNode', { nodeId })
  // Actual Chrome platform glyph selection, not just a CSS-family assertion.
  expect(rendered.fonts.length).toBeGreaterThan(0)
  expect(rendered.fonts.every((font: {isCustomFont: boolean}) => !font.isCustomFont)).toBe(true)
  writeFileSync(`${evidence}/computed-brand.json`, JSON.stringify({ appearance, rendered, dark: await style(view), disabled: await style(disabled) }, null, 2))
})

for (const viewport of [{ width:1440,height:1000 },{ width:768,height:1024 },{ width:390,height:844 },{ width:320,height:740 }]) {
  test(`brand responsive ${viewport.width}: layout, loaded font, closed mobile and initial screenshot`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/demo')
    await page.evaluate(() => document.fonts.ready)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width)
    const logo = await page.locator('.haldir-wordmark').boundingBox()
    const heading = await page.getByRole('heading', { level:1 }).boundingBox()
    expect(logo!.x + logo!.width).toBeLessThan(heading!.x)
    if (viewport.width < 760) {
      await expect(page.getByRole('dialog')).toHaveCount(0)
      const panel = await page.getByRole('button', { name:'Task panel', exact:true }).boundingBox()
      expect(heading!.x + heading!.width).toBeLessThanOrEqual(panel!.x)
      expect(panel!.x + panel!.width).toBeLessThan(viewport.width)
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.screenshot({ path:`${evidence}/initial-${viewport.width}.png`, animations:'disabled' })
  })
}

test('200 percent zoom reflows and reduced motion, keyboard composer and context remain usable', async ({ page }) => {
  // Native Chrome zoom via CDP is device-scale, not layout zoom. At a 1440px
  // physical window, 720 CSS px is the equivalent 200% layout viewport.
  await page.setViewportSize({ width:720,height:500 })
  await page.goto('/demo')
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
  const field = page.getByRole('textbox', { name:'Your message' })
  await field.fill('budget 30')
  await field.press('Shift+Enter')
  await expect(field).toHaveValue('budget 30\n')
  await field.press('Enter')
  await expect(field).toHaveValue('')
  await expect(page.getByRole('button', { name:'Send message' })).toBeDisabled()
  await page.getByRole('button', { name:'View context' }).click()
  const dialog = page.getByRole('dialog', { name:'Selected email thread' })
  await expect(dialog).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name:'View context' })).toBeFocused()
  await page.screenshot({ path:`${evidence}/reflow-200-percent-equivalent.png` })
})
