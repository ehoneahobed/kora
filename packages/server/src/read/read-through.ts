import { createHash } from 'node:crypto'
import type {
	CollectionDefinition,
	HLCTimestamp,
	RecordFieldVersions,
	SchemaDefinition,
} from '@korajs/core'
import { SyncError } from '@korajs/core'
import {
	type QueryEvalDescriptor,
	checkPatchable,
	compareQueryRecords,
	isUnrestrictedScope,
	matchesQuery,
	scopeBranches,
} from '@korajs/core/internal'
import { NoAuthProvider } from '../auth/no-auth'
import type { Logger } from '../logging/structured-logger'
import { recordMatchesScopes } from '../scopes/server-scope-filter'
import { toWireValue } from '../session/scope-entry'
import type { MaterializedRecord, ServerStore } from '../store/server-store'
import type { AuthContext, AuthProvider } from '../types'
import { type ReadGrant, computeReadGrant } from './read-grant'
import {
	MAX_READ_PUSHDOWN_QUERIES,
	ReadLimiter,
	type ReadLimits,
	type ReadThroughOptions,
	resolveReadLimits,
} from './read-limits'
import {
	InvalidReadRequestError,
	READ_PROTOCOL_VERSION,
	type ReadErrorBody,
	type ReadQuery,
	type ReadRecord,
	type ReadRequest,
	type ReadResponse,
	type ReadResult,
	parseReadRequest,
} from './read-types'

/**
 * The read-through endpoint (`POST <syncPath>/read`), first-visit parity S2
 * (`docs/design/first-visit-parity.md` section 5.4).
 *
 * It answers a query from the server's current rows under exactly the grant a sync session
 * would stream to the same credential: authenticated per request, the scope taken from the
 * credential and the access rules (never from the request), a query's own `where` only
 * narrowing it. It returns current row snapshots with their field versions, and the delivery
 * counter read after the rows, never operations or tombstones.
 */

/** What the HTTP host gives the service for one request. */
export interface ReadHttpRequest {
	method: string
	/** The raw `Authorization` header. */
	authorization?: string | undefined
	/** The request body (JSON). */
	body?: string | Uint8Array | undefined
	/** The `Content-Type` header. */
	contentType?: string | undefined
	/** True when the request carries a `Cookie` header. */
	hasCookie?: boolean | undefined
	/** The `x-kora-read` header. */
	koraReadHeader?: string | undefined
	/** The `Origin` header. */
	origin?: string | undefined
	/** The `Host` header. */
	host?: string | undefined
	/** The caller's address: the bucket of requests that carry no credential or a bad one. */
	clientKey?: string | undefined
}

/** The answer. */
export interface ReadHttpResponse {
	status: 200 | 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 429 | 500
	body?: string
	headers: Record<string, string>
}

/** What the service needs from the server. */
export interface ReadThroughDeps {
	store: ServerStore
	auth: AuthProvider | null
	logger: Logger
	/** The schema version the rows are shaped by; a request for another is refused. */
	schemaVersion: number
	/** True when the server refuses plaintext operations: nothing can be read through. */
	encryptionRequired?: boolean
	maxScopePredicateValues?: number | undefined
	options?: ReadThroughOptions | undefined
	/** Clock (ms), injected for tests. */
	now?: () => number
}

const BASE_HEADERS: Record<string, string> = {
	'content-type': 'application/json',
	'cache-control': 'no-store, private',
	vary: 'Authorization, Cookie',
}

/** The most field-version reads in flight for one answer. */
const VERSION_READ_CONCURRENCY = 16
/** The most primary records an `include` of a one-to-many relation fans out for. */
const MAX_ONE_TO_MANY_FANOUT = 200

/** A grant that changed while rows were read; the answer is built again. */
class GrantChangedDuringRead extends Error {}

/** A scope too wide to read through store equality queries. */
class ScopeTooWide extends Error {}

/** The read-through service of one server. */
export class ReadThroughService {
	private readonly limits: ReadLimits
	private readonly enabled: boolean
	private readonly limiter: ReadLimiter
	private readonly now: () => number

