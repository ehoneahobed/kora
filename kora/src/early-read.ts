import type { SchemaDefinition } from '@korajs/core'
import type { QueryDescriptor } from '@korajs/store'
import type { ReadFetch, ReadFetchResponse, ReadQuery, ReadRequest } from '@korajs/sync/read'
import type { KoraConfig } from './types'

/**
 * The first screen's read, sent by the first paint before the answers chunk
 * (`pre-ready-answers-loader`) arrives (first-visit parity S0 P2). On a first visit that chunk is
 * one more round trip, and waiting for it put the first screen's data request behind it.
 *
 * Only the queries of the first turn are sent, in one request built exactly as the chunk's read
 * client builds it (same queries, same order); the client takes that request's response over
 * through its `fetch`, once. (A first turn of more than 8 queries the client splits, so its
 * requests differ and the early response goes unused: correct, only not faster.) Later reads, and a first turn the client batches differently, go
 * through the client as before. This is first-paint code (the K3 budget), so it stays minimal.
 */
export interface EarlyRead {
	/** Ask for a query's answer now, without waiting for the answers chunk. */
	ask(descriptor: QueryDescriptor): void
	/** The fetch the chunk's read client uses. */
	readonly fetch: ReadFetch
	/** Settles once the first request was sent (or decided not to be), or after 300 ms. */
	readonly firstSend: Promise<void>
}

/** `<syncPath>/read` over http(s) for a sync URL that may be ws(s) and may carry a query. */
export function readEndpointUrl(syncUrl: string): string {
	// ws → http, wss → https; an http(s) URL is kept.
	return `${syncUrl
		.replace(/^ws/, 'http')
		.replace(/[?#].*$/, '')
		.replace(/\/+$/, '')}/read`
}

/**
 * The read query for a descriptor, as `toReadQuery` (read-query.ts) builds it, without its
 * refusals (relations, rich text, an unknown collection, a key too long) and its copies: the
 * client refuses those queries, so a first turn holding one is sent by the client differently
 * and the early response goes unused, which is correct, only not faster. Kept minimal: this is
 * first-paint code (the K3 budget). A test checks both build the same JSON for plain queries.
 */
export function earlyQuery(descriptor: QueryDescriptor): ReadQuery {
	const { collection, where, orderBy, limit, offset } = descriptor
	return {
		key: JSON.stringify([collection, where, orderBy, limit ?? null, offset ?? null]),
		collection,
		where,
		orderBy,
		limit,
		offset,
	}
}

/**
 * @param sync - The app's sync configuration (read-through on)
 * @param schema - The app's schema
 * @param firstVisit - Settles true when this visit reads through (no completed replica)
 */
export function createEarlyRead(
	sync: NonNullable<KoraConfig['sync']>,
	schema: SchemaDefinition,
	firstVisit: Promise<boolean>,
): EarlyRead {
	const url = readEndpointUrl(sync.url)
	const queries: ReadQuery[] = []
	let early: { body: string; response: Promise<ReadFetchResponse> } | null = null
	let sent: () => void = () => {}
	const firstSend = new Promise<void>((resolve) => {
		sent = resolve
	})
	// Counted from createApp, so it must cover the first query mounting and being sent on a slow
	// device (at 4x CPU that took ~90 ms; a 50 ms cap let the chunk go first, and the read then
	// opened its own connection beside it). A screen that asks nothing does not hold the chunk
	// back longer than this.
	setTimeout(sent, 300)
	// One request, for the first turn. With `sync.authClient` there is none: asking a lazily
	// loaded sign-in client for its session would download it during the first paint, the link
	// this read spares (the chunk's client reads then, as before).
	let open = sync.authClient === undefined

	return {
		firstSend,
		ask(descriptor) {
			if (!open) return
			if (queries.length === 0) {
				setTimeout(async () => {
					open = false
					try {
						const token = (await firstVisit) ? (await sync.auth?.())?.token : ''
						if (token === '') return
						const body = JSON.stringify({
							v: 1,
							schemaVersion: sync.schemaVersion ?? schema.version,
							queries,
						} satisfies ReadRequest)
						// The endpoint reads no `accept` header; only the body must match the client's.
						const headers: Record<string, string> = { 'content-type': 'application/json' }
						if (token) headers.authorization = `Bearer ${token}`
						const response = fetch(url, {
							method: 'POST',
							headers,
							body,
						}) as Promise<ReadFetchResponse>
						// A response nobody takes over is dropped; its failure is not unhandled.
						response.catch(() => {})
						early = { body, response }
					} catch {
						// No credential: the chunk's client reads, as before.
					} finally {
						sent()
					}
				}, 0)
			}
			queries.push(earlyQuery(descriptor))
		},
		fetch(requestUrl, init) {
			const taken = early
			if (taken !== null && requestUrl === url && init.body === taken.body) {
				early = null
				return taken.response
			}
			return fetch(requestUrl, init) as Promise<ReadFetchResponse>
		},
	}
}
