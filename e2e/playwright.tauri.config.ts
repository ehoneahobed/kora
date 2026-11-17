import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_TAURI_PORT ?? 5299)

/**
 * The tauri-react build in a browser with a fake Tauri bridge: checks that storage detected
 * inside Tauri loads @korajs/tauri from the bundle (a webview cannot resolve a bare specifier).
 */
export default defineConfig({
	testDir: './tauri',
	workers: 1,
	timeout: 60_000,
	use: { baseURL: `http://localhost:${PORT}` },
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined },
			},
		},
	],
	webServer: {
		command: 'pnpm --filter kora-e2e-tauri-app build && pnpm --filter kora-e2e-tauri-app preview',
		port: PORT,
		reuseExistingServer: false,
		timeout: 180_000,
		env: { E2E_TAURI_PORT: String(PORT) },
	},
})