	constructor(private readonly deps: ReadThroughDeps) {
		this.limits = resolveReadLimits(deps.options)
		this.enabled = deps.options?.enabled !== false
		this.now = deps.now ?? Date.now
		this.limiter = new ReadLimiter(this.limits, this.now)
	}

	/** True when the endpoint answers (it answers 404 when switched off). */
	isEnabled(): boolean {
		return this.enabled
	}

	/**
	 * Answer one request. Never throws: every failure is an HTTP answer.
	 *
	 * @param request - The request as the HTTP host read it
	 */
	async handle(request: ReadHttpRequest): Promise<ReadHttpResponse> {
		const started = this.now()
		try {
			return await this.handleRequest(request, started)
		} catch (error) {
			this.deps.logger.log({
				timestamp: this.now(),
				level: 'error',
				event: 'read.failed',
				error: error instanceof Error ? error.message : String(error),
			})
			return failure(500, 'READ_FAILED', 'The read failed. Try again.', true)
		}
	}

	private async handleRequest(
		request: ReadHttpRequest,
		started: number,
	): Promise<ReadHttpResponse> {
		if (!this.enabled || !this.deps.store.getSchema()) {
			return failure(
				404,
				'READ_UNAVAILABLE',
				'Read-through is not available on this server.',
				false,
			)
		}
		if (request.method !== 'POST') {
			return {
				...failure(405, 'METHOD_NOT_ALLOWED', 'Use POST.', false),
				headers: { ...BASE_HEADERS, allow: 'POST' },
			}
		}
		// A JSON content type forces a CORS preflight on a cross-site page, and a cookie
		// credential additionally needs the custom header and a same-origin Origin (V19).
		if (!isJson(request.contentType)) {
			return failure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send application/json.', false)
		}
		const csrf = csrfRefusal(request)
		if (csrf !== null) return csrf

		const bodyBytes =
			typeof request.body === 'string' ? Buffer.byteLength(request.body) : request.body?.byteLength
		if (bodyBytes === undefined || bodyBytes === 0) {
			return failure(400, 'INVALID_READ_REQUEST', 'The request has no body.', false)
		}
		if (bodyBytes > this.limits.maxRequestBytes) {
			return failure(413, 'REQUEST_TOO_LARGE', 'The request is too large.', false, {
				limit: this.limits.maxRequestBytes,
			})
		}

		// Credential-less and failing callers share the bucket of their address, so guessing
		// tokens is not free; an authenticated caller has its own bucket below.
		let addressSlot: { release: () => void } | null = null
		if (request.clientKey !== undefined) {
			const admission = this.limiter.admit(`addr:${request.clientKey}`)
			if (!admission.admitted) return tooMany(admission.reason, admission.retryAfterMs)
			addressSlot = admission
		}
		let context: AuthContext | null
		try {
			const authenticated = await this.authenticate(request.authorization)
			if (authenticated === 'unauthorized') {
				return {
					...failure(401, 'AUTH_FAILED', 'Authentication failed.', false),
					headers: { ...BASE_HEADERS, 'www-authenticate': 'Bearer' },
				}
			}
			context = authenticated
		} finally {
			addressSlot?.release()
		}

		let parsed: ReadRequest
		try {
			parsed = parseReadRequest(
				typeof request.body === 'string'
					? request.body
					: new TextDecoder().decode(request.body as Uint8Array),
			)
		} catch (error) {
			if (error instanceof InvalidReadRequestError) {
				return failure(400, 'INVALID_READ_REQUEST', error.message, false)
			}
			throw error
		}
		if (parsed.schemaVersion !== this.deps.schemaVersion) {
			return failure(
				409,
				'SCHEMA_MISMATCH',
				`The server reads schema version ${this.deps.schemaVersion}; the request is for ${parsed.schemaVersion}.`,
				false,
			)
		}

		const principalKey =
			context === null
				? `addr:${request.clientKey ?? 'anonymous'}`
				: context.anonymous === true
					? `anon:${request.clientKey ?? 'anonymous'}`
					: `user:${context.userId}`
		const slot = this.limiter.admit(principalKey)
		if (!slot.admitted) return tooMany(slot.reason, slot.retryAfterMs)
		try {
			// Rows are read under a grant, and the grant is read again after them: a
			// membership that changed meanwhile means the rows may belong to the old grant, so
			// the answer is built again once, then refused retriably (V1).
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					const built = await this.answer(parsed, context)
					if (!built.ok) return built.response
					this.deps.logger.log({
						timestamp: this.now(),
						level: 'info',
						event: 'read.answered',
						duration: this.now() - started,
						count: built.rows,
						details: {
							queries: parsed.queries.length,
							statuses: built.statuses,
							frontier: built.response.frontier,
						},
					})
					return {
						status: 200,
						body: JSON.stringify(built.response),
						headers: { ...BASE_HEADERS },
					}
				} catch (error) {
					if (error instanceof GrantChangedDuringRead && attempt === 0) continue
					if (error instanceof GrantChangedDuringRead) {
						return failure(
							409,
							'ACCESS_RULES_CHANGED',
							'Memberships changed while the rows were read. Try again.',
							true,
						)
					}
					if (error instanceof InvalidReadRequestError) {
						return failure(400, 'INVALID_READ_REQUEST', error.message, false)
					}
					if (isRetriableIndexError(error)) {
						return failure(
							409,
							'ACCESS_RULES_CHANGED',
							'The membership index is being rebuilt. Try again shortly.',
							true,
						)
					}
					throw error
				}
			}
			return failure(500, 'READ_FAILED', 'The read failed. Try again.', true)
		} finally {
			slot.release()
		}
	}

	/** Authenticate as the sync handshake does: the same provider, the same checks. */
	private async authenticate(
		authorization: string | undefined,
	): Promise<AuthContext | null | 'unauthorized'> {
		const { auth } = this.deps
		if (!auth || auth instanceof NoAuthProvider) return null
		const token = parseBearer(authorization)
		if (token === null) return 'unauthorized'
		let context: AuthContext | null
		try {
			context = await auth.authenticate(token)
		} catch {
			return 'unauthorized'
		}
		if (context === null) return 'unauthorized'
		// The `kora:` namespace belongs to principals Kora synthesizes (RT-12).
		if (context.anonymous !== true && context.userId.startsWith('kora:')) return 'unauthorized'
		// A credential past its expiry reads nothing, as a session would be ended (AUTH-11).
		if (context.expiresAt !== undefined && context.expiresAt <= this.now()) return 'unauthorized'
		return context
	}

	private async answer(
		request: ReadRequest,
		context: AuthContext | null,
	): Promise<
		| { ok: true; response: ReadResponse; rows: number; statuses: Record<string, number> }
		| { ok: false; response: ReadHttpResponse }
	> {
		const { store } = this.deps
		const schema = store.getSchema()
		if (!schema) {
			return {
				ok: false,
				response: failure(404, 'READ_UNAVAILABLE', 'Read-through is not available.', false),
			}
		}
		const grantInput = {
			store,
			auth: this.deps.auth,
			context,
			maxScopePredicateValues: this.deps.maxScopePredicateValues,
			now: this.now(),
		}
		const granted = await computeReadGrant(grantInput)
		if (!granted.ok) {
			return {
				ok: false,
				response: failure(granted.status, granted.code, granted.message, granted.retriable),
			}
		}
		const grant = granted.grant

		const run = new RunState(this.limits)
		const results: ReadResult[] = []
		for (const query of request.queries) {
			results.push(await this.runQuery(query, grant, schema, run))
		}
		// F is read AFTER every row of the answer, so each operation a row reflects was
		// committed before the row was read and its delivery sequence is at most F (V2).
		const frontier = await store.getMaxDeliverySequence()

		const after = await computeReadGrant({ ...grantInput, now: this.now() })
		if (!after.ok || after.grant.basis !== grant.basis) throw new GrantChangedDuringRead()

		const statuses: Record<string, number> = {}
		for (const result of results) statuses[result.status] = (statuses[result.status] ?? 0) + 1
		return {
			ok: true,
			response: { frontier, grantKey: grant.grantKey, results },
			rows: run.rows,
			statuses,
		}
	}

	private async runQuery(
		query: ReadQuery,
		grant: ReadGrant,
		schema: SchemaDefinition,
		run: RunState,
	): Promise<ReadResult> {
		const empty = (status: ReadResult['status'], absent: string[] = []): ReadResult => ({
			key: query.key,
			status,
			records: [],
			included: {},
			refreshed: [],
			absent,
		})
		const definition = Object.prototype.hasOwnProperty.call(schema.collections, query.collection)
			? schema.collections[query.collection]
			: undefined
		const scope = collectionScope(grant, query.collection)
		// An unknown collection and a denied one answer alike: no oracle for either.
		if (definition === undefined || scope === null) return empty('denied', query.known ?? [])
		// A server that refuses plaintext holds no readable record.
		if (this.deps.encryptionRequired === true) return empty('unsupported', query.known ?? [])

		const readable = new Readable(this.deps.store, grant, schema, run)
		const cursor = decodeCursor(query)

		// 1. Scoped candidates: the scope pushed down to the store, then judged in JavaScript.
		let candidates: MaterializedRecord[]
		let capped = false
		try {
			const found = await this.scopedCandidates(query, definition, scope, readable)
			candidates = found.rows
			capped = found.capped
		} catch (error) {
			if (error instanceof ScopeTooWide) return empty('unsupported', query.known ?? [])
			throw error
		}

		// 2. Encrypted records are never answered (the server holds no plaintext for them).
		const sealed = await readable.sealedIds(
			query.collection,
			candidates.map((row) => row.id),
		)
		if (sealed === null || sealed.size > 0) return empty('unsupported', query.known ?? [])

		// 3. Filter and order with the evaluator the client's overlay runs.
		const descriptor: QueryEvalDescriptor = {
			where: query.where,
			orderBy: query.orderBy,
			...(query.limit !== undefined ? { limit: query.limit } : {}),
		}
		const verdict = checkPatchable(descriptor, definition)
		const included = query.include ?? []
		const includeSpecs = included.map((name) => resolveRelation(schema, query.collection, name))
		const supported = verdict.patchable && includeSpecs.every((spec) => spec !== null)

		let ordered: MaterializedRecord[]
		if (supported) {
			const view = (row: MaterializedRecord): Record<string, unknown> => evalView(row, definition)
			ordered = candidates
				.filter((row) => matchesQuery(descriptor, view(row)))
				.sort((a, b) => compareQueryRecords(descriptor, view(a), view(b)) || compareIds(a.id, b.id))
		} else {
			// A shape the evaluator is not proven on: every scoped candidate, for the
			// client's own SQL to decide.
			ordered = candidates.sort((a, b) => compareIds(a.id, b.id))
		}

		// 4. The page: a cursor continues, a limit and the row caps end it.
		const baseOffset = supported ? (cursor?.base ?? query.offset ?? 0) : 0
		const start = supported ? (cursor?.next ?? baseOffset) : 0
		const wantedEnd = Math.min(
			supported && query.limit !== undefined ? baseOffset + query.limit : Number.POSITIVE_INFINITY,
			ordered.length,
		)
		const rowCap = Math.min(
			this.limits.maxRows,
			Math.max(0, this.limits.maxQueryRows - (start - baseOffset)),
		)
		const wanted = ordered.slice(start, Math.min(wantedEnd, start + rowCap))
		const built = await readable.recordsFor(query.collection, wanted)
		const pageEnd = start + built.length
		let status: ReadResult['status'] = supported ? 'ok' : 'unsupported'
		let nextCursor: string | undefined
		if (supported && pageEnd < wantedEnd) {
			status = 'partial'
			const queryRowsDone = pageEnd - baseOffset
			if (queryRowsDone < this.limits.maxQueryRows) {
				nextCursor = encodeCursor(query, baseOffset, pageEnd)
			}
		}
		if (capped && status === 'ok') status = 'partial'
		run.rows += built.length

		// 5. Included relations, each under its own collection's grant.
		const includedRecords: Record<string, ReadRecord[]> = {}
		if (supported) {
			for (const spec of includeSpecs) {
				if (spec === null) continue
				const related = await this.includeRelation(spec, wanted, readable)
				if (related.length > 0) {
					includedRecords[spec.relatedCollection] = [
						...(includedRecords[spec.relatedCollection] ?? []),
						...related,
					]
				}
			}
		}

		// 6. `known`: current values for readable ids outside this page, `absent` for the rest.
		const known = await this.resolveKnown(query, built, scope, readable)
		if (known.truncated && status === 'ok') status = 'partial'

		return {
			key: query.key,
			status,
			records: built,
			included: includedRecords,
			refreshed: known.refreshed,
			absent: known.absent,
			...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
		}
	}

	/**
	 * The records of the collection inside the principal's scope (and the query's own plain
	 * string equalities), at most `maxCandidates`. The store is asked for what it can compare
	 * exactly (string equalities and one string `$in` per scope branch); every row is judged
	 * again in JavaScript against the whole scope.
	 */
	private async scopedCandidates(
		query: ReadQuery,
		definition: CollectionDefinition,
		scope: Record<string, unknown>,
		readable: Readable,
	): Promise<{ rows: MaterializedRecord[]; capped: boolean }> {
		const { store } = this.deps
		const extra = queryEqualities(query, definition)
		const found = new Map<string, MaterializedRecord>()
		let capped = false
		let storeQueries = 0
		const branches = isUnrestrictedScope(scope) ? [{}] : scopeBranches(scope)
		for (const branch of branches) {
			const equalities: Record<string, unknown> = {}
			let inField: { field: string; values: readonly unknown[] } | null = null
			for (const [field, predicate] of Object.entries(branch)) {
				const list =
					predicate !== null && typeof predicate === 'object' && !Array.isArray(predicate)
						? (predicate as { $in?: unknown }).$in
						: undefined
				// Only strings are pushed down to the store query (a store may not compare other
				// types, e.g. booleans on Postgres); everything is re-checked below.
				if (Array.isArray(list)) {
					if (inField === null && list.every((value) => typeof value === 'string')) {
						inField = { field, values: list }
					}
				} else if (typeof predicate === 'string') equalities[field] = predicate
			}
			// The query's equalities narrow the branch; a contradiction leaves it empty.
			let empty = false
			for (const [field, value] of Object.entries(extra)) {
				if (field in equalities) {
					if (equalities[field] !== value) empty = true
				} else if (inField !== null && inField.field === field) {
					if (!inField.values.includes(value)) empty = true
					else inField = null
					equalities[field] = value
				} else equalities[field] = value
			}
			if (empty) continue
			const queries: Record<string, unknown>[] = inField
				? inField.values.map((value) => ({
						...equalities,
						[(inField as { field: string }).field]: value,
					}))
				: [equalities]
			storeQueries += queries.length
			if (storeQueries > MAX_READ_PUSHDOWN_QUERIES) throw new ScopeTooWide()
			for (const where of queries) {
				const rows = await store.queryCollection(query.collection, { where })
				for (const row of rows) {
					if (
						recordMatchesScopes(
							query.collection,
							{ ...row, id: row.id },
							{ [query.collection]: scope },
						)
					) {
						found.set(String(row.id), row)
						if (found.size > this.limits.maxCandidates) {
							capped = true
							break
						}
					}
				}
				if (capped) break
			}
			if (capped) break
		}
		const rows = [...found.values()]
		return { rows: capped ? rows.slice(0, this.limits.maxCandidates) : rows, capped }
	}

	/** Records of a related collection for the primary page, each under its own grant. */
	private async includeRelation(
		spec: RelationSpec,
		primary: readonly MaterializedRecord[],
		readable: Readable,
	): Promise<ReadRecord[]> {
		const { store } = this.deps
		const relatedScope = collectionScope(readable.grant, spec.relatedCollection)
		if (relatedScope === null || primary.length === 0) return []
		let rows: MaterializedRecord[] = []
		if (spec.direction === 'parent') {
			const ids = [
				...new Set(
					primary
						.map((row) => row[spec.field])
						.filter((value): value is string => typeof value === 'string' && value.length > 0),
				),
			]
			if (ids.length === 0) return []
			const map = store.findRecordsByIds
				? await store.findRecordsByIds(spec.relatedCollection, ids)
				: new Map(
						(await Promise.all(ids.map((id) => store.findRecord(spec.relatedCollection, id))))
							.filter((row): row is MaterializedRecord => row !== null)
							.map((row) => [row.id, row] as const),
					)
			rows = [...map.values()]
		} else {
			if (primary.length > MAX_ONE_TO_MANY_FANOUT) return []
			const parts = await Promise.all(
				primary.map((row) =>
					store.queryCollection(spec.relatedCollection, { where: { [spec.field]: row.id } }),
				),
			)
			rows = parts.flat()
		}
		rows = rows.filter(
			(row) =>
				row._deleted !== 1 &&
				row._deleted !== true &&
				recordMatchesScopes(
					spec.relatedCollection,
					{ ...row, id: row.id },
					{ [spec.relatedCollection]: relatedScope },
				),
		)
		rows = rows.slice(0, this.limits.maxRows)
		const sealed = await readable.sealedIds(
			spec.relatedCollection,
			rows.map((row) => row.id),
		)
		// An included collection holding encrypted records is left out whole.
		if (sealed === null || sealed.size > 0) return []
		return readable.recordsFor(spec.relatedCollection, rows)
	}

	private async resolveKnown(
		query: ReadQuery,
		page: readonly ReadRecord[],
		scope: Record<string, unknown>,
		readable: Readable,
	): Promise<{ refreshed: ReadRecord[]; absent: string[]; truncated: boolean }> {
		const { store } = this.deps
		const known = [...new Set(query.known ?? [])]
		if (known.length === 0) return { refreshed: [], absent: [], truncated: false }
		const inPage = new Set(page.map((record) => record.id))
		const rows = store.findRecordsByIds
			? await store.findRecordsByIds(query.collection, known)
			: new Map(
					(
						await Promise.all(
							known.map(async (id) => {
								const found = await store.queryCollection(query.collection, {
									where: { id },
									limit: 1,
								})
								return found[0]
							}),
						)
					)
						.filter((row): row is MaterializedRecord => row !== undefined)
						.map((row) => [row.id, row] as const),
				)
		const readableRows: MaterializedRecord[] = []
		const absent: string[] = []
		for (const id of known) {
			const row = rows.get(id)
			const gone = row === undefined || row._deleted === 1 || row._deleted === true
			const outside =
				!gone &&
				!recordMatchesScopes(query.collection, { ...row, id }, { [query.collection]: scope })
			// One list for "gone", "outside the grant" and (below) "sealed": no oracle.
			if (gone || outside) absent.push(id)
			else if (!inPage.has(id)) readableRows.push(row)
		}
		const sealed = await readable.sealedIds(
			query.collection,
			readableRows.map((row) => row.id),
		)
		if (sealed === null) {
			return {
				refreshed: [],
				absent: [...absent, ...readableRows.map((row) => row.id)],
				truncated: false,
			}
		}
		const fresh: MaterializedRecord[] = []
		for (const row of readableRows) {
			if (sealed.has(row.id)) absent.push(row.id)
			else fresh.push(row)
		}
		const refreshed = await readable.recordsFor(query.collection, fresh)
		return { refreshed, absent, truncated: refreshed.length < fresh.length }
	}
}

