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
	/** Settles once the first request was sent (or decided not to be), or after 50 ms. */
	readonly firstSend: Promise<void>
}

/** `<syncPath>/read` over http(s) for a sync URL that may be ws(s) and may carry a query. */
export function readEndpointUrl(syncUrl: string): string {
	const http = syncUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/[?#].*$/, '')
	return `${http.replace(/\/+$/, '')}/read`
}

/**
 * The read query for a descriptor, as `toReadQuery` (read-query.ts) builds it, without its
 * refusals (rich text, an unknown collection, a key too long): the client refuses those, so a
 * first turn holding one is sent by the client differently and the early response goes unused,
 * which is correct, only not faster. Kept out of the first paint's code: the K3 budget.
 */
export function earlyQuery(descriptor: QueryDescriptor): ReadQuery {
	return {
		key: JSON.stringify([
			descriptor.collection,
			descriptor.where,
			descriptor.orderBy,
			descriptor.limit ?? null,
			descriptor.offset ?? null,
		]),
		collection: descriptor.collection,
		where: descriptor.where,
		orderBy: descriptor.orderBy.map((entry) => ({
			field: entry.field,
			direction: entry.direction,
		})),
		limit: descriptor.limit,
		offset: descriptor.offset,
	}
}

/** Longest the answers chunk waits for the first early request to leave. */
const FIRST_SEND_WAIT_MS = 50

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
	// A screen that asks nothing within 50 ms does not hold the answers chunk back longer.
	setTimeout(sent, FIRST_SEND_WAIT_MS)
	// Closed after the first turn: one request, for the first screen.
	let open = true

	const send = async (): Promise<void> => {
		// The endpoint reads no `accept` header; only the body must match the client's.
		const headers: Record<string, string> = { 'content-type': 'application/json' }
		// With `sync.authClient` the early read is skipped: asking a lazily loaded sign-in client
		// for its session would download it during the first paint, the link this read spares.
		// The chunk's client reads then, as before.
		if (sync.authClient !== undefined) return
		const token = (await sync.auth?.())?.token
		if (token === '') return
		if (token !== undefined) headers.authorization = `Bearer ${token}`
		const body = JSON.stringify({
			v: 1,
			schemaVersion: sync.schemaVersion ?? schema.version,
			queries,
		} satisfies ReadRequest)
		const response = fetch(url, { method: 'POST', headers, body }) as Promise<ReadFetchResponse>
		// A response nobody takes over is dropped; its failure is not unhandled.
		response.catch(() => {})
		early = { body, response }
	}

	return {
		firstSend,
		ask(descriptor) {
			if (!open) return
			// A relational query is answered by the store (as toReadQuery refuses it).
			if (descriptor.include?.length) return
			const query = earlyQuery(descriptor)
			if (queries.length === 0) {
				setTimeout(() => {
					open = false
					void firstVisit
						.then((first) => (first ? send() : undefined))
						.catch(() => {})
						.then(sent)
				}, 0)
			}
			queries.push(query)
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
