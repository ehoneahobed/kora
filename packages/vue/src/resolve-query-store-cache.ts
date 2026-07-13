import { QueryStoreCache } from '@korajs/store'
import type { KoraAppLike } from '../types'

/**
 * Resolves the per-app query cache when available, otherwise a provider-local fallback.
 */
export function resolveQueryStoreCache(
	app: KoraAppLike | null | undefined,
	fallback: QueryStoreCache,
): QueryStoreCache {
	if (app && typeof app.getQueryStoreCache === 'function') {
		return app.getQueryStoreCache()
	}
	return fallback
}
