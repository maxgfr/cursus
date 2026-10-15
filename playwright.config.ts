import { defineConfig, devices } from '@playwright/test'

const port = 4173
const base = process.env.VITE_BASE ?? '/cursus/'

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${port}${base}`,
    // A returning device (see `returningDevice` in e2e/support/page.ts); the welcome's own test starts without it.
    storageState: {
      cookies: [],
      origins: [{ origin: `http://localhost:${port}`, localStorage: [{ name: 'cursus:onboarded', value: '1' }] }],
    },
  },
  webServer: {
    command: `bunx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}${base}`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-iphone', use: { ...devices['iPhone 15'] } },
    { name: 'webkit-ipad', use: { ...devices['iPad Pro 11 landscape'] } },
  ],
})
