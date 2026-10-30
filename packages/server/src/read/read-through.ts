import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
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
	isPlainRecord,
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
import { addressBucket } from './address-bucket'
import { ReadAuthGuard } from './read-auth-guard'
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
	type ReadIncludeStatus,
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
	/**
	 * True when `clientKey` is a real client address (the host trusts its proxy headers or has
	 * no proxy). Only then are failed authentications charged to the address; an untrusted key
	 * may be the proxy's, shared by every user.
	 */
	clientKeyTrusted?: boolean | undefined
}

/** The answer. */
export interface ReadHttpResponse {
	status: 200 | 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 429 | 500 | 503
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

/** The request spent its whole work budget (see `ReadThroughOptions.maxWork`). */
class WorkBudgetExceeded extends Error {}

/** A record kept changing under the read, so its values and versions could not be paired. */
class RecordChurn extends Error {}

/** The authentication the answer was built under was evicted (revoked, narrowed) meanwhile. */
class AuthChangedDuringRead extends Error {}

/** The read-through service of one server. */
export class ReadThroughService {
	private readonly limits: ReadLimits
	private readonly enabled: boolean
	private readonly limiter: ReadLimiter
	private readonly anonymousLimiter: ReadLimiter
	private readonly failureLimiter: ReadLimiter
	private readonly authGuard: ReadAuthGuard
	private readonly now: () => number
	private readonly cursorKey: Buffer

