import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
const panel = (page: Page) => page.getByRole('complementary', { name: 'Working bar', exact: true })
const evidence = process.env.HALDIR_EVIDENCE_DIR ? `${process.env.HALDIR_EVIDENCE_DIR}/copy-regressions` : fileURLToPath(new URL('../../../test-results/copy-regressions', import.meta.url))
const workspace = (page: Page) => page.getByRole('region', { name: 'Conversation', exact: true })
async function control(page: Page, name: string) {
  const d = page.getByRole('group', { name: 'Demo controls' })
  if (await d.getAttribute('open') === null) await page.getByText('Demo controls', { exact: true }).click()
  await d.getByRole('button', { name, exact: true }).click()
}
async function activate(page: Page) {
  await page.goto('/demo')
  await page.getByRole('textbox', { name: 'Your message' }).fill('budget 30; expiry 2026-11-12T18:00')
  await page.getByRole('textbox', { name: 'Your message' }).press('Enter')
  await expect(page.getByRole('region', { name: 'Spending review', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Authorize mandate' }).click()
  await control(page, 'Confirm funding')
}
async function snap(page: Page, file: string) {
  await page.locator('details.demo-controls').evaluate(el => (el as HTMLDetailsElement).open = false)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: `${evidence}/${file}.png`, animations: 'disabled' })
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  // Demo only: abort anything except this owned loopback server.
  await page.route('**/*', route => route.request().url().startsWith(`${new URL(test.info().project.use.baseURL!).origin}/`) ? route.continue() : route.abort())
})
test('F1 served build uses passive waiting copy and keeps return unconfirmed', async ({ page }) => {
  await activate(page)
  await control(page, 'S03 · Deliver company records')
  await control(page, 'S05 · Two requests together')
  await control(page, 'S06 · Deliver background research')
  await workspace(page).getByRole('button', { name: 'Stop new spending' }).click()
  await control(page, 'Confirm stop')
  await workspace(page).getByRole('button', { name: 'Check prior payments' }).click()
  await workspace(page).getByRole('button', { name: 'Request return of 7 TEST' }).click()
  await control(page, 'Make return uncertain')
  await expect(workspace(page).getByRole('status')).toHaveText("We're still waiting for confirmation that your remaining funds have been returned. You don't need to send another request.")
  await expect(panel(page).locator('.panel-status').filter({ hasText: /^Return pending$/ })).toBeVisible()
  await expect(panel(page).getByTestId('ledger')).toHaveText('Spent23 TESTReserved0 TESTAvailable7 TESTRecovered0 TEST')
  await expect(workspace(page).getByText('Check the same return request;', { exact: false })).toHaveCount(0)
  await snap(page, '01-F1-return-waiting')
})
test('F3 served receipts show all three delivery labels on the same paid order', async ({ page }) => {
  await activate(page)
  await control(page, 'Start company records payment')
  await control(page, 'Confirm company records payment')
  const receipt = page.getByRole('dialog', { name: 'Company records receipt' })
  async function check(label: string, file: string) {
    await panel(page).getByRole('button', { name: /^(?:Open company records receipt|Open receipt — company records)$/ }).click()
    await expect(receipt).toBeVisible()
    const row = receipt.locator('.terms > div').filter({ has: page.getByText('Delivery', { exact: true }) })
    await expect(row.locator('dd')).toHaveText(label)
    await expect(receipt).toContainText('DEMO-RECORDS-01')
    await expect(receipt).toContainText('8 TEST')
    await expect(receipt).toContainText('Confirmed in simulation')
    await snap(page, file)
    await page.keyboard.press('Escape')
  }
  await check('Awaiting data', '02-F3-awaiting-data')
  await panel(page).getByRole('button', { name: 'Recover company records delivery' }).click()
  await check('Retrieval requested', '03-F3-retrieval-requested')
  await control(page, 'Deliver company records response')
  await check('Received', '04-F3-received')
  await expect(panel(page).getByTestId('ledger')).toHaveText('Spent8 TESTReserved0 TESTAvailable22 TESTRecovered0 TEST')
})