/** Per-request state: the byte budget and counters shared by the queries of one answer. */
class RunState {
	bytesLeft: number
	rows = 0
	constructor(readonly limits: ReadLimits) {
		this.bytesLeft = limits.maxBytes
	}
}

/**
 * Reads of one answer: encrypted-record checks, field versions and the byte budget. One
 * instance per query, sharing the answer's {@link RunState}.
 */
class Readable {
	constructor(
		private readonly store: ServerStore,
		readonly grant: ReadGrant,
		readonly schema: SchemaDefinition,
		private readonly run: RunState,
	) {}

	/**
	 * Which of `ids` have encrypted operations; null when the store cannot tell (then the
	 * collection is not read through: fail closed).
	 */
	async sealedIds(collection: string, ids: readonly string[]): Promise<Set<string> | null> {
		if (ids.length === 0) return new Set()
		const check = this.store.recordsWithEncryptedOperations
		if (typeof check !== 'function') return null
		return check.call(this.store, collection, ids)
	}

	/**
	 * Wire records for rows, in order, while the answer's byte budget lasts (the first record
	 * of an answer is always returned, so a record larger than the budget still progresses).
	 */
	async recordsFor(collection: string, rows: readonly MaterializedRecord[]): Promise<ReadRecord[]> {
		const definition = this.schema.collections[collection]
		if (definition === undefined) return []
		const out: ReadRecord[] = []
		for (let i = 0; i < rows.length; i += VERSION_READ_CONCURRENCY) {
			const slice = rows.slice(i, i + VERSION_READ_CONCURRENCY)
			const built = await Promise.all(
				slice.map((row) => this.recordFor(collection, definition, row)),
			)
			for (const record of built) {
				const size = Buffer.byteLength(JSON.stringify(record))
				if (this.run.bytesLeft - size < 0 && (out.length > 0 || this.run.rows > 0)) return out
				this.run.bytesLeft -= size
				out.push(record)
			}
		}
		return out
	}

