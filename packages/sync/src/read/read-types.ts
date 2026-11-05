import type { HLCTimestamp } from '@korajs/core'

/**
 * Wire types of the read-through endpoint, `POST <syncPath>/read` (first-visit parity S2,
 * `docs/design/first-visit-parity.md` section 5.4.1). They live in @korajs/sync so the read client
 * (S4b) and the server share one definition; the server keeps the request parser.
 */

/** Protocol version of the read endpoint. */
export const READ_PROTOCOL_VERSION = 1

/** Queries one request may carry (the server refuses a request with more). */
export const MAX_READ_QUERIES = 8

/** One order key of a read query. */
export interface ReadOrderBy {
	field: string
	direction: 'asc' | 'desc'
}

/** One query of a {@link ReadRequest}. */
export interface ReadQuery {
	/** The client's descriptor hash: echoed in the answer, never interpreted. */
	key: string
	collection: string
	/** The local query language: a value (`$eq`) or an object of `$eq $ne $gt $gte $lt $lte $in`. */
	where: Record<string, unknown>
	orderBy: ReadOrderBy[]
	limit?: number
	offset?: number
	/** Relations to include (depth 1): a relation name, or the related collection's name. */
	include?: string[]
	/** Ids the device would show for this query from seeds (at most 1,000). */
	known?: string[]
	/** Continue a partial answer. */
	cursor?: string
}

/** The body of `POST <syncPath>/read`. */
export interface ReadRequest {
	v: typeof READ_PROTOCOL_VERSION
	schemaVersion: number
	queries: ReadQuery[]
}

/** One record of an answer: current values in the delivery wire form, with their versions. */
export interface ReadRecord {
	id: string
	/** The schema fields, as a scope entry carries them. */
	values: Record<string, unknown>
	/** The HLC of the write that produced each field's current value. */
	fieldVersions: Record<string, HLCTimestamp>
	/** The record's first operation (its creation). */
	created: HLCTimestamp
	/** The record's newest operation. */
	latest: HLCTimestamp
}

/**
 * - `ok`: `records` are the complete answer.
 * - `partial`: the answer is incomplete, never to be treated as the full result; `cursor`
 *   continues it when more rows exist (absent when a cap was reached or the cause is not
 *   paging, e.g. encrypted records left out or an incomplete include). See `reason`.
 * - `unsupported`: the server cannot answer the query. For a shape it cannot evaluate,
 *   `records` are scoped candidates for the client's own SQL (a superset), never a complete
 *   answer; for a limit (candidates, work, scope width) or a server that requires encryption
 *   they are empty. See `reason`.
 * - `denied`: the collection is unknown to the principal's grant.
 */
export type ReadStatus = 'ok' | 'partial' | 'unsupported' | 'denied'

/** How complete the records of one included collection are. */
export interface ReadIncludeStatus {
	/**
	 * - `ok`: every related record the principal may read is in `included`.
	 * - `partial`: some are missing, see `reason`.
	 * - `unsupported`: the server did not resolve the relation, see `reason`.
	 * - `denied`: the principal's grant does not cover the related collection.
	 */
	status: 'ok' | 'partial' | 'unsupported' | 'denied'
	reason?: string
}

/** The answer to one query. */
export interface ReadResult {
	key: string
	status: ReadStatus
	/**
	 * Why the answer is not `ok`: `row-cap`, `byte-budget`, `query-row-cap`,
	 * `too-many-candidates`, `work-budget`, `scope-too-wide`, `encrypted-records`,
	 * `encryption-required`, `unsupported-shape`, `include-incomplete`, `known-truncated`.
	 * Absent when the status is `ok` or `denied`.
	 */
	reason?: string
	/** The primary collection's records, in the order the query asks for. */
	records: ReadRecord[]
	/** Included records by related collection. */
	included: Record<string, ReadRecord[]>
	/** How complete each included collection is; an include that is not `ok` makes the result `partial`. */
	includedStatus: Record<string, ReadIncludeStatus>
	/**
	 * `known` ids that are readable but are not in `records` (they moved out of the query, or
	 * fall outside this page): current values, to re-seed the device's copy.
	 */
	refreshed: ReadRecord[]
	/**
	 * `known` ids the principal may not read now, or that do not exist. One list for both, so
	 * it is no oracle for the existence of an id outside the grant.
	 */
	absent: string[]
	cursor?: string
}

/** The body of a 200 answer. */
export interface ReadResponse {
	/**
	 * The delivery counter, read AFTER the rows: every operation a returned row reflects was
	 * committed before the row was read, so its delivery sequence is at most `frontier`.
	 */
	frontier: number
	/** A hash of the grant the rows were read under; it changes when the grant does. */
	grantKey: string
	results: ReadResult[]
}

/** The body of an error answer. */
export interface ReadErrorBody {
	error: {
		code: string
		message: string
		retriable: boolean
		/** Milliseconds to wait before retrying (also sent as `Retry-After`). */
		retryAfterMs?: number
		/** The limit that was exceeded (413). */
		limit?: number
	}
}
