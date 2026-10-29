import type { BrowserContext, Page } from 'playwright-core'
import { OfflineAssertionError } from './errors'

/** Anything a connectivity helper accepts: one page, or a whole browser context. */
export type NetworkTarget = Page | BrowserContext

function contextOf(target: NetworkTarget): BrowserContext {
	return 'setOffline' in target ? target : target.context()
}

/**
 * Cuts the network for a context (every page in it, and its service workers).
 *
 * Passing a page switches its whole context: Playwright's offline switch is per context, not per
 * page. Requests served by a service worker from its cache still succeed, which is the point of
 * the offline tests.
 *
 * @param target - A page or its browser context
 *
 * @example
 * ```typescript
 * await goOffline(page)
 * await page.reload() // served by the service worker, or fails if the app is not offline-ready
 * ```
 */
export async function goOffline(target: NetworkTarget): Promise<void> {
	await contextOf(target).setOffline(true)
}

/**
 * Restores the network for a context cut by {@link goOffline}.
 *
 * @param target - A page or its browser context
 */
export async function goOnline(target: NetworkTarget): Promise<void> {
	await contextOf(target).setOffline(false)
}

/**
 * Network conditions for {@link throttleNetwork}, in the units of the Chrome DevTools protocol
 * `Network.emulateNetworkConditions`.
 */
export interface NetworkConditions {
	/** Cut the network entirely. */
	offline: boolean
	/** Extra round-trip latency in milliseconds. */
	latencyMs: number
	/** Download throughput in bytes per second; `-1` disables the limit. */
	downloadBytesPerSecond: number
	/** Upload throughput in bytes per second; `-1` disables the limit. */
	uploadBytesPerSecond: number
}

/** Names accepted by {@link throttleNetwork}. */
export type NetworkPreset = 'slow-4g' | 'fast-3g' | 'slow-3g' | '2g' | 'offline' | 'none'

/**
 * The throttling presets. `slow-4g` and `fast-3g` match the Lighthouse and DevTools profiles
 * (1.6 Mbps down, 750 kbps up; 150 ms and 562.5 ms of latency); `slow-3g` is the DevTools
 * "Slow 3G" profile (500 kbps, 400 ms); `2g` is 50 kbps with 800 ms. `none` removes throttling.
 */
export const NETWORK_PRESETS: Readonly<Record<NetworkPreset, NetworkConditions>> = {
	'slow-4g': {
		offline: false,
		latencyMs: 150,
		downloadBytesPerSecond: (1.6 * 1024 * 1024) / 8,
		uploadBytesPerSecond: (750 * 1024) / 8,
	},
	'fast-3g': {
		offline: false,
		latencyMs: 562.5,
		downloadBytesPerSecond: (1.6 * 1024 * 1024) / 8,
		uploadBytesPerSecond: (750 * 1024) / 8,
	},
	'slow-3g': {
		offline: false,
		latencyMs: 400,
		downloadBytesPerSecond: (500 * 1024) / 8,
		uploadBytesPerSecond: (500 * 1024) / 8,
	},
	'2g': {
		offline: false,
		latencyMs: 800,
		downloadBytesPerSecond: (50 * 1024) / 8,
		uploadBytesPerSecond: (50 * 1024) / 8,
	},
	offline: {
		offline: true,
		latencyMs: 0,
		downloadBytesPerSecond: 0,
		uploadBytesPerSecond: 0,
	},
	none: {
		offline: false,
		latencyMs: 0,
		downloadBytesPerSecond: -1,
		uploadBytesPerSecond: -1,
	},
}

/**
 * Resolves a preset name or custom conditions into concrete {@link NetworkConditions}.
 *
 * @param preset - A preset name or explicit conditions
 * @returns The conditions to send to the browser
 * @throws OfflineAssertionError (`UNKNOWN_NETWORK_PRESET`) for a name that is not a preset
 */
export function resolveNetworkConditions(
	preset: NetworkPreset | NetworkConditions,
): NetworkConditions {
	if (typeof preset !== 'string') return preset
	const conditions = NETWORK_PRESETS[preset]
	if (conditions === undefined) {
		throw new OfflineAssertionError(
			`Unknown network preset "${String(preset)}". Use one of: ${Object.keys(NETWORK_PRESETS).join(', ')}, or pass explicit conditions.`,
			'UNKNOWN_NETWORK_PRESET',
			{ preset },
		)
	}
	return conditions
}

/** Returned by {@link throttleNetwork}. */
export interface NetworkThrottle {
	/** The conditions in force. */
	readonly conditions: NetworkConditions
	/** Removes the throttle and detaches the DevTools session. Safe to call twice. */
	reset(): Promise<void>
}

