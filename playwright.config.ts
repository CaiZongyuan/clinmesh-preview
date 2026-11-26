import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/e2e',
  outputDir: '.scratch/browser-tests',
  use: {
    browserName: 'chromium',
    actionTimeout: 8_000,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  timeout: 60_000,
})
