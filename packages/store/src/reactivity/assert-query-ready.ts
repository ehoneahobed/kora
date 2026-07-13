import { AppNotReadyError } from '@korajs/core'
import type { QueryBuilder } from '../query/query-builder'

const LEGACY_PENDING_COLLECTION = '__pending__'

/**
 * Ensures a query builder is backed by an open store (not a legacy pending placeholder).
 */
export function assertQueryReady(query: QueryBuilder<unknown>): void {
	const descriptor = query.getDescriptor()
	if (descriptor.collection === LEGACY_PENDING_COLLECTION) {
		throw new AppNotReadyError(
			'Cannot use useQuery() before app.ready. Await app.ready or wrap your UI in <KoraProvider app={app}>.',
		)
	}
}
