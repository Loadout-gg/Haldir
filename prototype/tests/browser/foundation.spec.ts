import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const widths = [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 740 }]
for (const viewport of widths) {
  test(`initial foundation at ${viewport.width}px is contained, honest and accessible`, async ({ page, baseURL }) => {
    await page.setViewportSize(viewport)
    const errors: string[] = []
    const remote: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('request', request => { if (new URL(request.url()).origin !== new URL(baseURL!).origin && !request.url().startsWith('data:')) remote.push(request.url()) })
    await page.goto('/demo')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('New task')
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled()
    await expect(page.getByText('Fictional preview', { exact: false })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    // Conversational entry uses the existing composer, not an invented shortcut.
    await expect(page.getByRole('button', { name: 'Shape this job' })).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Your message' })).toBeVisible()
    await expect(page.getByRole('navigation')).toHaveCount(0)
    if (viewport.width < 760) {
      for (const button of await page.getByRole('button').all()) {
        const box = await button.boundingBox()
        expect(box?.height).toBeGreaterThanOrEqual(44)
      }
    }
    const accessibility = await new AxeBuilder({ page }).analyze()
    expect(accessibility.violations).toEqual([])
    expect(errors).toEqual([])
    expect(remote).toEqual([])
  })
}

test('installed shadcn primitives own approved Haldir geometry and disabled treatment', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/demo')
  const appearance = await page.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!)
    return {
      cardBorder: style('.reference-card [data-slot="card"]').borderTopStyle,
      cardRadius: style('.reference-card [data-slot="card"]').borderTopLeftRadius,
      cardPadding: style('.reference-card [data-slot="card"]').paddingTop,
      contentPadding: style('.reference-card [data-slot="card-content"]').paddingLeft,
      textareaBorder: style('textarea').borderTopWidth,
      textareaMinHeight: style('textarea').minHeight,
      sendRadius: style('[aria-label="Send message"]').borderTopLeftRadius,
      sendOpacity: style('[aria-label="Send message"]').opacity,
      metadataSize: style('.reference-card [data-slot="card-content"] > p').fontSize,
      referenceBoundary: style('.reference-card').borderTopStyle,
    }
  })
  // Approved nine-frame anatomy: dashed exterior reference, borderless inner
  // card/textarea, unitary composer and compact native controls.
  expect(appearance).toEqual({ cardBorder: 'none', cardRadius: '16px', cardPadding: '0px', contentPadding: '0px', textareaBorder: '0px', textareaMinHeight: '44px', sendRadius: '50%', sendOpacity: '1', metadataSize: '14px', referenceBoundary: 'dashed' })
})

test('desktop panel, draft, context filtering, modal keyboard loop and focus restoration', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/demo')
  await page.getByRole('textbox', { name: 'Your message' }).fill('A local draft, not submitted')
  await page.getByRole('button', { name: 'Hide panel' }).click()
  await expect(page.getByRole('complementary', { name: 'Working bar' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show task panel' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('complementary', { name: 'Working bar' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Your message' })).toHaveValue('A local draft, not submitted')
  const opener = page.getByRole('button', { name: 'View context' })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Selected email thread' })
  await expect(dialog).toBeVisible()
  const search = dialog.getByRole('textbox', { name: 'Find a message' })
  await search.fill('CONTRACT')
  await expect(dialog.getByRole('article')).toHaveCount(1)
  await search.fill('nothing matches')
  await expect(dialog.getByRole('status')).toHaveText('No messages match. Try another search.')
  await search.fill('')
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press('Tab')
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
})

test('narrow working bar opens as a sheet and restores focus, including context from the sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/demo')
  const opener = page.getByRole('button', { name: 'Task panel', exact: true })
  await opener.click()
  // Identity retains the historical Sheet title; approved mobile anatomy is nonmodal/lateral.
  const sheet = page.getByRole('complementary', { name: 'Working bar', exact: true })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('Your message')).toBeInViewport()
  await page.getByLabel('Your message').fill('Draft retained while reading context')
  await expect(page.getByLabel('Your message')).toBeFocused()
  await expect(sheet).toHaveCSS('overflow-y','auto')
  await expect(sheet).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await sheet.getByRole('button', { name: 'Selected thread · 3 messages' }).click()
  const context = page.getByRole('dialog', { name: 'Selected email thread' })
  await expect(context).toBeVisible()
  await context.getByRole('textbox', { name: 'Find a message' }).fill('Contract')
  await expect(context.getByRole('article')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(context).toHaveCount(0)
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Selected thread · 3 messages' })).toBeFocused()
  await sheet.getByRole('button',{name:'Hide panel',exact:true}).click()
  await expect(sheet).toHaveCount(0)
  await expect(page.getByLabel('Your message')).toHaveValue('Draft retained while reading context')
  await expect(page.getByRole('button',{name:'Show task panel',exact:true})).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
