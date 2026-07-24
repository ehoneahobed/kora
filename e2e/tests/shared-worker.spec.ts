import { expect, test } from '@playwright/test'

/**
 * Regression for the SharedWorker storage path. Loading the fixture with `?sw=1`
 * routes the store through the SharedWorker host, which runs SQLite directly in the
 * SharedWorker scope (a SharedWorker cannot spawn a nested Worker in Chromium).
 *
 * The bug this guards against: `open` hanging forever, so `app.ready` never
 * resolves and the app stays on its loading fallback. We assert the app reaches its
 * ready state. Note that OPFS persistence is unavailable inside a SharedWorker in
 * Chromium (createSyncAccessHandle is dedicated-worker only), so this path runs
 * in-memory and emits `store:opfs-unavailable`; the dedicated-worker path remains
 * the persistent default. We only assert readiness here.
 */
test.describe('SharedWorker storage path', () => {
	test('app readies through the SharedWorker host instead of hanging', async ({ page }) => {
		await page.goto(`/?sw=1&db=sw-${Date.now()}`)

		// `sync-status` renders only after app.ready resolves (i.e. the store opened).
		await expect(page.getByTestId('sync-status')).toBeAttached({ timeout: 60_000 })
	})
})