	private async recordFor(
		collection: string,
		definition: CollectionDefinition,
		row: MaterializedRecord,
	): Promise<ReadRecord> {
		const store = this.store
		const values: Record<string, unknown> = {}
		for (const field of Object.keys(definition.fields)) {
			if (!(field in row)) continue
			const value = row[field]
			if (value === undefined) continue
			values[field] = toWireValue(value)
		}
		let versions: RecordFieldVersions | null = null
		if (store.getRecordFieldVersions) {
			try {
				versions = await store.getRecordFieldVersions(collection, row.id)
			} catch {
				// Falls back to one whole-row stamp below, as a scope entry does.
			}
		}
		let latest: HLCTimestamp = versions?.latest ?? {
			wallTime: 0,
			logical: 0,
			nodeId: 'kora:scope-entry',
		}
		if (!versions && store.getRecordLatestTimestamp) {
			try {
				latest = (await store.getRecordLatestTimestamp(collection, row.id)) ?? latest
			} catch {
				// Keep the fallback stamp: it is below every real write, so a later write wins.
			}
		}
		const created = versions?.created ?? latest
		const fieldVersions: Record<string, HLCTimestamp> = {}
		for (const field of Object.keys(values)) {
			fieldVersions[field] = { ...(versions?.fields[field] ?? created) }
		}
		return { id: row.id, values, fieldVersions, created: { ...created }, latest: { ...latest } }
	}
}

