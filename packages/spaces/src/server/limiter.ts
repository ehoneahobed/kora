/**
 * Counts requests against a limit. `hit` records one request under `key` and answers
 * whether it is within `limit` requests per `windowMs`. The default keeps counts in
 * memory per server instance; a deployment with several instances passes one backed
 * by shared storage (Redis, its database) so the limits hold across instances.
 */
export interface SpacesLimiter {
	hit(key: string, limit: number, windowMs: number): Promise<boolean> | boolean
	/**
	 * Give back one hit of `key` (a request that was counted but then refused). Optional:
	 * without it, refused invitations count toward the daily caps.
	 */
	release?(key: string, windowMs: number): Promise<void> | void
}

/** Keys kept before expired windows are pruned. */
const PRUNE_AT = 10_000
/** Hard ceiling on keys: past it the shortest windows are dropped (their counts restart). */
const MAX_KEYS = 100_000

/**
 * An in-memory, fixed-window limiter for one server instance.
 *
 * @param now - The clock (for tests)
 */
export function memoryLimiter(
	now: () => number = Date.now,
): SpacesLimiter & { readonly size: number } {
	const windows = new Map<string, { count: number; resetAt: number; windowMs: number }>()
	let pruneAt = PRUNE_AT
	return {
		/** Windows currently kept (for monitoring). */
		get size() {
			return windows.size
		},
		release(key) {
			const current = windows.get(key)
			if (current && current.resetAt > now() && current.count > 0) current.count -= 1
		},
		hit(key, limit, windowMs) {
			const at = now()
			if (windows.size >= pruneAt) {
				for (const [k, w] of windows) if (w.resetAt <= at) windows.delete(k)
				if (windows.size > MAX_KEYS) {
					// Drop the shortest windows first (per-minute counts), so long ones (daily
					// caps) survive a flood of short-lived keys.
					const byWindow = [...windows].sort((a, b) => a[1].windowMs - b[1].windowMs)
					for (const [k] of byWindow) {
						if (windows.size <= MAX_KEYS) break
						windows.delete(k)
					}
				}
				// From the size after pruning and trimming: not pruning again until the map
				// doubles keeps each hit cheap, and the map never exceeds twice the ceiling.
				pruneAt = Math.min(Math.max(PRUNE_AT, windows.size * 2), MAX_KEYS * 2)
			}
			const current = windows.get(key)
			if (!current || current.resetAt <= at) {
				windows.delete(key)
				windows.set(key, { count: 1, resetAt: at + windowMs, windowMs })
				return limit >= 1
			}
			current.count += 1
			return current.count <= limit
		},
	}
}
