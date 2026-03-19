import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 5 * 60 * 1000, // 5 min per test — Claude Code generation is slow
  expect: { timeout: 4 * 60 * 1000 },
  use: {
    baseURL: 'http://localhost:3000',
    headless: false, // watch it work
    viewport: { width: 1280, height: 900 },
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
