import type { BrowserContext, Page } from 'playwright-core'

/**
 * Runs in the page (via `addInitScript` and `evaluate`): offsets `Date.now()` and `new Date()`.
 * Idempotent and replaceable: it always layers on the real `Date`, so calling it again with a new
 * offset replaces the previous one, and `0` restores real time.
 *
 * Exported for unit tests; it must stay self-contained because Playwright serializes its source.
 *
 * @param offsetMs - Milliseconds to add to the real time (negative moves the clock back)
 */
export function installClockSkew(offsetMs: number): void {
	const g = globalThis as { Date: DateConstructor; __koraRealDate?: DateConstructor }
	const RealDate = g.__koraRealDate ?? g.Date
	g.__koraRealDate = RealDate
	const skewed: DateConstructor = new Proxy(RealDate, {
		construct(target, args: unknown[], newTarget): object {
			if (args.length === 0) return new target(RealDate.now() + offsetMs)
			return Reflect.construct(target, args, newTarget === skewed ? target : newTarget)
		},
		apply() {
			return new RealDate(RealDate.now() + offsetMs).toString()
		},
		get(target, property) {
			if (property === 'now') return () => RealDate.now() + offsetMs
			return Reflect.get(target, property, target)
		},
	})
	g.Date = skewed
}

/**
 * Moves the page's clock by `ms` milliseconds, for clock-skew and grace-period tests (a device
 * whose clock is fast or slow, `maxOfflineGraceMs` elapsing, a token expiring).
 *
 * **It affects `Date.now()`, `new Date()` and `Date()` only.** `performance.now()`, timers
 * (`setTimeout` still waits real time), `Intl` formatting of the current time, the server's
 * clock and code running inside service workers or other workers are not skewed. The skew is
 * installed with an init script, so it survives reloads and applies to every frame; given a page
 * it also takes effect in the current document at once. Calling it again replaces the skew;
 * `skewClock(target, 0)` restores real time.
 *
 * @param target - A page, or a context to skew every page created in it from now on
 * @param ms - Offset in milliseconds; positive is a fast clock, negative a slow one
 *
 * @example
 * ```typescript
 * await skewClock(page, 10 * 60_000) // this device is ten minutes fast
 * await page.reload()
 * ```
 */
export async function skewClock(target: Page | BrowserContext, ms: number): Promise<void> {
	await target.addInitScript(installClockSkew, ms)
	if ('evaluate' in target) {
		await target.evaluate(installClockSkew, ms)
	}
}
