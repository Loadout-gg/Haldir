import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/browser.json' }]],
  use: { channel: 'chrome', headless: true, baseURL: 'http://127.0.0.1:5173', reducedMotion: 'reduce', trace: 'retain-on-failure' },
})
