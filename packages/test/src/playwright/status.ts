import { OfflineAssertionError } from './errors'
import { DEFAULT_OFFLINE_ACCESSOR, type OfflineStatusLike, type StatusReadOptions } from './types'

/** The slice of Playwright's `Page` the status helpers use. */
export interface EvaluatingPage {
	evaluate<R, A>(pageFunction: (arg: A) => R | Promise<R>, arg: A): Promise<R>
}

/**
 * Resolves `accessor` against `root` and returns the status snapshot, or `null` when the path
 * does not resolve yet (the app has not started) or does not look like an offline handle.
 *
 * This function runs inside the page through `page.evaluate`, so it must stay self-contained:
 * no imports, no closures. It is exported so it can be unit tested against a fake root.
 *
 * @param input - The accessor path and the object to resolve it against (`globalThis` in the page)
 * @returns A structured-cloneable status snapshot, or `null`
 */
export function readStatusFrom(input: { accessor: string; root?: unknown }): unknown {
	let node: unknown = input.root ?? globalThis
	for (const key of input.accessor.split('.')) {
		if (node === null || node === undefined) return null
		node = (node as Record<string, unknown>)[key]
	}
	if (node === null || node === undefined) return null
	const status = (node as { status?: unknown }).status
	if (typeof status !== 'function') return null
	let snapshot: unknown
	try {
		snapshot = (status as () => unknown).call(node)
	} catch {
		return null
	}
	if (snapshot === null || typeof snapshot !== 'object') return null
	// Round-trip through JSON so the value always crosses the page boundary, even when the
	// app returns frozen objects or class instances.
	return JSON.parse(JSON.stringify(snapshot))
}

/**
 * Narrows an unknown page value to an {@link OfflineStatusLike}.
 *
 * @param value - Whatever the page returned
 * @returns `true` when the value has a valid `state` and a `reasons` array
 */
export function isOfflineStatus(value: unknown): value is OfflineStatusLike {
	if (value === null || typeof value !== 'object') return false
	const v = value as { state?: unknown; reasons?: unknown }
	return (
		(v.state === 'ready' || v.state === 'preparing' || v.state === 'not-ready') &&
		Array.isArray(v.reasons)
	)
}

/**
 * Whether an evaluation failed only because the page was navigating, closing or crashing.
 *
 * @param error - The thrown value
 * @returns `true` for a navigation or teardown race
 */
export function isTransientEvaluationError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return /Execution context was destroyed|Target (page, context or browser )?(has been )?closed|Cannot find context|Frame was detached|Target crashed|Page crashed|navigat/i.test(
		message,
	)
}

/**
 * Reads the current offline status from the page once.
 *
 * Returns `null` while the app or its offline handle does not exist yet, and also while the
 * page is navigating (an evaluation torn down by a navigation is not an error here).
 *
 * @param page - The page to read from
 * @param options - Where the offline handle lives
 * @returns The status snapshot, or `null`
 *
 * @example
 * ```typescript
 * const status = await readOfflineStatus(page)
 * if (status?.state === 'ready') console.log('ready')
 * ```
 */
export async function readOfflineStatus(
	page: EvaluatingPage,
	options: StatusReadOptions = {},
): Promise<OfflineStatusLike | null> {
	const accessor = options.accessor ?? DEFAULT_OFFLINE_ACCESSOR
	let value: unknown
	try {
		value = await page.evaluate(readStatusFrom, { accessor })
	} catch (error) {
		// A navigation or a crash destroys the execution context mid-evaluate. The caller is
		// polling for a condition, so "no status right now" is the honest answer.
		if (isTransientEvaluationError(error)) return null
		throw error
	}
	return isOfflineStatus(value) ? value : null
}

/** A state name or a predicate over the offline status. */
export type StatusMatcher = OfflineStatusLike['state'] | ((status: OfflineStatusLike) => boolean)

/**
 * Normalizes a {@link StatusMatcher} into a predicate.
 *
 * @param matcher - A state name (`'ready'`) or a predicate
 * @returns A predicate over the status
 */
export function toPredicate(matcher: StatusMatcher): (status: OfflineStatusLike) => boolean {
	return typeof matcher === 'function' ? matcher : (status) => status.state === matcher
}

/**
 * Builds a predicate that matches a status listing `reason` (for example `'shell-not-installed'`).
 *
 * @param reason - An `OfflineReason`
 * @returns A predicate usable with {@link waitForOfflineStatus}
 */
export function hasReason(reason: string): (status: OfflineStatusLike) => boolean {
	return (status) => status.reasons.includes(reason)
}

/** Options for {@link waitForOfflineStatus}. */
export interface WaitForOfflineStatusOptions extends StatusReadOptions {
	/** Give up after this many milliseconds. Default 30000. */
	timeoutMs?: number
	/** Delay between reads. Default 50. The wait ends on the condition, not on a fixed sleep. */
	pollMs?: number
	/** Replaceable delay, for deterministic unit tests. */
	sleep?: (ms: number) => Promise<void>
	/** Replaceable clock, for deterministic unit tests. */
	now?: () => number
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits until the page's offline status satisfies `matcher`, and returns that status.
 *
 * It polls `app.offline.status()` (the accessor is configurable) and survives navigations: a
 * read that races a reload is retried. It throws {@link OfflineAssertionError}
 * (`OFFLINE_STATUS_TIMEOUT`) with the last status it saw when the condition never holds.
 *
 * @param page - The page running the app
 * @param matcher - A state name, or a predicate over the status
 * @param options - Accessor, timeout and polling
 * @returns The first status that matched
 *
 * @example
 * ```typescript
 * const status = await waitForOfflineStatus(page, 'ready')
 * await waitForOfflineStatus(page, (s) => s.reasons.includes('data-incomplete'))
 * ```
 */
export async function waitForOfflineStatus(
	page: EvaluatingPage,
	matcher: StatusMatcher,
	options: WaitForOfflineStatusOptions = {},
): Promise<OfflineStatusLike> {
	const predicate = toPredicate(matcher)
	const timeoutMs = options.timeoutMs ?? 30_000
	const pollMs = options.pollMs ?? 50
	const sleep = options.sleep ?? defaultSleep
	const now = options.now ?? Date.now
	const deadline = now() + timeoutMs
	let last: OfflineStatusLike | null = null
	for (;;) {
		const status = await readOfflineStatus(page, options)
		if (status !== null) {
			last = status
			if (predicate(status)) return status
		}
		if (now() >= deadline) break
		await sleep(pollMs)
	}
	throw new OfflineAssertionError(
		`Offline status did not reach the expected condition within ${timeoutMs}ms. Last status: ${
			last === null ? 'none (the offline handle was not found)' : JSON.stringify(last)
		}. Check that the accessor "${options.accessor ?? DEFAULT_OFFLINE_ACCESSOR}" matches where your app exposes app.offline.`,
		'OFFLINE_STATUS_TIMEOUT',
		{ last, timeoutMs },
	)
}
