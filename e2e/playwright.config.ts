import { defineConfig, devices } from '@playwright/test'

const SYNC_PORT = 3099
const VITE_PORT = 5199

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 1,
  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `PORT=${SYNC_PORT} pnpm --filter kora-e2e-fixture dev:server`,
      port: SYNC_PORT,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `VITE_SYNC_PORT=${SYNC_PORT} pnpm --filter kora-e2e-fixture dev --port ${VITE_PORT}`,
      port: VITE_PORT,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
