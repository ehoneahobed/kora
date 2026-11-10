import { ReadThroughClient, ReadThroughError } from '@korajs/sync/read'
import { PreReadyAnswers } from './pre-ready-answers'
import { readThroughAuthFor } from './read-through-auth'
import type { KoraConfig } from './types'

/** `<syncPath>/read` over http(s) for a sync URL that may be ws(s) and may carry a query. */
function readEndpointUrl(syncUrl: string): string {
	const http = syncUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/[?#].*$/, '')
	return `${http.replace(/\/+$/, '')}/read`
}

/**
 * The pre-ready answer service of a read-through app. One dynamic import brings it and its
 * dependencies together, so the first paint's JavaScript carries none of this and a first
 * visit fetches it in one step.
 *
 * @param sync - The app's sync configuration
 * @param schema - The app's schema
 * @returns The answer service
 */
export function createPreReadyAnswers(
	sync: NonNullable<KoraConfig['sync']>,
	schema: KoraConfig['schema'],
): PreReadyAnswers {
	// `sync.authClient` overrides `sync.auth` when both are set, as it does for sync.
	const auth =
		sync.authClient !== undefined
			? readThroughAuthFor(sync.authClient, ReadThroughError)
			: sync.auth
	return new PreReadyAnswers({
		schema,
		source: new ReadThroughClient({
			url: readEndpointUrl(sync.url),
			schemaVersion: sync.schemaVersion ?? schema.version,
			...(auth !== undefined ? { auth } : {}),
		}),
	})
}
