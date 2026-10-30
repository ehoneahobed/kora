import type { HLCTimestamp } from '@korajs/core'
import { isPlainRecord } from '@korajs/core/internal'
import { isStorableIdentifier } from '../apply/ingest-validation'
import {
	MAX_READ_INCLUDES,
	MAX_READ_KNOWN,
	MAX_READ_ORDER_KEYS,
	MAX_READ_QUERIES,
	MAX_READ_WHERE_FIELDS,
} from './read-limits'

/**
 * Wire types of the read-through endpoint, `POST <syncPath>/read` (first-visit parity S2,
 * `docs/design/first-visit-parity.md` section 5.4.1).
 */

/** Protocol version of the read endpoint. */
export const READ_PROTOCOL_VERSION = 1

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
 * - `partial`: more rows exist than one answer may carry; `cursor` continues (absent when
 *   the query's row cap was reached).
 * - `unsupported`: the server cannot evaluate the shape (or the collection holds encrypted
 *   records); `records` are scoped candidates for the client's own SQL (a superset), never
 *   a complete answer, and are empty for encrypted records.
 * - `denied`: the collection is unknown to the principal's grant.
 */
export type ReadStatus = 'ok' | 'partial' | 'unsupported' | 'denied'

/** The answer to one query. */
export interface ReadResult {
	key: string
	status: ReadStatus
	/** The primary collection's records, in the order the query asks for. */
	records: ReadRecord[]
	/** Included records by related collection. */
	included: Record<string, ReadRecord[]>
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

/** A request the server could not read; answered 400 `INVALID_READ_REQUEST`. */
export class InvalidReadRequestError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'InvalidReadRequestError'
	}
}

/**
 * Parse and validate a request body. Strict: an unknown shape is refused, never guessed at,
 * and nothing in the body is trusted beyond what is checked here (the grant is computed from
 * the credential, not from anything the request says).
 *
 * @param text - The JSON body
 * @throws {InvalidReadRequestError} When the body is not a well-formed request
 */
export function parseReadRequest(text: string): ReadRequest {
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		throw new InvalidReadRequestError('The request body is not valid JSON.')
	}
	if (!isPlainRecord(raw)) throw new InvalidReadRequestError('The request body must be an object.')
	if (raw.v !== READ_PROTOCOL_VERSION) {
		throw new InvalidReadRequestError(
			`Unsupported read protocol version (expected ${READ_PROTOCOL_VERSION}).`,
		)
	}
	if (!Number.isSafeInteger(raw.schemaVersion) || (raw.schemaVersion as number) < 0) {
		throw new InvalidReadRequestError('schemaVersion must be a non-negative integer.')
	}
	if (!Array.isArray(raw.queries) || raw.queries.length === 0) {
		throw new InvalidReadRequestError('queries must be a non-empty array.')
	}
	if (raw.queries.length > MAX_READ_QUERIES) {
		throw new InvalidReadRequestError(`A request carries at most ${MAX_READ_QUERIES} queries.`)
	}
	const keys = new Set<string>()
	const queries = raw.queries.map((entry, index) => {
		const query = parseQuery(entry, index)
		if (keys.has(query.key)) {
			throw new InvalidReadRequestError(`Query keys must be unique ("${query.key}" repeats).`)
		}
		keys.add(query.key)
		return query
	})
	return { v: READ_PROTOCOL_VERSION, schemaVersion: raw.schemaVersion as number, queries }
}

function parseQuery(entry: unknown, index: number): ReadQuery {
	const at = `queries[${index}]`
	if (!isPlainRecord(entry)) throw new InvalidReadRequestError(`${at} must be an object.`)
	const key = text(entry.key, `${at}.key`, 256)
	const collection = text(entry.collection, `${at}.collection`, 256)
	const where = entry.where === undefined ? {} : entry.where
	if (!isPlainRecord(where)) throw new InvalidReadRequestError(`${at}.where must be an object.`)
	const fields = Object.keys(where)
	if (fields.length > MAX_READ_WHERE_FIELDS) {
		throw new InvalidReadRequestError(
			`${at}.where holds more than ${MAX_READ_WHERE_FIELDS} fields.`,
		)
	}
	for (const field of fields) {
		if (!isStorableIdentifier(field)) {
			throw new InvalidReadRequestError(`${at}.where holds a malformed field name.`)
		}
		checkCondition(where[field], `${at}.where.${field}`)
	}
	const orderBy = entry.orderBy === undefined ? [] : entry.orderBy
	if (!Array.isArray(orderBy) || orderBy.length > MAX_READ_ORDER_KEYS) {
		throw new InvalidReadRequestError(
			`${at}.orderBy must be an array of at most ${MAX_READ_ORDER_KEYS} keys.`,
		)
	}
	const order = orderBy.map((clause, i): ReadOrderBy => {
		if (!isPlainRecord(clause)) {
			throw new InvalidReadRequestError(`${at}.orderBy[${i}] must be an object.`)
		}
		const field = text(clause.field, `${at}.orderBy[${i}].field`, 256)
		const direction = clause.direction === undefined ? 'asc' : clause.direction
		if (direction !== 'asc' && direction !== 'desc') {
			throw new InvalidReadRequestError(`${at}.orderBy[${i}].direction must be "asc" or "desc".`)
		}
		return { field, direction }
	})
	const query: ReadQuery = { key, collection, where, orderBy: order }
	if (entry.limit !== undefined) query.limit = count(entry.limit, `${at}.limit`)
	if (entry.offset !== undefined) query.offset = count(entry.offset, `${at}.offset`)
	if (entry.include !== undefined) {
		if (!Array.isArray(entry.include) || entry.include.length > MAX_READ_INCLUDES) {
			throw new InvalidReadRequestError(
				`${at}.include must be an array of at most ${MAX_READ_INCLUDES} relations.`,
			)
		}
		query.include = entry.include.map((name, i) => text(name, `${at}.include[${i}]`, 256))
	}
	if (entry.known !== undefined) {
		if (!Array.isArray(entry.known) || entry.known.length > MAX_READ_KNOWN) {
			throw new InvalidReadRequestError(
				`${at}.known must be an array of at most ${MAX_READ_KNOWN} ids.`,
			)
		}
		query.known = entry.known.map((id, i) => text(id, `${at}.known[${i}]`, 256))
	}
	if (entry.cursor !== undefined) query.cursor = text(entry.cursor, `${at}.cursor`, 512)
	return query
}

function checkCondition(condition: unknown, at: string): void {
	if (isScalar(condition)) return
	if (!isPlainRecord(condition)) {
		throw new InvalidReadRequestError(`${at} must be a value or an object of operators.`)
	}
	for (const [operator, operand] of Object.entries(condition)) {
		if (Array.isArray(operand)) {
			// An oversized or mixed list is an unsupported shape (answered, not refused), but
			// its members are scalars or the request is malformed.
			if (!operand.every(isScalar)) {
				throw new InvalidReadRequestError(`${at}.${operator} must hold scalar values.`)
			}
		} else if (!isScalar(operand)) {
			throw new InvalidReadRequestError(`${at}.${operator} must be a scalar value.`)
		}
	}
}

function isScalar(value: unknown): boolean {
	return (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	)
}

function text(value: unknown, at: string, max: number): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > max) {
		throw new InvalidReadRequestError(`${at} must be a string of 1 to ${max} characters.`)
	}
	if (!isStorableIdentifier(value)) {
		throw new InvalidReadRequestError(`${at} holds U+0000 or an unpaired surrogate.`)
	}
	return value
}

function count(value: unknown, at: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new InvalidReadRequestError(`${at} must be a non-negative integer.`)
	}
	return value
}
