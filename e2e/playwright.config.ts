import { defineConfig, devices } from '@playwright/test'

const SYNC_PORT = Number(process.env.E2E_SYNC_PORT ?? 3099)
const VITE_PORT = Number(process.env.E2E_VITE_PORT ?? 5199)
const LOCAL_VITE_PORT = VITE_PORT + 1

// Escape hatch for environments with a preinstalled Chromium at a fixed path
// (sandboxes, air-gapped CI). Unset in normal runs, where Playwright's own
// browser resolution applies.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined

export default defineConfig({
	testDir: './tests',
	fullyParallel: false,
	workers: 1,
	timeout: 300_000,
	retries: 1,
	use: {
		baseURL: `http://localhost:${VITE_PORT}`,
		trace: 'on-first-retry',
	},
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				launchOptions: { executablePath },
			},
			testIgnore: /multi-tab-local-storage/,
		},
		{
			name: 'local-multi-tab',
			use: {
				...devices['Desktop Chrome'],
				baseURL: `http://localhost:${LOCAL_VITE_PORT}`,
				launchOptions: {
					executablePath,
					args: [
						'--disable-backgrounding-occluded-windows',
						'--disable-renderer-backgrounding',
						'--disable-background-timer-throttling',
					],
				},
			},
			testMatch: /multi-tab-local-storage/,
		},
	],
	webServer: [
		{
			command: `PORT=${SYNC_PORT} pnpm --filter kora-e2e-fixture dev:server`,
			port: SYNC_PORT,
			reuseExistingServer: false,
		},
		{
			command: `VITE_SYNC_PORT=${SYNC_PORT} pnpm --filter kora-e2e-fixture dev --port ${VITE_PORT}`,
			port: VITE_PORT,
			reuseExistingServer: false,
		},
		{
			command: `VITE_E2E_LOCAL=true pnpm --filter kora-e2e-fixture dev --port ${LOCAL_VITE_PORT}`,
			port: LOCAL_VITE_PORT,
			reuseExistingServer: false,
		},
	],
})
