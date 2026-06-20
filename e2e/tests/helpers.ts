import type { Page } from '@playwright/test'

const SYNC_PORT = Number(process.env.E2E_SYNC_PORT || process.env.VITE_SYNC_PORT || 3099)

declare global {
	interface Window {
		__KORA_E2E_READY__?: boolean
	}
}

function uniqueDbName(): string {
	return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function fixturePath(dbName: string): string {
	return `/?db=${encodeURIComponent(dbName)}`
}

/** Reset the in-memory sync server between tests (see fixture-app/server.ts). */
export async function resetSyncFixture(): Promise<void> {
	await fetch(`http://localhost:${SYNC_PORT + 100}/__e2e_reset`, { method: 'POST' })
}

/** Wait until the fixture app has finished opening the store (see fixture-app/main.tsx). */
export async function waitForFixtureReady(page: Page): Promise<void> {
	// Use `attached` — follower tabs may be backgrounded in Playwright (not "visible").
	await page.getByTestId('sync-status').waitFor({ state: 'attached', timeout: 120_000 })
}

/**
 * Follower tabs depend on the leader tab's BroadcastChannel relay. Headless Chromium
 * throttles background pages, so keep the leader's event loop turning while waiting.
 */
async function waitForFixtureReadyWithLeaderPulse(leader: Page, follower: Page): Promise<void> {
	const deadline = Date.now() + 120_000
	const status = follower.getByTestId('sync-status')
	while (Date.now() < deadline) {
		const count = await status.count()
		if (count > 0) {
			return
		}
		await leader.bringToFront()
		await leader.evaluate(
			() =>
				new Promise<void>((resolve) => {
					requestAnimationFrame(() => resolve())
				}),
		)
		await follower.waitForTimeout(25)
	}
	await waitForFixtureReady(follower)
}

export interface OpenFixtureInTabsOptions {
	/** When true, both tabs share one database (local multi-tab / SharedWorker). Default false for sync tests. */
	sharedDatabase?: boolean
}

/**
 * Open the fixture in two tabs without racing worker init.
 * Sync tests use separate database names so each tab is an independent sync client.
 */
export async function openFixtureInTabs(
	pageA: Page,
	pageB: Page,
	options?: OpenFixtureInTabsOptions,
): Promise<void> {
	const baseDb = uniqueDbName()
	await resetSyncFixture()

	if (options?.sharedDatabase) {
		const path = fixturePath(baseDb)
		await pageA.goto(path)
		await waitForFixtureReady(pageA)
		await pageB.goto(path)
		await waitForFixtureReadyWithLeaderPulse(pageA, pageB)
		return
	}

	await pageA.goto(fixturePath(`${baseDb}-a`))
	await waitForFixtureReady(pageA)
	await pageB.goto(fixturePath(`${baseDb}-b`))
	await waitForFixtureReady(pageB)
}