interface RelationSpec {
	relatedCollection: string
	/** `parent`: the primary rows hold the foreign key; `children`: the related rows do. */
	direction: 'parent' | 'children'
	field: string
}

/**
 * The relation an `include` names: a relation key of the schema, or the related collection's
 * name, in either direction. Null when none matches (the query is then `unsupported`).
 */
function resolveRelation(
	schema: SchemaDefinition,
	collection: string,
	name: string,
): RelationSpec | null {
	const relations = Object.entries(schema.relations ?? {})
	const fromRelation = (relation: {
		from: string
		to: string
		field: string
	}): RelationSpec | null => {
		if (relation.from === collection) {
			return { relatedCollection: relation.to, direction: 'parent', field: relation.field }
		}
		if (relation.to === collection) {
			return { relatedCollection: relation.from, direction: 'children', field: relation.field }
		}
		return null
	}
	for (const [key, relation] of relations) {
		if (key === name) return fromRelation(relation)
	}
	for (const [, relation] of relations) {
		if (relation.from === collection && relation.to === name) return fromRelation(relation)
		if (relation.to === collection && relation.from === name) return fromRelation(relation)
	}
	return null
}

/** String equalities of a query on plain string and enum fields, safe to push to the store. */
function queryEqualities(
	query: ReadQuery,
	definition: CollectionDefinition,
): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [field, condition] of Object.entries(query.where)) {
		const kind = Object.prototype.hasOwnProperty.call(definition.fields, field)
			? definition.fields[field]?.kind
			: undefined
		if ((kind === 'string' || kind === 'enum') && typeof condition === 'string') {
			out[field] = condition
		}
	}
	return out
}

