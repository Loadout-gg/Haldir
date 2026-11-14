import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

for (const width of [1440, 768, 390, 320]) {
  test(`reference-light surfaces, boxed panel and preserved review at ${width}`, async ({ page }) => {
    await page.route('**/*', r => new URL(r.request().url()).origin === new URL(test.info().project.use.baseURL!).origin ? r.continue() : r.abort())
    await page.setViewportSize({ width, height: width === 768 ? 1024 : 1000 })
    await page.goto('/demo')
    // Body exists before React mounts the :has(.preview-page) palette owner.
    await expect(page.getByRole('heading', { name: 'New task', exact: true })).toBeVisible()
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(253, 253, 251)')
    expect(await page.locator('.composer').evaluate(el => getComputedStyle(el).backgroundImage)).toBe('none')
    expect(await page.locator('.composer').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)')
    const exterior = page.locator('.reference-card h2')
    expect(await exterior.evaluate(el => el.closest('[data-slot="card"]'))).toBeNull()
    // Approved UI v1 + Brand Light B: complete 16px boxed lateral panel.
    if (width > 760) {
      const bar = page.getByRole('complementary', { name: 'Working bar' })
      expect(await bar.evaluate(el => {const s=getComputedStyle(el);return [s.backgroundColor,s.borderTopWidth,s.borderRadius]})).toEqual(['rgb(249, 251, 248)','1px','16px'])
      await expect(bar).toHaveCSS('border-left-width','1px')
      await expect(bar.getByRole('heading',{name:'Task panel',exact:true})).toHaveCSS('font-size','14px')
    }
    await page.getByRole('textbox', { name: 'Your message' }).fill('budget 30; expiry 2026-11-12T18:00')
    await page.getByRole('textbox', { name: 'Your message' }).press('Enter')
    await expect(page.getByRole('heading', { name: 'Proposed spending mandate', exact:true })).toBeVisible()
    const review = page.getByRole('region', { name: 'Spending review' })
    expect(await review.getByRole('button', { name: 'Authorize mandate' }).evaluate(el => el.closest('[data-slot="card"]'))).toBeNull()
    await expect(page.locator('.conversation-history')).not.toHaveAttribute('open')
    await expect(review.getByText('Ready for review · Not authorized', {exact:true})).toBeVisible()
    for (const button of await review.getByRole('button').all()) expect((await button.boundingBox())!.height).toBe(width < 760 ? 44 : 32)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  })
}