	constructor(private readonly deps: ReadThroughDeps) {
		this.limits = resolveReadLimits(deps.options)
		// A cursor is a capability to read further than one page; signing it keeps a client
		// from forging one that lifts the per-query row cap.
		this.cursorKey = deps.options?.cursorSecret
			? createHash('sha256').update(deps.options.cursorSecret).digest()
			: randomBytes(32)
		this.enabled = deps.options?.enabled !== false
		this.now = deps.now ?? Date.now
		this.limiter = new ReadLimiter(this.limits, this.now)
		// Reads without an identity share a bucket per address that is sized for a deployment
		// (behind a proxy without trustProxy it is the proxy's address, for every anonymous read).
		this.anonymousLimiter = new ReadLimiter(
			{
				perSecond: this.limits.anonymousPerSecond,
				burst: this.limits.anonymousBurst,
				concurrent: this.limits.anonymousConcurrent,
				maxConcurrent: this.limits.maxConcurrent,
			},
			this.now,
		)
		this.authGuard = new ReadAuthGuard(
			{
				ttlMs: this.limits.authTtlMs,
				maxConcurrentMisses: this.limits.authMaxConcurrent,
				missesPerSecond: this.limits.authPerSecond,
				missBurst: this.limits.authBurst,
				timeoutMs: this.limits.authTimeoutMs,
				orphanTtlMs: this.limits.authOrphanTtlMs,
			},
			this.now,
		)
		// Failed authentications, per trusted address (never for a proxy's shared address).
		this.failureLimiter = new ReadLimiter(
			{
				perSecond: this.limits.perSecond,
				burst: this.limits.burst,
				concurrent: Number.MAX_SAFE_INTEGER,
				maxConcurrent: Number.MAX_SAFE_INTEGER,
			},
			this.now,
		)
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

		// Authentication is bounded by the TOKEN, not the address (see ReadAuthGuard): a cached
		// token skips the provider and every address check, so garbage cannot lock out a signed-in
		// user. Only unseen tokens reach the provider, and only a trusted real address is
		// charged for the ones that fail.
		const authenticated = await this.authenticate(request)
		if ('response' in authenticated) return authenticated.response
		let context = authenticated.context
		let stamp = authenticated.stamp

		const principalKey =
			context === null
				? `addr:${request.clientKey ?? 'anonymous'}`
				: context.anonymous === true
					? `anon:${request.clientKey ?? 'anonymous'}`
					: `user:${context.userId}`
		const anonymous = context === null || context.anonymous === true
		const slot = (anonymous ? this.anonymousLimiter : this.limiter).admit(principalKey)
		if (!slot.admitted) return tooMany(slot.reason, slot.retryAfterMs)
		try {
			// The body is parsed only now, after every cheap admission check.
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
			// Rows are read under a grant, and the grant is read again after them: a
			// membership that changed meanwhile means the rows may belong to the old grant, so
			// the answer is built again once, then refused retriably (V1).
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					const built = await this.answer(parsed, context, stamp, attempt > 0)
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
					if (error instanceof AuthChangedDuringRead && attempt === 0) {
						// The credential was revoked or its grant changed while the rows were read:
						// ask the provider again, so the rebuild runs under what is true now.
						const again = await this.authenticate(request)
						if ('response' in again) return again.response
						context = again.context
						stamp = again.stamp
						continue
					}
					if (
						(error instanceof GrantChangedDuringRead || error instanceof RecordChurn) &&
						attempt === 0
					) {
						continue
					}
					if (error instanceof RecordChurn) {
						return failure(
							409,
							'READ_CONFLICT',
							'Records kept changing while they were read. Try again.',
							true,
						)
					}
					if (error instanceof AuthChangedDuringRead) {
						return failure(
							409,
							'ACCESS_RULES_CHANGED',
							'The credential or its grant changed (revoked or refreshed) while the rows were read. Try again.',
							true,
						)
					}
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

	/**
	 * Authenticate as the sync handshake does (same provider, same checks), through the guard.
	 * Returns the context, or the HTTP answer that ends the request.
	 */
	private async authenticate(
		request: ReadHttpRequest,
	): Promise<{ context: AuthContext | null; stamp: number } | { response: ReadHttpResponse }> {
		const { auth } = this.deps
		if (!auth || auth instanceof NoAuthProvider) return { context: null, stamp: 0 }
		const token = parseBearer(request.authorization)
		const address = request.clientKeyTrusted === true ? addressBucket(request.clientKey) : null
		if (token === null) return { response: this.unauthorized(address) }

		const known = this.authGuard.lookup(token)
		if (known.kind === 'context') {
			return this.accept(known.context, address, known.stamp)
		}
		if (known.kind === 'denied') return { response: this.unauthorized(address) }

		// An address that already failed too often is refused before the provider is asked.
		if (address !== null && !this.failureLimiter.peek(address)) {
			return { response: tooMany('rate', 1000) }
		}
		let resolved: Awaited<ReturnType<ReadAuthGuard['resolve']>>
		try {
			// An address that has been failing draws from the small shared lane, so one noisy
			// address cannot spend the miss budget of clean ones.
			const lane = address !== null && this.failureLimiter.hasSpent(address) ? 'suspect' : 'clean'
			resolved = await this.authGuard.resolve(
				token,
				(signal) => auth.authenticate(token, { signal }),
				lane,
			)
		} catch (error) {
			this.deps.logger.log({
				timestamp: this.now(),
				level: 'error',
				event: 'read.auth-failed',
				error: error instanceof Error ? error.message : String(error),
			})
			// The provider itself failed: not the caller's fault, and worth retrying.
			return {
				response: failure(
					503,
					'AUTH_UNAVAILABLE',
					'Authentication is unavailable. Try again.',
					true,
				),
			}
		}
		if (resolved.kind === 'busy') {
			return {
				response: tooMany('auth-busy', resolved.retryAfterMs),
			}
		}
		if (resolved.kind === 'unavailable') {
			// Too many abandoned provider calls are still running: refuse new cold ones.
			return {
				response: failure(
					503,
					'AUTH_UNAVAILABLE',
					'Authentication is unavailable. Try again.',
					true,
				),
			}
		}
		return this.accept(resolved.context, address, resolved.stamp)
	}

	private accept(
		context: AuthContext | null,
		address: string | null,
		stamp: number,
	): { context: AuthContext; stamp: number } | { response: ReadHttpResponse } {
		if (context === null) return { response: this.unauthorized(address) }
		// The `kora:` namespace belongs to principals Kora synthesizes (RT-12).
		if (context.anonymous !== true && context.userId.startsWith('kora:')) {
			return { response: this.unauthorized(address) }
		}
		// A credential past its expiry reads nothing, as a session would be ended (AUTH-11).
		if (context.expiresAt !== undefined && context.expiresAt <= this.now()) {
			return { response: this.unauthorized(address) }
		}
		return { context, stamp }
	}

	/** The 401, charged to the address only when it is a real client address. */
	private unauthorized(address: string | null): ReadHttpResponse {
		if (address !== null) {
			const failed = this.failureLimiter.admit(address)
			if (!failed.admitted) return tooMany(failed.reason, failed.retryAfterMs)
			failed.release()
		}
		return {
			...failure(401, 'AUTH_FAILED', 'Authentication failed.', false),
			headers: { ...BASE_HEADERS, 'www-authenticate': 'Bearer' },
		}
	}

	/**
	 * The principal a request's bearer token is cached as, or null when the token is not
	 * cached (or the server has no auth). The HTTP host uses it to give known principals their
	 * own body slots, so a flood of unauthenticated senders cannot starve them and one of them
	 * cannot hold more than its share.
	 *
	 * @param authorization - The raw `Authorization` header
	 */
	cachedPrincipal(authorization: string | undefined): { userId: string } | null {
		const { auth } = this.deps
		if (!auth || auth instanceof NoAuthProvider) return null
		const token = parseBearer(authorization)
		if (token === null) return null
		const known = this.authGuard.lookup(token)
		return known.kind === 'context' ? { userId: known.context.userId } : null
	}

	/**
	 * Forget cached authentications of a revoked user (all of them when none is named). Called
	 * when the server learns of a revocation; without it a revoked token keeps reading for at
	 * most the guard's `ttlMs`.
	 *
	 * @param userId - The revoked user, or undefined for everyone
	 */
	evictAuth(userId?: string): void {
		this.authGuard.evict(userId)
	}

	private async answer(
		request: ReadRequest,
		context: AuthContext | null,
		stamp: number,
		tolerateDrops: boolean,
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

		const run = new RunState(this.limits, tolerateDrops)
		const results: ReadResult[] = []
		for (const query of request.queries) {
			results.push(await this.runQuery(query, grant, schema, run, principalId(context)))
		}
		// F is read AFTER every row of the answer, so each operation a row reflects was
		// committed before the row was read and its delivery sequence is at most F (V2).
		const frontier = await store.getMaxDeliverySequence()

		const after = await computeReadGrant({ ...grantInput, now: this.now() })
		if (!after.ok || after.grant.basis !== grant.basis) throw new GrantChangedDuringRead()
		// The grant above is built from the authentication taken before the rows were read. If
		// that authentication was evicted meanwhile (a revocation, a refreshed scope), the rows
		// may belong to a grant that no longer holds.
		if (context !== null && this.authGuard.isStale(stamp, context.userId)) {
			throw new AuthChangedDuringRead()
		}

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
		principal: string,
	): Promise<ReadResult> {
		// `absent` tells a device to delete the seeds of those ids, so it lists only ids that
		// are truly gone or denied: the denied and encryption-required answers below pass
		// `query.known`; a limit of the server never does.
		const empty = (
			status: ReadResult['status'],
			reason?: string,
			absent: string[] = [],
		): ReadResult => ({
			key: query.key,
			status,
			...(reason !== undefined ? { reason } : {}),
			records: [],
			included: {},
			includedStatus: {},
			refreshed: [],
			absent,
		})
		const definition = Object.prototype.hasOwnProperty.call(schema.collections, query.collection)
			? schema.collections[query.collection]
			: undefined
		const scope = collectionScope(grant, query.collection)
		// An unknown collection and a denied one answer alike: no oracle for either.
		if (definition === undefined || scope === null) {
			return empty('denied', undefined, query.known ?? [])
		}
		// A server that refuses plaintext holds no readable record.
		if (this.deps.encryptionRequired === true) {
			return empty('unsupported', 'encryption-required', query.known ?? [])
		}

		const readable = new Readable(this.deps.store, grant, schema, run)
		// A cursor that does not verify (another instance, a restart, a changed grant, a forged
		// one) restarts that query alone: the device asks again without it.
		const cursor = this.decodeCursor(query, principal, grant)
		if (cursor === 'invalid') return empty('unsupported', 'cursor-invalid')
		const offset = cursor === null ? (query.offset ?? 0) : cursor.offset
		const served = cursor?.served ?? 0
		const position = offset + served
		if (position >= this.limits.maxQueryRows) return empty('unsupported', 'query-row-cap')

		// 1. Scoped candidates: the scope pushed down to the store, then judged in JavaScript.
		let candidates: MaterializedRecord[]
		try {
			const found = await this.scopedCandidates(query, definition, scope, run)
			// More scoped rows than the cap: no prefix of them is the query's answer in the
			// query's own order, so the server does not guess (replication answers it).
			if (found.capped) return empty('unsupported', 'too-many-candidates')
			candidates = found.rows
		} catch (error) {
			if (error instanceof ScopeTooWide) return empty('unsupported', 'scope-too-wide')
			if (error instanceof WorkBudgetExceeded) return empty('unsupported', 'work-budget')
			throw error
		}

		// 2. Encrypted records are never answered (the server holds no plaintext for them):
		// only those records are left out, and the answer says so.
		let sealedLeftOut = false
		try {
			const sealed = await readable.sealedIds(
				query.collection,
				candidates.map((row) => row.id),
			)
			if (sealed === null) return empty('unsupported', 'encrypted-records')
			if (sealed.size > 0) {
				sealedLeftOut = true
				candidates = candidates.filter((row) => !sealed.has(row.id))
			}
		} catch (error) {
			if (error instanceof WorkBudgetExceeded) return empty('unsupported', 'work-budget')
			throw error
		}

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
		const view = (row: MaterializedRecord): Record<string, unknown> => evalView(row, definition)
		const compareRows = (a: MaterializedRecord, b: MaterializedRecord): number =>
			compareQueryRecords(descriptor, view(a), view(b)) || compareIds(a.id, b.id)

		if (!supported) {
			// A shape the evaluator is not proven on: every scoped candidate, for the client's
			// own SQL to decide. A cut superset is no superset, so a larger one is not sent.
			const everything = candidates.sort((a, b) => compareIds(a.id, b.id))
			if (everything.length > this.limits.maxRows) {
				return empty('unsupported', 'too-many-candidates')
			}
			try {
				const page = await readable.recordsFor(query.collection, everything)
				if (page.consumed < everything.length) return empty('unsupported', 'too-many-candidates')
				run.rows += page.records.length
				const known = await this.resolveKnown(query, page.records, scope, readable)
				return {
					key: query.key,
					status: 'unsupported',
					reason: 'unsupported-shape',
					records: page.records,
					included: {},
					includedStatus: {},
					refreshed: known.refreshed,
					absent: known.absent,
				}
			} catch (error) {
				if (error instanceof WorkBudgetExceeded) return empty('unsupported', 'work-budget')
				throw error
			}
		}

		// 4. The page. A cursor is a KEYSET (the last row's sort key), so a row deleted between
		// pages cannot make the next page skip another one; `offset` applies to the first page
		// only and `served` carries the total toward `limit` and `maxQueryRows`.
		const ordered = candidates
			.filter((row) => matchesQuery(descriptor, view(row)))
			.sort(compareRows)
		let rest = ordered
		if (cursor !== null && cursor.key !== null) {
			const after = cursor.key
			rest = ordered.filter((row) => {
				const order = compareQueryRecords(descriptor, view(row), after.view)
				return order !== 0 ? order > 0 : compareIds(row.id, after.id) > 0
			})
		} else if (offset > 0) rest = ordered.slice(offset)
		const limitLeft =
			query.limit !== undefined ? Math.max(0, query.limit - served) : Number.POSITIVE_INFINITY
		const rowCap = Math.min(this.limits.maxRows, this.limits.maxQueryRows - position, limitLeft)
		const wanted = rest.slice(0, rowCap)
		let built: ReadRecord[]
		let builtRows: MaterializedRecord[]
		let consumed: number
		let dropped: number
		try {
			const page = await readable.recordsFor(query.collection, wanted)
			built = page.records
			builtRows = page.rows
			consumed = page.consumed
			dropped = page.dropped.length
		} catch (error) {
			if (error instanceof WorkBudgetExceeded) return empty('unsupported', 'work-budget')
			throw error
		}

		let status: ReadResult['status'] = 'ok'
		let reason: string | undefined
		let nextCursor: string | undefined
		// A row that left the grant (or was deleted) between the scan and its confirming read
		// would make a short page that looks complete: build the answer again once, then say so.
		if (dropped > 0 && !run.tolerateDrops) throw new RecordChurn()
		const moreWithinLimit = rest.length > consumed && limitLeft > consumed - dropped
		if (moreWithinLimit) {
			status = 'partial'
			if (position + consumed >= this.limits.maxQueryRows) reason = 'query-row-cap'
			else {
				const last = consumed > 0 ? wanted[consumed - 1] : undefined
				const key =
					last !== undefined
						? { id: last.id, view: sortKeyOf(view(last), query.orderBy) }
						: (cursor?.key ?? null)
				nextCursor = this.encodeCursor(query, principal, grant, {
					offset,
					served: served + consumed - dropped,
					key,
				})
				reason = consumed < wanted.length ? 'byte-budget' : 'row-cap'
				if (nextCursor.length > MAX_CURSOR_LENGTH) {
					nextCursor = undefined
					reason = 'cursor-too-large'
				}
			}
		}
		if (dropped > 0 && status === 'ok') {
			status = 'partial'
			reason = 'records-changed'
		}
		if (sealedLeftOut && status === 'ok') {
			status = 'partial'
			reason = 'encrypted-records'
		}
		run.rows += built.length

		// 5. Included relations, each under its own collection's grant.
		const includedRecords: Record<string, ReadRecord[]> = {}
		const includedStatus: Record<string, ReadIncludeStatus> = {}
		for (const spec of includeSpecs) {
			if (spec === null) continue
			const related = await this.includeRelation(spec, builtRows, readable)
			const existing = includedStatus[spec.relatedCollection]
			// Two relations to one collection: the worse status is the one reported.
			if (existing === undefined || existing.status === 'ok') {
				includedStatus[spec.relatedCollection] = related.status
			}
			if (related.records.length > 0) {
				const seen = new Set(
					(includedRecords[spec.relatedCollection] ?? []).map((record) => record.id),
				)
				includedRecords[spec.relatedCollection] = [
					...(includedRecords[spec.relatedCollection] ?? []),
					...related.records.filter((record) => !seen.has(record.id)),
				]
			}
		}
		if (
			status === 'ok' &&
			Object.values(includedStatus).some(
				(entry) => entry.status !== 'ok' && entry.status !== 'denied',
			)
		) {
			status = 'partial'
			reason = 'include-incomplete'
		}

		// 6. `known`: current values for readable ids outside this page, `absent` for the rest.
		let known: Awaited<ReturnType<ReadThroughService['resolveKnown']>>
		try {
			known = await this.resolveKnown(query, built, scope, readable)
		} catch (error) {
			if (!(error instanceof WorkBudgetExceeded)) throw error
			// Nothing is learned about the ids: none is reported gone.
			known = { refreshed: [], absent: [], truncated: true }
		}
		if (known.truncated && status === 'ok') {
			status = 'partial'
			reason = 'known-truncated'
		}

		return {
			key: query.key,
			status,
			...(reason !== undefined ? { reason } : {}),
			records: built,
			included: includedRecords,
			includedStatus,
			refreshed: known.refreshed,
			absent: known.absent,
			...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
		}
	}

	/**
	 * The records of the collection inside the principal's scope (and the query's own plain
	 * equalities), at most `maxCandidates`. The store is asked for what it can compare exactly
	 * (string and number equalities and one string `$in` per scope branch), in id order, with a
	 * row limit and without large columns, so a wide collection costs at most
	 * `maxCandidates + 1` light rows per store query. Each store query and each row is charged
	 * to the request's work budget. Every row is judged again in JavaScript against the whole
	 * scope. Booleans are not pushed down (the stores keep them as 0/1 or booleans); a scope on
	 * one is bounded by the cap instead.
	 */
	private async scopedCandidates(
		query: ReadQuery,
		definition: CollectionDefinition,
		scope: Record<string, unknown>,
		run: RunState,
	): Promise<{ rows: MaterializedRecord[]; capped: boolean }> {
		const { store } = this.deps
		const queries = pushdownQueries(scope, queryEqualities(query, definition))
		if (queries.length > MAX_READ_PUSHDOWN_QUERIES) throw new ScopeTooWide()
		const columns = lightColumns(definition)
		const found = new Map<string, MaterializedRecord>()
		for (const where of queries) {
			// One row past the cap proves the scope is wider than the cap; never more than the
			// request's remaining work is loaded.
			const limit = Math.min(this.limits.maxCandidates + 1, run.workLeft - STORE_QUERY_COST)
			if (limit < 1) throw new WorkBudgetExceeded()
			run.spend(STORE_QUERY_COST)
			const rows = await store.queryCollection(query.collection, {
				where,
				orderBy: 'id',
				limit,
				...(columns !== undefined ? { columns } : {}),
			})
			run.spend(rows.length)
			// A read that filled its limit may have stopped short of rows: past the cap that
			// means the scope is wider than the cap, past the budget the request is out of work.
			if (rows.length >= limit) {
				if (limit < this.limits.maxCandidates + 1) throw new WorkBudgetExceeded()
				return { rows: [], capped: true }
			}
			for (const row of rows) {
				if (
					recordMatchesScopes(
						query.collection,
						{ ...row, id: row.id },
						{ [query.collection]: scope },
					)
				) {
					found.set(String(row.id), row)
					if (found.size > this.limits.maxCandidates) return { rows: [], capped: true }
				}
			}
		}
		return { rows: [...found.values()], capped: false }
	}

	/** Records of a related collection for the primary page, each under its own grant. */
	private async includeRelation(
		spec: RelationSpec,
		primary: readonly MaterializedRecord[],
		readable: Readable,
	): Promise<{ records: ReadRecord[]; status: ReadIncludeStatus }> {
		const { store } = this.deps
		const run = readable.run
		const relatedScope = collectionScope(readable.grant, spec.relatedCollection)
		if (relatedScope === null) return { records: [], status: { status: 'denied' } }
		if (primary.length === 0) return { records: [], status: { status: 'ok' } }
		let partialReason: string | null = null
		let rows: MaterializedRecord[] = []
		try {
			if (spec.direction === 'parent') {
				const ids = [
					...new Set(
						primary
							.map((row) => row[spec.field])
							.filter((value): value is string => typeof value === 'string' && value.length > 0),
					),
				]
				if (ids.length === 0) return { records: [], status: { status: 'ok' } }
				if (run.workLeft < ids.length + STORE_QUERY_COST) throw new WorkBudgetExceeded()
				run.spend(ids.length + STORE_QUERY_COST)
				const map = store.findRecordsByIds
					? await store.findRecordsByIds(spec.relatedCollection, ids)
					: new Map(
							(await Promise.all(ids.map((id) => store.findRecord(spec.relatedCollection, id))))
								.filter((row): row is MaterializedRecord => row !== null)
								.map((row) => [row.id, row] as const),
						)
				rows = [...map.values()]
			} else {
				if (primary.length > MAX_ONE_TO_MANY_FANOUT) {
					return { records: [], status: { status: 'unsupported', reason: 'too-many-primaries' } }
				}
				// The related scope is pushed into each store query, so the row limit cuts rows the
				// principal may read and not rows it may not.
				const scoped = pushdownQueries(relatedScope, {})
				if (scoped.length * primary.length > MAX_INCLUDE_STORE_QUERIES) {
					return { records: [], status: { status: 'unsupported', reason: 'scope-too-wide' } }
				}
				const columns = lightColumns(
					this.deps.store.getSchema()?.collections[spec.relatedCollection],
				)
				const found = new Map<string, MaterializedRecord>()
				for (const row of primary) {
					for (const base of scoped) {
						const limit = Math.min(this.limits.maxRows + 1, run.workLeft - STORE_QUERY_COST)
						if (limit < 1) throw new WorkBudgetExceeded()
						run.spend(STORE_QUERY_COST)
						const part = await store.queryCollection(spec.relatedCollection, {
							where: { ...base, [spec.field]: row.id },
							orderBy: 'id',
							limit,
							...(columns !== undefined ? { columns } : {}),
						})
						run.spend(part.length)
						// A read that filled its limit may have stopped short of rows.
						if (part.length >= limit) {
							if (limit < this.limits.maxRows + 1) throw new WorkBudgetExceeded()
							partialReason = 'row-cap'
						}
						for (const related of part) found.set(related.id, related)
					}
				}
				rows = [...found.values()]
			}
		} catch (error) {
			if (error instanceof WorkBudgetExceeded) {
				return { records: [], status: { status: 'unsupported', reason: 'work-budget' } }
			}
			throw error
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
		rows.sort((a, b) => compareIds(a.id, b.id))
		if (rows.length > this.limits.maxRows) {
			rows = rows.slice(0, this.limits.maxRows)
			partialReason = 'row-cap'
		}
		try {
			const sealed = await readable.sealedIds(
				spec.relatedCollection,
				rows.map((row) => row.id),
			)
			if (sealed === null) {
				return { records: [], status: { status: 'unsupported', reason: 'encrypted-records' } }
			}
			if (sealed.size > 0) {
				rows = rows.filter((row) => !sealed.has(row.id))
				partialReason = partialReason ?? 'encrypted-records'
			}
			const page = await readable.recordsFor(spec.relatedCollection, rows)
			if (page.consumed < rows.length) partialReason = partialReason ?? 'byte-budget'
			return {
				records: page.records,
				status:
					partialReason === null ? { status: 'ok' } : { status: 'partial', reason: partialReason },
			}
		} catch (error) {
			if (error instanceof WorkBudgetExceeded) {
				return { records: [], status: { status: 'unsupported', reason: 'work-budget' } }
			}
			throw error
		}
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
		if (readable.run.workLeft < known.length + STORE_QUERY_COST) throw new WorkBudgetExceeded()
		readable.run.spend(known.length + STORE_QUERY_COST)
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
			if (inPage.has(id)) continue
			const row = rows.get(id)
			const gone = row === undefined || row._deleted === 1 || row._deleted === true
			const outside =
				!gone &&
				!recordMatchesScopes(query.collection, { ...row, id }, { [query.collection]: scope })
			// One list for "gone" and "outside the grant": no oracle for either. Only these are
			// reported absent: a device deletes the seed of every id listed.
			if (gone || outside) absent.push(id)
			else readableRows.push(row)
		}
		const sealed = await readable.sealedIds(
			query.collection,
			readableRows.map((row) => row.id),
		)
		// A record the server cannot serve (encrypted, or the store cannot tell) is neither
		// refreshed nor absent: the device keeps its seed and the answer says it is incomplete.
		if (sealed === null) {
			return { refreshed: [], absent, truncated: readableRows.length > 0 }
		}
		const fresh = readableRows.filter((row) => !sealed.has(row.id))
		const refreshed = await readable.recordsFor(query.collection, fresh)
		// Gone or moved out of the grant after the first look: absent, like any other such id.
		absent.push(...refreshed.dropped)
		return {
			refreshed: refreshed.records,
			absent,
			truncated: sealed.size > 0 || refreshed.consumed < fresh.length,
		}
	}

	/**
	 * A cursor: the sort key of the last row served, signed for one principal and grant and
	 * bound to one query shape.
	 */
	private encodeCursor(
		query: ReadQuery,
		principal: string,
		grant: ReadGrant,
		state: CursorState,
	): string {
		const payload = Buffer.from(
			JSON.stringify({
				h: shapeHash(query),
				p: bindingHash(principal, grant),
				o: state.offset,
				s: state.served,
				k: state.key === null ? null : { i: state.key.id, v: state.key.view },
			}),
		).toString('base64url')
		const mac = createHmac('sha256', this.cursorKey).update(payload).digest('base64url')
		return `${payload}.${mac}`
	}

	/** The state a cursor carries; `'invalid'` for any cursor that does not verify. */
	private decodeCursor(
		query: ReadQuery,
		principal: string,
		grant: ReadGrant,
	): CursorState | 'invalid' | null {
		if (query.cursor === undefined) return null
		try {
			const [payload, mac, ...rest] = query.cursor.split('.')
			if (payload === undefined || mac === undefined || rest.length > 0) return 'invalid'
			const expected = createHmac('sha256', this.cursorKey).update(payload).digest()
			const given = Buffer.from(mac, 'base64url')
			if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid'
			const fields = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
				h?: unknown
				p?: unknown
				o?: unknown
				s?: unknown
				k?: unknown
			}
			if (fields.h !== shapeHash(query) || fields.p !== bindingHash(principal, grant)) {
				return 'invalid'
			}
			if (
				typeof fields.o !== 'number' ||
				typeof fields.s !== 'number' ||
				!Number.isSafeInteger(fields.o) ||
				!Number.isSafeInteger(fields.s) ||
				fields.o < 0 ||
				fields.s < 0
			) {
				return 'invalid'
			}
			let key: CursorState['key'] = null
			if (fields.k !== null) {
				const raw = fields.k as { i?: unknown; v?: unknown }
				if (typeof raw.i !== 'string' || !isPlainRecord(raw.v)) return 'invalid'
				key = { id: raw.i, view: { ...raw.v, id: raw.i } }
			}
			return { offset: fields.o, served: fields.s, key }
		} catch {
			return 'invalid'
		}
	}
}

/** What a cursor carries: where the query started, how many rows it served, and its last sort key. */
interface CursorState {
	offset: number
	served: number
	key: { id: string; view: Record<string, unknown> } | null
}

/** The evaluator's view of a row reduced to the fields the query orders by. */
function sortKeyOf(
	view: Record<string, unknown>,
	orderBy: ReadQuery['orderBy'],
): Record<string, unknown> {
	const key: Record<string, unknown> = {}
	for (const clause of orderBy) key[clause.field] = view[clause.field] ?? null
	return key
}

/**
 * The store queries (as `where` equalities) that cover a scope: one per branch, one per value
 * of a string `$in`, with `extra` equalities (string or number) narrowing each. Strings and
 * numbers only are pushed down; everything is judged again in JavaScript. A contradiction
 * between a branch and `extra` leaves that branch out.
 */
function pushdownQueries(
	scope: Record<string, unknown>,
	extra: Record<string, string | number>,
): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = []
	const branches = isUnrestrictedScope(scope) ? [{}] : scopeBranches(scope)
	for (const branch of branches) {
		const equalities: Record<string, unknown> = {}
		let inField: { field: string; values: readonly unknown[] } | null = null
		for (const [field, predicate] of Object.entries(branch)) {
			const list =
				predicate !== null && typeof predicate === 'object' && !Array.isArray(predicate)
					? (predicate as { $in?: unknown }).$in
					: undefined
			if (Array.isArray(list)) {
				if (inField === null && list.every((value) => typeof value === 'string')) {
					inField = { field, values: list }
				}
			} else if (typeof predicate === 'string' || isFiniteNumber(predicate)) {
				equalities[field] = predicate
			}
		}
		let contradiction = false
		for (const [field, value] of Object.entries(extra)) {
			if (field in equalities) {
				if (equalities[field] !== value) contradiction = true
			} else if (inField !== null && inField.field === field) {
				if (!inField.values.includes(value)) contradiction = true
				else inField = null
				equalities[field] = value
			} else equalities[field] = value
		}
		if (contradiction) continue
		if (inField) {
			const field = inField.field
			for (const value of inField.values) out.push({ ...equalities, [field]: value })
		} else out.push(equalities)
	}
	return out
}

/** The columns to read for a candidate scan: every schema field except large ones; undefined when none is large. */
function lightColumns(definition: CollectionDefinition | undefined): string[] | undefined {
	if (definition === undefined) return undefined
	const entries = Object.entries(definition.fields)
	if (!entries.some(([, field]) => HEAVY_KINDS.has(field.kind))) return undefined
	return entries.filter(([, field]) => !HEAVY_KINDS.has(field.kind)).map(([name]) => name)
}

/** Per-request state: the byte and work budgets and counters shared by the queries of one answer. */
class RunState {
	bytesLeft: number
	workLeft: number
	rows = 0
	/**
	 * False on the first build of an answer: a record that left the grant (or was deleted)
	 * between the scan and its confirming read then makes the answer be built again. True on
	 * the rebuild, which reports the drop as a partial page instead.
	 */
	constructor(
		readonly limits: ReadLimits,
		readonly tolerateDrops: boolean,
	) {
		this.bytesLeft = limits.maxBytes
		this.workLeft = limits.maxWork
	}