/** The principal's scope of one collection: `{}` unrestricted, null when denied. */
function collectionScope(grant: ReadGrant, collection: string): Record<string, unknown> | null {
	if (grant.scopes === undefined) return {}
	return Object.prototype.hasOwnProperty.call(grant.scopes, collection)
		? (grant.scopes[collection] as Record<string, unknown>)
		: null
}

/** A record as the evaluator reads it: schema fields, `id`, and the virtual timestamps. */
function evalView(
	row: MaterializedRecord,
	definition: CollectionDefinition,
): Record<string, unknown> {
	const view: Record<string, unknown> = { id: row.id }
	for (const field of Object.keys(definition.fields)) {
		if (field in row) view[field] = row[field]
	}
	if (!Object.prototype.hasOwnProperty.call(definition.fields, 'createdAt')) {
		view.createdAt = row._created_at
	}
	if (!Object.prototype.hasOwnProperty.call(definition.fields, 'updatedAt')) {
		view.updatedAt = row._updated_at
	}
	return view
}

/** Ties break by id (code point order), so a page boundary is the same on every read. */
function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

/** The shape a cursor belongs to: it continues this query and no other. */
function shapeHash(query: ReadQuery): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				query.collection,
				query.where,
				query.orderBy,
				query.limit ?? null,
				query.offset ?? null,
				query.include ?? null,
			]),
		)
		.digest('base64url')
		.slice(0, 16)
}

