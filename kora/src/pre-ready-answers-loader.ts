import { type ReadFetch, ReadThroughClient, ReadThroughError } from '@korajs/sync/read'
import { PreReadyAnswers } from './pre-ready-answers'
import { readEndpointUrl } from './read-query'
import { readThroughAuthFor } from './read-through-auth'
import type { ReadTracker } from './read-tracker'
import type { KoraConfig } from './types'

/**
 * The pre-ready answer service of a read-through app. One dynamic import brings it and its
 * dependencies together, so the first paint's JavaScript carries none of this and a first
 * visit fetches it in one step.
 *
 * @param sync - The app's sync configuration
 * @param schema - The app's schema
 * @param fetch - The fetch the read client uses (the early reads' hand-over)
 * @param tracker - Counts the reads waiting for an answer
 * @returns The answer service
 */
export function createPreReadyAnswers(
	sync: NonNullable<KoraConfig['sync']>,
	schema: KoraConfig['schema'],
	fetch?: ReadFetch,
	tracker?: ReadTracker,
): PreReadyAnswers {
	// `sync.authClient` overrides `sync.auth` when both are set, as it does for sync.
	const auth =
		sync.authClient !== undefined
			? readThroughAuthFor(sync.authClient, ReadThroughError)
			: sync.auth
	const client = new ReadThroughClient({
		url: readEndpointUrl(sync.url),
		schemaVersion: sync.schemaVersion ?? schema.version,
		...(auth !== undefined ? { auth } : {}),
		// Answers a request the first paint already sent (early-read.ts) with its response.
		...(fetch !== undefined ? { fetch } : {}),
	})
	return new PreReadyAnswers({
		schema,
		source: {
			// Each read counts from the ask until it settles, so the runtime's downloads wait.
			read(query, options) {
				tracker?.begin()
				const reading = client.read(query, options)
				const end = (): void => tracker?.end()
				reading.then(end, end)
				return reading
			},
		},
	})
}
