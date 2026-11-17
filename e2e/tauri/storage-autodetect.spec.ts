import { expect, test } from '@playwright/test'

/**
 * Inside Tauri, createApp detects native SQLite and must load @korajs/tauri's adapter from the
 * app's bundle. The bridge here is fake: it records the plugin commands and answers like an
 * empty database, which is enough to open the store.
 */
test('storage detected inside Tauri opens through the kora-sqlite plugin', async ({ page }) => {
	await page.addInitScript(() => {
		const calls: string[] = []
		;(window as unknown as { __calls: string[] }).__calls = calls
		;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
			metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
			transformCallback: () => 0,
			invoke: async (cmd: string) => {
				calls.push(cmd)
				return cmd.endsWith('|query') ? [] : null
			},
		}
	})
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.goto('/')
	await expect(page.locator('#status')).not.toHaveText('starting', { timeout: 30_000 })
	const status = await page.locator('#status').textContent()
	const calls = await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)
	expect({ status, errors }).toEqual({ status: 'ready', errors: [] })
	expect(calls).toContain('plugin:kora-sqlite|open')
})