	/** Charge `units` of work (rows loaded, versions read, ids checked) to the request. */
	spend(units: number): void {
		this.workLeft -= units
	}
}

/** Field kinds whose values can be large: candidate scans skip them and the page reads them. */
const HEAVY_KINDS = new Set<string>(['richtext', 'blob'])
/** Work charged for every store query, so a long `$in` fan-out costs more than its rows. */
const STORE_QUERY_COST = 5
/** The most store queries an include of one page may fan out into. */
const MAX_INCLUDE_STORE_QUERIES = 1_000
/** Longest cursor sent; a sort key that makes it longer ends paging instead. */
const MAX_CURSOR_LENGTH = 1_900

/** Times a record is read again when it changed while its values and versions were paired. */
const RECORD_STABILITY_ATTEMPTS = 3

/**
 * Reads of one answer: encrypted-record checks, field versions and the byte budget. One
 * instance per query, sharing the answer's {@link RunState}.
 */
class Readable {
	constructor(
		private readonly store: ServerStore,
		readonly grant: ReadGrant,
		readonly schema: SchemaDefinition,
		readonly run: RunState,
	) {}

	/**
	 * Which of `ids` have encrypted operations; null when the store cannot tell (then the
	 * collection is not read through: fail closed).
	 */
	async sealedIds(collection: string, ids: readonly string[]): Promise<Set<string> | null> {
		if (ids.length === 0) return new Set()
		const check = this.store.recordsWithEncryptedOperations
		if (typeof check !== 'function') return null
		if (this.run.workLeft < ids.length) throw new WorkBudgetExceeded()
		this.run.spend(ids.length)
		return check.call(this.store, collection, ids)
	}

