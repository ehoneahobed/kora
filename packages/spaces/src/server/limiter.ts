/**
 * Counts requests against a limit. `hit` records one request under `key` and answers
 * whether it is within `limit` requests per `windowMs`. The default keeps counts in
 * memory per server instance; a deployment with several instances passes one backed
 * by shared storage (Redis, its database) so the limits hold across instances.
 */
export interface SpacesLimiter {
	hit(key: string, limit: number, windowMs: number): Promise<boolean> | boolean
}

/** Keys kept before expired windows are pruned. */
const PRUNE_AT = 10_000
/** Hard ceiling on keys: past it the oldest windows are dropped (their counts restart). */
const MAX_KEYS = 100_000

/**
 * An in-memory, fixed-window limiter for one server instance.
 *
 * @param now - The clock (for tests)
 */
export function memoryLimiter(now: () => number = Date.now): SpacesLimiter {
	const windows = new Map<string, { count: number; resetAt: number }>()
	let pruneAt = PRUNE_AT
	return {
		hit(key, limit, windowMs) {
			const at = now()
			if (windows.size >= pruneAt) {
				for (const [k, w] of windows) if (w.resetAt <= at) windows.delete(k)
				// Not pruning again until the map doubles keeps each hit cheap when nothing expired.
				pruneAt = Math.max(PRUNE_AT, windows.size * 2)
				for (const k of windows.keys()) {
					if (windows.size <= MAX_KEYS) break
					windows.delete(k)
				}
			}
			const current = windows.get(key)
			if (!current || current.resetAt <= at) {
				windows.delete(key)
				windows.set(key, { count: 1, resetAt: at + windowMs })
				return limit >= 1
			}
			current.count += 1
			return current.count <= limit
		},
	}
}
