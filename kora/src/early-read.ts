import type { SchemaDefinition } from '@korajs/core'
import type { QueryDescriptor } from '@korajs/store'
import type { ReadFetch, ReadFetchResponse, ReadQuery, ReadRequest } from '@korajs/sync/read'
import { readEndpointUrl, toReadQuery } from './read-query'
import { readThroughAuthFor } from './read-through-auth'
import type { ReadTracker } from './read-tracker'
import type { KoraConfig } from './types'

/**
 * Reads sent by the first paint, before the answers chunk (`pre-ready-answers-loader`) arrives
 * (first-visit parity S0 P2). On a first visit that chunk is one more round trip, and waiting
 * for it put the first screen's data request behind it. These reads build exactly the request
 * the chunk's read client would (same queries, in the same turns, in the same order), and hand
 * the response over through the client's `fetch`: a request the client would send that matches
 * one already in flight is answered by it, once. Anything else (a different batch, a query the
 * early path skipped) is sent as before, so the worst case is the old behaviour.
 */
export interface EarlyReads {
	/** Ask for a query's answer now, without waiting for the answers chunk. */
	ask(descriptor: QueryDescriptor): void
	/** Ask nothing more: the answers chunk arrived and its client takes over. */
	stop(): void
	/** The fetch the chunk's read client uses. */
	readonly fetch: ReadFetch
}

/** As the read client: queries asked in one turn travel in one request, at most this many. */
const MAX_QUERIES_PER_REQUEST = 8

/** The read protocol version (`READ_PROTOCOL_VERSION`), checked against the request type. */
const READ_VERSION: ReadRequest['v'] = 1

/** Thrown inside the auth check to say "no early read" (the client then decides as before). */
class NoEarlyRead extends Error {
	constructor(message: string, _code?: string, _retriable?: boolean) {
		super(message)
	}
}

/**
 * @param sync - The app's sync configuration (read-through on)
 * @param schema - The app's schema
 * @param firstVisit - Settles true when this visit reads through (no completed replica)
 * @param tracker - Counts each early request until it settles
 */
export function createEarlyReads(
	sync: NonNullable<KoraConfig['sync']>,
	schema: SchemaDefinition,
	firstVisit: Promise<boolean>,
	tracker?: ReadTracker,
): EarlyReads {
	const url = readEndpointUrl(sync.url)
	const schemaVersion = sync.schemaVersion ?? schema.version
	// `sync.authClient` overrides `sync.auth`, as for the chunk's client.
	const auth =
		sync.authClient !== undefined
			? readThroughAuthFor(sync.authClient, NoEarlyRead as never)
			: sync.auth
	const inFlight = new Map<string, Promise<ReadFetchResponse>>()
	let turn: ReadQuery[] = []
	let stopped = false

	const send = async (queries: ReadQuery[]): Promise<void> => {
		try {
			await sendNow(queries)
		} finally {
			// Each query was counted when it was asked for.
			for (const _ of queries) tracker?.end()
		}
	}

	const sendNow = async (queries: ReadQuery[]): Promise<void> => {
		if (!(await firstVisit) || queries.length === 0) return
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			accept: 'application/json',
		}
		if (auth !== undefined) {
			try {
				headers.authorization = `Bearer ${(await auth()).token}`
			} catch {
				return // No credential (signed out, still loading): the client decides, as before.
			}
		}
		const body = JSON.stringify({ v: READ_VERSION, schemaVersion, queries } satisfies ReadRequest)
		const response = fetch(url, { method: 'POST', headers, body }) as Promise<ReadFetchResponse>
		inFlight.set(body, response)
		// Counted until the response arrives; one nobody takes over is dropped, and its failure
		// is not unhandled.
		await response.catch(() => {})
	}

	const flush = (): void => {
		const queries = turn
		turn = []
		for (let start = 0; start < queries.length; start += MAX_QUERIES_PER_REQUEST) {
			void send(queries.slice(start, start + MAX_QUERIES_PER_REQUEST))
		}
	}

	return {
		ask(descriptor) {
			if (stopped) return
			const query = toReadQuery(descriptor, schema)
			if (query === null || turn.some((other) => other.key === query.key)) return
			if (turn.length === 0) setTimeout(flush, 0)
			turn.push(query)
			// Counted from the ask, so a read still waiting for its turn holds the runtime too.
			tracker?.begin()
		},
		stop() {
			stopped = true
		},
		fetch(requestUrl, init) {
			const early = requestUrl === url ? inFlight.get(init.body) : undefined
			if (early !== undefined) {
				inFlight.delete(init.body)
				return early
			}
			return fetch(requestUrl, init) as Promise<ReadFetchResponse>
		},
	}
}