	/**
	 * Wire records for rows, in order, while the answer's byte budget lasts (the first record
	 * of an answer is always returned, so a record larger than the budget still progresses).
	 * `rows` are the rows the records were built from (a record changed while it was read is
	 * built from its newer row), `consumed` how many of the input rows were looked at, and `dropped` the ids among
	 * them that are no longer readable (deleted, or moved out of the grant, since the scan).
	 */
	async recordsFor(
		collection: string,
		rows: readonly MaterializedRecord[],
	): Promise<{
		records: ReadRecord[]
		rows: MaterializedRecord[]
		consumed: number
		dropped: string[]
	}> {
		const definition = this.schema.collections[collection]
		if (definition === undefined)
			return { records: [], rows: [], consumed: rows.length, dropped: [] }
		const out: ReadRecord[] = []
		const used: MaterializedRecord[] = []
		const dropped: string[] = []
		let consumed = 0
		for (let i = 0; i < rows.length; i += VERSION_READ_CONCURRENCY) {
			const slice = rows.slice(i, i + VERSION_READ_CONCURRENCY)
			const built = await this.stableRecords(collection, definition, slice)
			for (const [position, entry] of built.entries()) {
				if (entry === null) {
					const gone = slice[position]
					if (gone !== undefined) dropped.push(gone.id)
				} else {
					const size = Buffer.byteLength(JSON.stringify(entry.record))
					if (this.run.bytesLeft - size < 0 && (out.length > 0 || this.run.rows > 0)) {
						return { records: out, rows: used, consumed, dropped }
					}
					this.run.bytesLeft -= size
					out.push(entry.record)
					used.push(entry.row)
				}
				consumed += 1
			}
		}
		return { records: out, rows: used, consumed, dropped }
	}

