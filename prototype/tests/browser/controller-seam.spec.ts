import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const panel = (page: Page) => page.getByRole('complementary', { name: 'Working bar', exact: true })
const evidence = resolve(process.env.HALDIR_EVIDENCE_DIR || '../.hermes/reviews/haldir-ui-seam-evidence/browser', 'controller-seam')

test('readiness disclosure stays simulation-only even with a testnet URL hint', async ({ page }) => {
  const remote: string[] = []
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(test.info().project.use.baseURL!).origin) return route.continue()
    remote.push(route.request().url())
    return route.abort()
  })
  await page.goto('/?mode=testnet')
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    const notice = page.getByRole('region', { name: 'Preview notice' })
    await expect(notice).toContainText('Scripted simulation')
    await expect(notice).toContainText('Testnet not configured')
    await expect(page.getByRole('button', { name: /connect wallet|approve testnet|switch.*testnet/i })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: `${evidence}/readiness-${width}.png` })
  }
  expect(remote).toEqual([])
})

test('one uncertain simulation job survives desktop/mobile readers and panel actions without new requests (characterization)', async ({ page }) => {
  const requests: string[] = [], remote: string[] = [], errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(request.url()))
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(test.info().project.use.baseURL!).origin) return route.continue()
    remote.push(route.request().url())
    return route.abort()
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/demo')
  await page.evaluate(() => document.fonts.ready)
  const composer = page.getByRole('textbox', { name: 'Your message' })
  await composer.fill('budget 24.35; expiry 2026-11-12T18:00')
  await page.getByRole('button', { name: 'Send message' }).click()
  await composer.fill('output Shared result')
  await composer.press('Enter')
  await expect(page.getByRole('region', { name: 'Spending review', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Authorize mandate' }).click()
  const controls = page.getByRole('group', { name: 'Demo controls' })
  await controls.locator('summary').click()
  for (const name of ['Confirm funding', 'Start company records payment', 'Make company records payment uncertain']) {
    await controls.getByRole('button', { name, exact: true }).click()
  }
  await controls.locator('summary').click()
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true })
  const ledger = 'Spent0 TESTReserved8 TESTAvailable16.35 TESTRecovered0 TEST'
  await expect(conversation.getByTestId('ledger')).toHaveCount(0)
  await expect(panel(page).getByTestId('ledger')).toHaveText(ledger)
  const before = requests.length
  await page.getByRole('button', { name: 'Hide panel' }).click()
  await page.getByRole('button', { name: 'Show task panel' }).click()
  await expect(panel(page).getByTestId('ledger')).toHaveText(ledger)
  await panel(page).getByRole('button', { name: 'Hide panel', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const trigger = page.getByRole('button', { name: 'Task panel', exact: true })
  await trigger.click()
  const sheet = panel(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(sheet.getByTestId('ledger')).toHaveText(ledger)
  const termsOpener = sheet.getByRole('button', { name: 'View authorized terms', exact: true })
  await termsOpener.click()
  const terms = page.getByRole('dialog', { name: 'Authorized terms', exact: true })
  await expect(terms).toContainText('Shared result')
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab')
    await expect.poll(() => terms.evaluate(el => el.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(termsOpener).toBeFocused()
  await sheet.getByRole('button', { name: 'Check company records payment' }).click()
  await expect(sheet.getByRole('article', { name: 'Company records' })).toContainText('Payment uncertain · Funds reserved · 8 TEST')
  await expect(sheet.getByTestId('ledger')).toHaveText(ledger)
  await sheet.getByRole('button', { name: 'Hide panel', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Show task panel', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Show task panel', exact: true }).click()
  await sheet.getByRole('button', { name: 'Stop new spending' }).click()
  await sheet.getByRole('button', { name: 'Hide panel', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  await expect(conversation.getByText('Mandate: Stop requested · Available 16.35 TEST', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Show task panel', exact: true }).click()
  await expect(panel(page).getByTestId('ledger')).toHaveText(ledger)
  expect(requests.length).toBe(before)
  expect(remote).toEqual([])
  expect(errors).toEqual([])
})
