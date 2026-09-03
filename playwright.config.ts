import { defineConfig, devices } from '@playwright/test'

const appPath = process.env.WARROOM_BASE_PATH
  ? `${process.env.WARROOM_BASE_PATH.replace(/\/+$/, '')}/`
  : '/'
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  reporter: 'line',
  use: {
    baseURL: externalBaseURL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: externalBaseURL
    ? undefined
    : {
        command: 'pnpm build && pnpm preview',
        url: `http://127.0.0.1:4173${appPath}`,
        timeout: 120_000,
        reuseExistingServer: true,
      },
})