	/**
	 * Records whose values and field versions belong to one state of the row. The values come
	 * from a row read earlier and the versions from the fold state, which are two reads: a
	 * write between them would pair old values with new versions (a device would then keep
	 * the old value as if it were the new write's). So the row is read again after the
	 * versions; if it differs, the newer row and its versions are used, a few times, then the
	 * answer is refused retriably (`RecordChurn`). A record deleted meanwhile, or whose newer
	 * row is outside the grant, is null: the confirming read is the last look at the row, so
	 * it must pass the scope judgement the scan did (a record moved between organisations
	 * must not be served on the strength of its old row).
	 */
	private async stableRecords(
		collection: string,
		definition: CollectionDefinition,
		rows: readonly MaterializedRecord[],
	): Promise<Array<{ record: ReadRecord; row: MaterializedRecord } | null>> {
		const result: Array<{ record: ReadRecord; row: MaterializedRecord } | null> = rows.map(
			() => null,
		)
		const scope = collectionScope(this.grant, collection)
		let pending = rows.map((row, index) => ({ row, index }))
		for (let attempt = 0; attempt < RECORD_STABILITY_ATTEMPTS && pending.length > 0; attempt++) {
			// A version read and a row read per record, every attempt: a record that keeps
			// changing spends the request's work budget and cannot be retried for free.
			const cost = pending.length * 2
			if (this.run.workLeft < cost) throw new WorkBudgetExceeded()
			this.run.spend(cost)
			const versions = await Promise.all(
				pending.map(({ row }) => this.versionsOf(collection, row.id)),
			)
			const fresh = await this.currentRows(
				collection,
				pending.map(({ row }) => row.id),
			)
			const changed: typeof pending = []
			for (const [i, { row, index }] of pending.entries()) {
				const now = fresh.get(row.id)
				if (now === undefined || now._deleted === 1 || now._deleted === true) continue
				// Fail closed: no scope means nothing of this collection is readable.
				if (
					scope === null ||
					!recordMatchesScopes(collection, { ...now, id: row.id }, { [collection]: scope })
				) {
					continue
				}
				if (sameState(row, now, definition)) {
					// The values come from the confirming read, which also holds the large
					// columns the candidate scan skipped.
					result[index] = {
						record: wireRecord(definition, now, versions[i] ?? null),
						row: now,
					}
				} else changed.push({ row: now, index })
			}
			pending = changed
		}
		if (pending.length > 0) throw new RecordChurn()
		return result
	}

