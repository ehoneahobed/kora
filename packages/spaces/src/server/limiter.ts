/**
 * Counts requests against a limit. `hit` records one request under `key` and answers
 * whether it is within `limit` requests per `windowMs`. The default keeps counts in
 * memory per server instance; a deployment with several instances passes one backed
 * by shared storage (Redis, its database) so the limits hold across instances.
 */
export interface SpacesLimiter {
	hit(key: string, limit: number, windowMs: number): Promise<boolean> | boolean
}

/** Largest number of keys the in-memory limiter keeps before pruning expired windows. */
const PRUNE_AT = 10_000

/**
 * An in-memory, fixed-window limiter for one server instance.
 *
 * @param now - The clock (for tests)
 */
export function memoryLimiter(now: () => number = Date.now): SpacesLimiter {
	const windows = new Map<string, { count: number; resetAt: number }>()
	return {
		hit(key, limit, windowMs) {
			const at = now()
			if (windows.size >= PRUNE_AT) {
				for (const [k, w] of windows) if (w.resetAt <= at) windows.delete(k)
			}
			const current = windows.get(key)
			if (!current || current.resetAt <= at) {
				windows.set(key, { count: 1, resetAt: at + windowMs })
				return limit >= 1
			}
			current.count += 1
			return current.count <= limit
		},
	}
}
