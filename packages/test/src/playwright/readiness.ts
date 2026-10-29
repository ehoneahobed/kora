import type { BrowserContext, Page } from 'playwright-core'
import { OfflineAssertionError } from './errors'
import { goOffline, goOnline } from './network'
import {
	type EvaluatingPage,
	type WaitForOfflineStatusOptions,
	readOfflineStatus,
	waitForOfflineStatus,
} from './status'
import { DEFAULT_OFFLINE_ACCESSOR, type OfflineStatusLike, type StatusReadOptions } from './types'

/** The sessionStorage key the in-page probe records into (it survives reloads of one tab). */
export const PROBE_STORAGE_KEY = '__kora_pw_offline_probe'

/** What the in-page probe recorded. */
export interface ProbeRecord {
	samples: number
	readyObservations: number
	states: Record<string, number>
	reasons: Record<string, number>
}

/**
 * Runs in the page (via `addInitScript` and `evaluate`): samples `app.offline.status()` on a short
 * interval and accumulates what it saw in `sessionStorage`, so a `ready` that flashes by between
 * two Node-side reads, or during a reload, is still counted. It is idempotent per document.
 *
 * Exported for unit tests and Playwright serialization; it must stay self-contained.
 *
 * @param input - The accessor path, the storage key and the sampling interval
 */
export function installReadinessProbe(input: {
	accessor: string
	storageKey: string
	intervalMs: number
}): void {
	const g = globalThis as unknown as Record<string, unknown>
	if (g.__koraOfflineProbeInstalled === input.storageKey) return
	g.__koraOfflineProbeInstalled = input.storageKey
	let record: ProbeRecord = { samples: 0, readyObservations: 0, states: {}, reasons: {} }
	try {
		const stored = sessionStorage.getItem(input.storageKey)
		if (stored !== null) record = JSON.parse(stored) as ProbeRecord
	} catch {
		// sessionStorage can be unavailable (opaque origin); the Node-side sampler still runs.
	}
	setInterval(() => {
		let node: unknown = globalThis
		for (const key of input.accessor.split('.')) {
			if (node === null || node === undefined) return
			node = (node as Record<string, unknown>)[key]
		}
		const status = (node as { status?: unknown } | null | undefined)?.status
		if (typeof status !== 'function') return
		let snapshot: { state?: unknown; reasons?: unknown } | null = null
		try {
			snapshot = (status as () => { state?: unknown; reasons?: unknown }).call(node)
		} catch {
			return
		}
		if (snapshot === null || typeof snapshot !== 'object') return
		record.samples += 1
		const state = String(snapshot.state)
		record.states[state] = (record.states[state] ?? 0) + 1
		if (state === 'ready') record.readyObservations += 1
		if (Array.isArray(snapshot.reasons)) {
			for (const reason of snapshot.reasons) {
				record.reasons[String(reason)] = (record.reasons[String(reason)] ?? 0) + 1
			}
		}
		try {
			sessionStorage.setItem(input.storageKey, JSON.stringify(record))
		} catch {
			// Storage full or blocked: keep counting in memory.
		}
	}, input.intervalMs)
}

/** What {@link expectNeverReady} observed while `during` ran. */
export interface NeverReadyReport {
	/** `true` when any sample, Node-side or in-page, saw `state === 'ready'`. */
	everReady: boolean
	/** How many samples saw `ready` (in-page and Node-side together). */
	readyObservations: number
	/** How many samples were taken in total. */
	samples: number
	/** Every `state` value seen, sorted. */
	statesSeen: string[]
	/** Every `reasons` entry seen, sorted. */
	reasonsSeen: string[]
	/** The last status read from the page, or `null` if the handle never appeared. */
	lastStatus: OfflineStatusLike | null
	/** Whether the in-page probe could be read back (`false` when the page crashed or closed). */
	probeRead: boolean
	/** Throws {@link OfflineAssertionError} (`READY_OBSERVED`) when `ready` was ever observed. */
	assertNeverReady(): void
}