	/**
	 * The versions of a record. A store error is not swallowed: inventing wall-time-0 versions
	 * would let a device's older value win over the real one, so the read fails (and is logged
	 * by the service) instead. Only a store that has no version reads at all falls back to one
	 * whole-record stamp, as a scope entry does.
	 */
	private async versionsOf(collection: string, id: string): Promise<VersionRead | null> {
		const store = this.store
		let versions: RecordFieldVersions | null = null
		if (store.getRecordFieldVersions) {
			versions = await store.getRecordFieldVersions(collection, id)
		}
		let latest: HLCTimestamp | null = versions?.latest ?? null
		if (!versions && store.getRecordLatestTimestamp) {
			latest = (await store.getRecordLatestTimestamp(collection, id)) ?? null
		}
		return { versions, latest }
	}

	private async currentRows(
		collection: string,
		ids: readonly string[],
	): Promise<Map<string, MaterializedRecord>> {
		const store = this.store
		if (store.findRecordsByIds) return store.findRecordsByIds(collection, [...ids])
		const found = await Promise.all(ids.map((id) => store.findRecord(collection, id)))
		return new Map(
			found.filter((row): row is MaterializedRecord => row !== null).map((row) => [row.id, row]),
		)
	}
}

interface VersionRead {
	versions: RecordFieldVersions | null
	latest: HLCTimestamp | null
}

/** True when two reads of a row hold the same values and the same update stamp. */
function sameState(
	a: MaterializedRecord,
	b: MaterializedRecord,
	definition: CollectionDefinition,
): boolean {
	if (toNumber(a._updated_at) !== toNumber(b._updated_at)) return false
	for (const field of Object.keys(definition.fields)) {
		// The candidate scan may not have read large columns; the others must agree.
		if (!(field in a)) continue
		if (
			JSON.stringify(toWireValue(a[field]) ?? null) !==
			JSON.stringify(toWireValue(b[field]) ?? null)
		) {
			return false
		}
	}
	return true
}

/** The wire form of a row with its versions, as a scope entry carries them. */
function wireRecord(
	definition: CollectionDefinition,
	row: MaterializedRecord,
	read: VersionRead | null,
): ReadRecord {
	const values: Record<string, unknown> = {}
	for (const field of Object.keys(definition.fields)) {
		if (!(field in row)) continue
		const value = row[field]
		if (value === undefined) continue
		values[field] = toWireValue(value)
	}
	const latest: HLCTimestamp = read?.latest ?? {
		wallTime: 0,
		logical: 0,
		nodeId: 'kora:scope-entry',
	}
	const created = read?.versions?.created ?? latest
	const fieldVersions: Record<string, HLCTimestamp> = {}
	for (const field of Object.keys(values)) {
		fieldVersions[field] = { ...(read?.versions?.fields[field] ?? created) }
	}
	return { id: row.id, values, fieldVersions, created: { ...created }, latest: { ...latest } }
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

/**
 * A column the evaluator compares as a number. Postgres hands a BIGINT back as a string (or a
 * bigint), which would compare as text and answer wrongly while the status stays `ok`.
 */
export function toNumber(value: unknown): unknown {
	return typeof value === 'string' || typeof value === 'bigint' ? Number(value) : value
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

/** The principal a cursor is bound to. */
function principalId(context: AuthContext | null): string {
	return context === null ? 'anonymous' : context.userId
}

/** What a cursor is bound to besides its query: the principal and the grant it was issued under. */
function bindingHash(principal: string, grant: ReadGrant): string {
	return createHash('sha256')
		.update(`${principal}\u0000${grant.grantKey}`)
		.digest('base64url')
		.slice(0, 16)
}

/**
 * A record as the evaluator reads it: schema fields, `id`, and the virtual timestamps.
 * Exported for tests.
 */
export function evalView(
	row: MaterializedRecord,
	definition: CollectionDefinition,
): Record<string, unknown> {
	const view: Record<string, unknown> = { id: row.id }
	for (const field of Object.keys(definition.fields)) {
		if (field in row) view[field] = row[field]
	}
	if (!Object.prototype.hasOwnProperty.call(definition.fields, 'createdAt')) {
		view.createdAt = toNumber(row._created_at)
	}
	if (!Object.prototype.hasOwnProperty.call(definition.fields, 'updatedAt')) {
		view.updatedAt = toNumber(row._updated_at)
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

function tooMany(
	reason: 'rate' | 'concurrent' | 'busy' | 'auth-busy',
	retryAfterMs: number,
): ReadHttpResponse {
	const base = failure(
		429,
		reason === 'rate' ? 'RATE_LIMITED' : reason === 'auth-busy' ? 'AUTH_BUSY' : 'TOO_MANY_READS',
		reason === 'auth-busy'
			? 'Authentication is busy. Retry after the hint.'
			: 'Too many reads. Retry after the hint.',
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