/**
 * Throttles one page's network with the Chrome DevTools protocol
 * (`Network.emulateNetworkConditions`). **Chromium only.**
 *
 * The emulation is per page and applies to requests the page makes (documents, fetch, XHR,
 * WebSocket frames). Requests made by a service worker are not throttled by it. It is separate
 * from {@link goOffline}, which is per context. Navigating keeps the throttle; a crash ends it.
 *
 * @param page - The page to throttle
 * @param preset - A preset name (`'slow-4g'`, `'fast-3g'`, `'slow-3g'`, `'2g'`, `'offline'`, `'none'`) or explicit conditions
 * @returns A handle whose `reset()` removes the throttle
 *
 * @example
 * ```typescript
 * const throttle = await throttleNetwork(page, 'slow-4g')
 * await page.goto(url)
 * await throttle.reset()
 * ```
 */
export async function throttleNetwork(
	page: Page,
	preset: NetworkPreset | NetworkConditions,
): Promise<NetworkThrottle> {
	const conditions = resolveNetworkConditions(preset)
	const session = await page.context().newCDPSession(page)
	await session.send('Network.enable')
	await session.send('Network.emulateNetworkConditions', {
		offline: conditions.offline,
		latency: conditions.latencyMs,
		downloadThroughput: conditions.downloadBytesPerSecond,
		uploadThroughput: conditions.uploadBytesPerSecond,
	})
	let released = false
	return {
		conditions,
		async reset() {
			if (released) return
			released = true
			await session.send('Network.emulateNetworkConditions', {
				offline: false,
				latency: 0,
				downloadThroughput: -1,
				uploadThroughput: -1,
			})
			await session.detach()
		},
	}
}

/**
 * Stops every page of a context from registering a service worker, for the "service worker
 * blocked" negative tests (the app must then never report `ready`).
 *
 * It installs an init script that makes `navigator.serviceWorker.register()` reject with a
 * `SecurityError`, like a browser that forbids workers. It applies to pages created after the
 * call and to later navigations of existing pages, and lasts for the life of the context. To
 * block from the start prefer `browser.newContext({ serviceWorkers: 'block' })`; to fail only the
 * worker script use `context.route('**\/sw.js', (route) => route.abort())`.
 *
 * @param context - The context to restrict
 */
export async function blockServiceWorker(context: BrowserContext): Promise<void> {
	await context.addInitScript(rejectServiceWorkerRegistration)
}

/**
 * Runs in the page (via `addInitScript`): makes service worker registration fail.
 */
export function rejectServiceWorkerRegistration(): void {
	const container = (globalThis as { navigator?: { serviceWorker?: object } }).navigator
		?.serviceWorker
	if (container === undefined) return
	Object.defineProperty(container, 'register', {
		configurable: true,
		value: () =>
			Promise.reject(
				new DOMException('Service workers are blocked by @korajs/test/playwright', 'SecurityError'),
			),
	})
}

/**
 * Crashes a tab's renderer, the way a killed or out-of-memory tab dies (CDP `Page.crash`).
 * **Chromium only**: other engines have no equivalent, and the helper throws
 * {@link OfflineAssertionError} (`CRASH_UNSUPPORTED`) there.
 *
 * Resolves once Playwright has seen the `crash` event. The page object stays open but every
 * evaluation on it fails; open a new page on the same context to look at what survived. In-flight
 * writes are lost exactly as in a real crash, so use it right after an awaited write to prove
 * the write was durable, or mid-write to prove the queue survives.
 *
 * @param page - The page to crash
 *
 * @example
 * ```typescript
 * await page.evaluate(() => window.app.todos.insert({ title: 'durable?' }))
 * await killTab(page)
 * const reopened = await context.newPage() // the row must still be there
 * ```
 */
export async function killTab(page: Page): Promise<void> {
	const browserName = page.context().browser()?.browserType().name()
	// A persistent context has no `browser()`; it is Chromium in every case we can reach
	// `newCDPSession` for, so only refuse when the engine is positively known to be another one.
	if (browserName !== undefined && browserName !== 'chromium') {
		throw new OfflineAssertionError(
			`killTab needs Chromium (Page.crash over CDP); this page runs in ${browserName}.`,
			'CRASH_UNSUPPORTED',
			{ browserName },
		)
	}
	const session = await page.context().newCDPSession(page)
	const crashed = page.waitForEvent('crash')
	// Page.crash never replies: the renderer is gone before the response, so the send rejects or
	// hangs. The crash event is the signal.
	session.send('Page.crash').catch(() => undefined)
	await crashed
}