function encodeCursor(query: ReadQuery, base: number, next: number): string {
	return Buffer.from(JSON.stringify({ h: shapeHash(query), b: base, n: next })).toString(
		'base64url',
	)
}

function decodeCursor(query: ReadQuery): { base: number; next: number } | null {
	if (query.cursor === undefined) return null
	try {
		const raw: unknown = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
		const fields = raw as { h?: unknown; b?: unknown; n?: unknown }
		if (
			fields.h === shapeHash(query) &&
			typeof fields.b === 'number' &&
			typeof fields.n === 'number' &&
			Number.isSafeInteger(fields.b) &&
			Number.isSafeInteger(fields.n) &&
			fields.b >= 0 &&
			fields.n >= fields.b
		) {
			return { base: fields.b, next: fields.n }
		}
	} catch {
		// Falls through to the refusal below.
	}
	throw new InvalidReadRequestError(`The cursor of query "${query.key}" does not belong to it.`)
}

function isJson(contentType: string | undefined): boolean {
	return contentType !== undefined && /^application\/json\s*(;|$)/i.test(contentType.trim())
}

/**
 * A cookie rides along on a cross-site request, so a cookie credential is honored only with
 * the custom header (which a cross-site form cannot set) and an Origin of this host (V19).
 */
function csrfRefusal(request: ReadHttpRequest): ReadHttpResponse | null {
	if (request.hasCookie !== true) return null
	if (request.koraReadHeader !== '1') {
		return failure(
			403,
			'CSRF_REFUSED',
			'A cookie-authenticated read needs the x-kora-read: 1 header.',
			false,
		)
	}
	if (request.origin !== undefined && request.host !== undefined) {
		let originHost: string | null = null
		try {
			originHost = new URL(request.origin).host
		} catch {
			originHost = null
		}
		if (originHost !== request.host) {
			return failure(403, 'CSRF_REFUSED', 'The read must come from this origin.', false)
		}
	}
	return null
}

