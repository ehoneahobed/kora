import type { CollectionDigest } from '../../../browser/digest'

/**
 * What the parity harness and the two apps share in the page: the probe that records timings
 * (installed inline at the top of `<head>` by the build, see probe.ts) and the configuration the
 * harness injects before the page loads.
 */

/** One timed event. `t` is milliseconds since navigation start (`performance.now()`). */
export interface ParityEvent {
	name: string
	screen?: string
	id?: string
	t: number
}

export interface ParityProbe {
	events: ParityEvent[]
	/**
	 * Main-thread stalls: `[start, gap]` for every tick of a 10 ms timer that arrived more than
	 * 50 ms late (the `longtask` observer reports nothing in headless Chromium).
	 */
	stalls: Array<[number, number]>
	/** `first-contentful-paint`, whatever painted it. */
	fcp: number | null
	/** Render time of the `elementtiming="app-shell"` heading: the app itself, not a placeholder. */
	shellPaint: number | null
	/** Record `name` at the current time. */
	mark(name: string, detail?: { screen?: string; id?: string }): void
}

export interface ParityConfig {
	/** The school the signed-in user belongs to (the Kora app filters its home query by it). */
	school: string
	/** The rows the home screen must show, in order: `[id, title]` (screen complete, P3). */
	expectHome: Array<[string, string]>
	/** Diagnostic only: `disabled` runs the Kora app with `sync.querySubsets.mode = 'disabled'`. */
	subsets?: 'disabled'
}

/** Where both apps keep the bearer token (the harness signs in by writing it before load). */
export const TOKEN_STORAGE_KEY = 'parity-token'

/** What the Kora app exposes to the harness (read after the timings): status and a digest. */
export interface ParityKoraHandle {
	offlineState(): string
	offlineReasons(): string[]
	pendingOperations(): number | null
	syncStatus(): string | null
	digest(collections: readonly string[]): Promise<Record<string, CollectionDigest>>
}

declare global {
	interface Window {
		__parity?: ParityProbe
		__parityConfig?: ParityConfig
		__parityKora?: ParityKoraHandle
	}
}