/** Options for {@link expectNeverReady}. */
export interface ExpectNeverReadyOptions extends StatusReadOptions {
	/** Delay between Node-side reads. Default 25. */
	pollMs?: number
	/** In-page probe interval. Default 5. */
	probeIntervalMs?: number
	/** Replaceable delay, for deterministic unit tests. */
	sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `during` (a scenario that must leave the app not ready: service worker blocked, handshake
 * final held, precache entry deleted, ...) while recording every offline status the page
 * reports, and returns a report of whether `ready` was ever observed.
 *
 * Two observers run: a Node-side sampler that reads `app.offline.status()` repeatedly, and an
 * in-page probe (installed for the current document and every later navigation of this page)
 * that also catches a `ready` that flashes by during a reload. It never throws on `ready`;
 * call `report.assertNeverReady()` (or check `report.everReady`) so a failing scenario reports
 * what it saw. The probe stays installed for the life of the page and only writes to
 * `sessionStorage` under `__kora_pw_offline_probe`.
 *
 * @param page - The page running the app
 * @param during - The scenario to run while observing
 * @param options - Accessor and sampling
 * @returns The observation report
 *
 * @example
 * ```typescript
 * const report = await expectNeverReady(page, async () => {
 *   await goOffline(page)
 *   await page.reload().catch(() => undefined)
 * })
 * report.assertNeverReady()
 * ```
 */
export async function expectNeverReady(
	page: Page,
	during: () => Promise<void>,
	options: ExpectNeverReadyOptions = {},
): Promise<NeverReadyReport> {
	const accessor = options.accessor ?? DEFAULT_OFFLINE_ACCESSOR
	const pollMs = options.pollMs ?? 25
	const sleep = options.sleep ?? defaultSleep
	const probeInput = {
		accessor,
		storageKey: PROBE_STORAGE_KEY,
		intervalMs: options.probeIntervalMs ?? 5,
	}

	await tryEvaluate(() =>
		page.evaluate((key: string) => {
			try {
				sessionStorage.removeItem(key)
			} catch {
				// Nothing recorded yet.
			}
		}, PROBE_STORAGE_KEY),
	)
	await page.addInitScript(installReadinessProbe, probeInput)
	await tryEvaluate(() => page.evaluate(installReadinessProbe, probeInput))

	let samples = 0
	let readyObservations = 0
	const states = new Set<string>()
	const reasons = new Set<string>()
	let lastStatus: OfflineStatusLike | null = null
	const observe = (status: OfflineStatusLike): void => {
		samples += 1
		lastStatus = status
		states.add(status.state)
		if (status.state === 'ready') readyObservations += 1
		for (const reason of status.reasons) reasons.add(reason)
	}
	const sample = async (): Promise<void> => {
		const status = await readOfflineStatus(page, { accessor }).catch(() => null)
		if (status !== null) observe(status)
	}

	let running = true
	const sampler = (async () => {
		while (running) {
			await sample()
			await sleep(pollMs)
		}
	})()
	try {
		await during()
	} finally {
		running = false
		await sampler
	}
	await sample()

	const probe = await readProbe(page)
	if (probe !== null) {
		samples += probe.samples
		readyObservations += probe.readyObservations
		for (const state of Object.keys(probe.states)) states.add(state)
		for (const reason of Object.keys(probe.reasons)) reasons.add(reason)
	}

	const report: NeverReadyReport = {
		everReady: readyObservations > 0,
		readyObservations,
		samples,
		statesSeen: [...states].sort(),
		reasonsSeen: [...reasons].sort(),
		lastStatus,
		probeRead: probe !== null,
		assertNeverReady() {
			if (report.everReady) {
				throw new OfflineAssertionError(
					`The app reported "ready" ${report.readyObservations} time(s) in a scenario where it must never be ready. States seen: ${report.statesSeen.join(', ')}. Reasons seen: ${report.reasonsSeen.join(', ') || 'none'}.`,
					'READY_OBSERVED',
					{ ...report },
				)
			}
		},
	}
	return report
}

async function tryEvaluate(run: () => Promise<unknown>): Promise<void> {
	try {
		await run()
	} catch {
		// The page is navigating, crashed or closed; the init script covers the next document.
	}
}

async function readProbe(page: EvaluatingPage): Promise<ProbeRecord | null> {
	try {
		const raw = await page.evaluate((key: string) => {
			try {
				return sessionStorage.getItem(key)
			} catch {
				return null
			}
		}, PROBE_STORAGE_KEY)
		return raw === null ? null : (JSON.parse(raw) as ProbeRecord)
	} catch {
		return null
	}
}

/** Options for {@link assertReadyMeansOffline}. */
export interface AssertReadyMeansOfflineOptions extends WaitForOfflineStatusOptions {
	/** CSS selector of something only the loaded app shell renders. Default `'body'`. */
	shellSelector?: string
	/** CSS selector of something that only shows when the app's data is there (a row, a title). */
	dataSelector?: string
	/**
	 * Performs one write through the app UI or API while offline, for example by clicking "Add"
	 * or calling `page.evaluate(() => window.app.todos.insert(...))`. It must resolve only after
	 * the app has accepted the write.
	 */
	write: (page: Page) => Promise<void>
	/**
	 * Reports whether the write made by {@link write} is present. Return `false` (or throw) when
	 * it is missing. Runs after the second offline reload.
	 */
	verifyWrite: (page: Page) => Promise<boolean | undefined>
	/**
	 * Also require the status to read `ready` again after the offline reload. Default `false`:
	 * the app may legitimately need a moment, or a connection, to re-derive some pieces.
	 */
	requireReadyAfterReload?: boolean
	/** Runs after the network is back, for example to wait for the queued write to upload. */
	onOnline?: (page: Page) => Promise<void>
	/** Leave the context offline when the helper returns. Default `false`: the network is restored. */
	keepOffline?: boolean
	/** Timeout for each offline reload and selector wait. Default 15000. */
	stepTimeoutMs?: number
}

/** What {@link assertReadyMeansOffline} verified. */
export interface ReadyMeansOfflineReport {
	/** The `ready` status that triggered the check. */
	readyStatus: OfflineStatusLike
	/** The steps that passed, in order. */
	steps: string[]
}

/**
 * The offline-readiness contract as a test: **when the app says `ready`, it must work offline.**
 *
 * It waits for `app.offline.status().state === 'ready'`, cuts the network, reloads, and asserts
 * that the app shell renders, the data shows, a write succeeds and the write is still there after
 * a second offline reload. Then it restores the network (unless `keepOffline`) and runs
 * `onOnline`. Each failure is an {@link OfflineAssertionError} that names the step, so a
 * regression says which promise broke: `READY_TIMEOUT`, `OFFLINE_RELOAD_FAILED`,
 * `SHELL_MISSING`, `DATA_MISSING`, `NOT_READY_AFTER_RELOAD`, `OFFLINE_WRITE_FAILED`,
 * `OFFLINE_WRITE_LOST`.
 *
 * The page must already be on the app's URL. Pair it with {@link expectNeverReady} for the
 * negative cases in which `ready` must not appear.
 *
 * @param page - The page running the app
 * @param options - How to recognise the shell and data, and how to write and verify
 * @returns What was verified
 *
 * @example
 * ```typescript
 * await page.goto(appUrl)
 * await assertReadyMeansOffline(page, {
 *   shellSelector: '#app',
 *   dataSelector: '.todo-row',
 *   write: async (p) => {
 *     await p.getByRole('button', { name: 'Add' }).click()
 *   },
 *   verifyWrite: async (p) => (await p.locator('.todo-row').count()) > 1,
 * })
 * ```
 */
export async function assertReadyMeansOffline(
	page: Page,
	options: AssertReadyMeansOfflineOptions,
): Promise<ReadyMeansOfflineReport> {
	const stepTimeout = options.stepTimeoutMs ?? 15_000
	const shellSelector = options.shellSelector ?? 'body'
	const steps: string[] = []
	const fail = (step: string, code: string, detail: string): never => {
		throw new OfflineAssertionError(
			`The app was ready but failed offline at "${step}": ${detail}`,
			code,
			{ step, steps },
		)
	}

	let readyStatus: OfflineStatusLike
	try {
		readyStatus = await waitForOfflineStatus(page, 'ready', options)
	} catch (error) {
		throw new OfflineAssertionError(
			`The app never became ready: ${error instanceof Error ? error.message : String(error)}`,
			'READY_TIMEOUT',
		)
	}
	steps.push('ready')

	const reloadOffline = async (step: string): Promise<void> => {
		try {
			await page.reload({ waitUntil: 'domcontentloaded', timeout: stepTimeout })
		} catch (error) {
			fail(step, 'OFFLINE_RELOAD_FAILED', error instanceof Error ? error.message : String(error))
		}
		try {
			await page.waitForSelector(shellSelector, { state: 'visible', timeout: stepTimeout })
		} catch {
			fail(step, 'SHELL_MISSING', `"${shellSelector}" did not render after an offline reload`)
		}
		if (options.dataSelector !== undefined) {
			try {
				await page.waitForSelector(options.dataSelector, { state: 'visible', timeout: stepTimeout })
			} catch {
				fail(
					step,
					'DATA_MISSING',
					`"${options.dataSelector}" did not render after an offline reload`,
				)
			}
		}
	}

	await goOffline(page)
	try {
		await reloadOffline('offline reload')
		steps.push('shell and data after offline reload')

		if (options.requireReadyAfterReload === true) {
			try {
				await waitForOfflineStatus(page, 'ready', { ...options, timeoutMs: stepTimeout })
			} catch {
				fail(
					'status after offline reload',
					'NOT_READY_AFTER_RELOAD',
					'the status did not return to ready',
				)
			}
			steps.push('ready after offline reload')
		}

		try {
			await options.write(page)
		} catch (error) {
			fail(
				'offline write',
				'OFFLINE_WRITE_FAILED',
				error instanceof Error ? error.message : String(error),
			)
		}
		steps.push('offline write')

		await reloadOffline('second offline reload')
		let survived: boolean | undefined
		try {
			survived = await options.verifyWrite(page)
		} catch (error) {
			fail(
				'write survives reload',
				'OFFLINE_WRITE_LOST',
				error instanceof Error ? error.message : String(error),
			)
		}
		if (survived === false) {
			fail(
				'write survives reload',
				'OFFLINE_WRITE_LOST',
				'verifyWrite reported the write is missing',
			)
		}
		steps.push('write survives reload')
	} finally {
		if (options.keepOffline !== true) await goOnline(page)
	}

	if (options.onOnline !== undefined && options.keepOffline !== true) {
		await options.onOnline(page)
		steps.push('online hook')
	}
	return { readyStatus, steps }
}

/** Options for {@link firstVisitOffline}. */
export interface FirstVisitOfflineOptions extends WaitForOfflineStatusOptions {
	/**
	 * Visit the app online first so the service worker installs (default `true`). With `false`
	 * the context goes offline before the very first request: a cold first visit, which cannot
	 * load, to assert that the failure is clean.
	 */
	warmUp?: boolean
	/** Also wait for `app.offline.status().state === 'ready'` during warm-up. Default `false`. */
	waitForReady?: boolean
	/** Timeout for the warm-up service worker wait. Default 30000. */
	timeoutMs?: number
}

/** The outcome of {@link firstVisitOffline}. */
export interface FirstVisitOfflineResult {
	/** The fresh page opened while offline. */
	page: Page
	/** Whether the offline navigation produced a document. */
	loaded: boolean
	/** The navigation error message when it did not. */
	error: string | null
}

/**
 * The first-visit-offline flow: install the app online once, cut the network, then open a
 * brand-new tab on the same URL and see whether the app loads from its service worker alone.
 * It does not throw when the navigation fails; it reports `loaded: false` with the error so
 * positive and negative tests share one flow.
 *
 * The warm-up page is closed before the offline visit so nothing is served from a live page.
 * The context is left offline; call {@link goOnline} to restore it.
 *
 * @param context - The browser context to use
 * @param url - The app URL
 * @param options - Warm-up and readiness options
 * @returns The offline page and whether it loaded
 *
 * @example
 * ```typescript
 * const { page, loaded } = await firstVisitOffline(context, appUrl, { waitForReady: true })
 * expect(loaded).toBe(true)
 * await page.waitForSelector('#app')
 * ```
 */
export async function firstVisitOffline(
	context: BrowserContext,
	url: string,
	options: FirstVisitOfflineOptions = {},
): Promise<FirstVisitOfflineResult> {
	if (options.warmUp !== false) {
		const warm = await context.newPage()
		try {
			await warm.goto(url, { waitUntil: 'domcontentloaded' })
			await warm.evaluate(
				() =>
					(
						navigator as unknown as { serviceWorker?: { ready: Promise<unknown> } }
					).serviceWorker?.ready.then(() => true) ?? false,
			)
			if (options.waitForReady === true) await waitForOfflineStatus(warm, 'ready', options)
		} finally {
			await warm.close()
		}
	}
	await goOffline(context)
	const page = await context.newPage()
	try {
		await page.goto(url, { waitUntil: 'domcontentloaded' })
		return { page, loaded: true, error: null }
	} catch (error) {
		return { page, loaded: false, error: error instanceof Error ? error.message : String(error) }
	}
}