/** The token of a `Bearer <token>` header; '' when absent (anonymous); null when malformed. */
function parseBearer(authorization: string | undefined): string | null {
	if (authorization === undefined || authorization.trim() === '') return ''
	const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization.trim())
	return match?.[1] ?? null
}

function isRetriableIndexError(error: unknown): boolean {
	return (
		error instanceof SyncError &&
		(error.context as { code?: unknown } | undefined)?.code === 'ACCESS_INDEX_NOT_READY'
	)
}

function tooMany(reason: 'rate' | 'concurrent' | 'busy', retryAfterMs: number): ReadHttpResponse {
	const base = failure(
		429,
		reason === 'rate' ? 'RATE_LIMITED' : 'TOO_MANY_READS',
		'Too many reads. Retry after the hint.',
		true,
		{ retryAfterMs },
	)
	return {
		...base,
		headers: {
			...BASE_HEADERS,
			'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
		},
	}
}

function failure(
	status: ReadHttpResponse['status'],
	code: string,
	message: string,
	retriable: boolean,
	extra: { retryAfterMs?: number; limit?: number } = {},
): ReadHttpResponse {
	const body: ReadErrorBody = { error: { code, message, retriable, ...extra } }
	return { status, body: JSON.stringify(body), headers: { ...BASE_HEADERS } }
}

export { READ_PROTOCOL_VERSION }
