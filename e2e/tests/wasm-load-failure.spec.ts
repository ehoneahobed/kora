import { expect, test } from '@playwright/test'

declare global {
	interface Window {
		__KORA_E2E_ERROR__?: string
		__KORA_E2E_READY__?: boolean
	}
}

/**
 * F15: when sqlite3.wasm cannot be downloaded (the device went offline before the
 * binary was ever cached), opening the store fails within seconds with an error that
 * names the binary, instead of hanging until the 60-second init timeout. Once the
 * binary is reachable again, a fresh open succeeds.
 */
test('a failed sqlite3.wasm download fails the open fast, and a later open succeeds', async ({
	page,
}) => {
	// The binary itself, not the `sqlite3.wasm?url` module the worker imports for its URL.
	const isWasmBinary = (url: URL): boolean =>
		url.pathname.endsWith('.wasm') &&
		!url.searchParams.has('url') &&
		!url.searchParams.has('import')
	await page.route(isWasmBinary, (route) => route.abort('internetdisconnected'))
	const db = `e2e-wasm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	const started = Date.now()
	await page.goto(`/?db=${db}`)
	await page.waitForFunction(() => window.__KORA_E2E_ERROR__ !== undefined, undefined, {
		timeout: 45_000,
	})
	const elapsed = Date.now() - started
	const message = await page.evaluate(() => window.__KORA_E2E_ERROR__ ?? '')
	expect(message).toMatch(/sqlite3\.wasm/)
	expect(elapsed).toBeLessThan(30_000)

	await page.unroute(isWasmBinary)
	await page.goto(`/?db=${db}`)
	await page.waitForFunction(() => window.__KORA_E2E_READY__ === true, undefined, {
		timeout: 120_000,
	})
})
