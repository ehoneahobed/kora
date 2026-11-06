import type { HLCTimestamp } from '@korajs/core'
import { KoraError } from '@korajs/core/lite'
import type { SyncAuthRequest } from '../types'
import {
	MAX_READ_QUERIES,
	READ_PROTOCOL_VERSION,
	type ReadErrorBody,
	type ReadQuery,
	type ReadRecord,
	type ReadRequest,
	type ReadResponse,
	type ReadResult,
} from './read-types'

/**
 * The read-through client (first-visit parity S4b, `docs/design/first-visit-parity.md` 5.2):
 * asks the server for the answer to a query before this device has replicated anything.
 *
 * It has no store, engine or transport dependency, so it lives in the lite entry and can run
 * before the runtime chunk has loaded. Requests made in the same turn are coalesced into one
 * POST (at most {@link MAX_READ_QUERIES} queries each), identical queries share one answer, and
 * a server that has no read endpoint (404) is remembered for the session.
 */

/** The `fetch` the client needs: the platform one by default. */
export type ReadFetch = (url: string, init: ReadFetchInit) => Promise<ReadFetchResponse>

/** What the client passes to `fetch`. */
export interface ReadFetchInit {
	method: 'POST'
	headers: Record<string, string>
	body: string
	signal: AbortSignal
	credentials?: 'include'
}

/** The part of a `Response` the client reads. */
export interface ReadFetchResponse {
	status: number
	headers: { get(name: string): string | null }
	text(): Promise<string>
}

/** Options of {@link ReadThroughClient}. */
export interface ReadThroughClientOptions {
	/** The read endpoint, `<syncPath>/read`, as an `http(s)` URL. */
	url: string
	/** The schema version the device runs (the server refuses another one with 409). */
	schemaVersion: number
	/**
	 * The credential provider of the sync configuration (`sync.auth`): called before each request,
	 * and with `{ forceRefresh: true }` after a 401, once.
	 */
	auth?: (options?: SyncAuthRequest) => Promise<{ token: string }>
	/** Send the browser's cookies (and the `x-kora-read` header the server requires with them). */
	cookies?: boolean
	/** The `fetch` to use (default: the platform's). */
	fetch?: ReadFetch
	/** Attempts per request including the first (default 3). */
	maxAttempts?: number
	/** The longest wait before a retry in milliseconds (default 5,000). */
	maxRetryDelayMs?: number
	/** Waits `ms`, or rejects with an abort error when `signal` aborts (default: a timer). */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>
	/** Runs `flush` once the current turn's queries have been submitted (default: a 0 ms timer). */
	schedule?: (flush: () => void) => void
}

/** The answer to one query, with what the server read it at. */
export interface ReadAnswer {
	/** The delivery sequence the rows reflect. */
	frontier: number
	/** A hash of the grant the rows were read under. */
	grantKey: string
	result: ReadResult
}

/** Options of one {@link ReadThroughClient.read} call. */
export interface ReadCallOptions {
	/** Aborts this call; other queries in the same request are unaffected. */
	signal?: AbortSignal
}

/** Why a read failed. `retriable` says whether asking again later can succeed. */
export class ReadThroughError extends KoraError {
	constructor(
		message: string,
		code: string,
		public readonly retriable: boolean,
		public readonly status?: number,
		context?: Record<string, unknown>,
	) {
		super(message, code, { ...context, retriable, ...(status !== undefined ? { status } : {}) })
		this.name = 'ReadThroughError'
	}
}

/** Default attempts per request, including the first. */
const DEFAULT_MAX_ATTEMPTS = 3
/** Default ceiling of the wait before a retry. */
const DEFAULT_MAX_RETRY_DELAY_MS = 5_000
/** First backoff step; doubles per attempt (no jitter: one client, one request in flight per batch). */
const BACKOFF_BASE_MS = 250
/** Statuses retried without a body that says so. */
const RETRIABLE_STATUSES = new Set([408, 429, 503])

interface Waiter {
	resolve(answer: ReadAnswer): void
	reject(error: unknown): void
	signal: AbortSignal | undefined
	onAbort: (() => void) | undefined
}

interface Entry {
	query: ReadQuery
	/** The query as sent, to tell two different queries with one key apart. */
	fingerprint: string
	waiters: Set<Waiter>
}

/**
 * Asks the read-through endpoint for query answers.
 *
 * @example
 * ```typescript
 * const client = new ReadThroughClient({ url: 'https://api.example.com/kora-sync/read', schemaVersion: 1, auth })
 * const { result, frontier } = await client.read({ key: 'q1', collection: 'lessons', where: {}, orderBy: [] })
 * ```
 */
export class ReadThroughClient {
	private readonly fetchImpl: ReadFetch
	private readonly maxAttempts: number
	private readonly maxRetryDelayMs: number
	private readonly sleepImpl: (ms: number, signal: AbortSignal) => Promise<void>
	private readonly scheduleImpl: (flush: () => void) => void
	private pending = new Map<string, Entry>()
	private flushScheduled = false
	private unavailableSince: ReadThroughError | null = null

	constructor(private readonly options: ReadThroughClientOptions) {
		this.fetchImpl = options.fetch ?? defaultFetch
		this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
		this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS
		this.sleepImpl = options.sleep ?? defaultSleep
		this.scheduleImpl = options.schedule ?? ((flush) => void setTimeout(flush, 0))
	}

	/** True once the server answered 404: there is no read endpoint, and none is asked again. */
	get unavailable(): boolean {
		return this.unavailableSince !== null
	}

	/**
	 * Ask for the answer to one query. Queries submitted in the same turn travel in one request.
	 *
	 * @param query - The query; `key` must identify it (two different queries must not share one)
	 * @param options - An abort signal for this call
	 * @returns The answer and the frontier and grant it was read under
	 * @throws {ReadThroughError} When the server cannot be reached or refuses (`retriable` says whether to try again)
	 */
	read(query: ReadQuery, options: ReadCallOptions = {}): Promise<ReadAnswer> {
		if (this.unavailableSince !== null) return Promise.reject(this.unavailableSince)
		const { signal } = options
		if (signal?.aborted) return Promise.reject(abortError())
		const fingerprint = JSON.stringify(query)
		const existing = this.pending.get(query.key)
		if (existing !== undefined && existing.fingerprint !== fingerprint) {
			return Promise.reject(
				new ReadThroughError(
					`Two different queries share the key "${query.key}" in one read: a key must identify its query.`,
					'READ_KEY_CONFLICT',
					false,
				),
			)
		}
		return new Promise<ReadAnswer>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, signal, onAbort: undefined }
			const entry = existing ?? { query, fingerprint, waiters: new Set<Waiter>() }
			entry.waiters.add(waiter)
			if (signal !== undefined) {
				waiter.onAbort = (): void => {
					entry.waiters.delete(waiter)
					reject(abortError())
				}
				signal.addEventListener('abort', waiter.onAbort, { once: true })
			}
			if (existing === undefined) this.pending.set(query.key, entry)
			this.scheduleFlush()
		})
	}

	private scheduleFlush(): void {
		if (this.flushScheduled) return
		this.flushScheduled = true
		this.scheduleImpl(() => {
			this.flushScheduled = false
			this.flush()
		})
	}

	private flush(): void {
		const taken = [...this.pending.values()].filter((entry) => entry.waiters.size > 0)
		this.pending = new Map()
		for (let start = 0; start < taken.length; start += MAX_READ_QUERIES) {
			void this.send(taken.slice(start, start + MAX_READ_QUERIES))
		}
	}

	private async send(entries: Entry[]): Promise<void> {
		const controller = new AbortController()
		// A request nobody waits for any more is cancelled; one with a live waiter is not.
		const cancelIfAbandoned = (): void => {
			if (entries.every((entry) => entry.waiters.size === 0)) controller.abort()
		}
		for (const entry of entries) {
			for (const waiter of [...entry.waiters]) {
				const previous = waiter.onAbort
				if (waiter.signal === undefined || previous === undefined) continue
				waiter.signal.removeEventListener('abort', previous)
				const chained = (): void => {
					previous()
					cancelIfAbandoned()
				}
				waiter.onAbort = chained
				waiter.signal.addEventListener('abort', chained, { once: true })
			}
		}
		try {
			const response = await this.requestWithRetry(entries, controller.signal)
			this.settle(entries, response)
		} catch (error) {
			if (error instanceof ReadThroughError && error.code === 'READ_UNAVAILABLE') {
				this.unavailableSince = error
			}
			for (const entry of entries) {
				for (const waiter of entry.waiters) this.finish(waiter, () => waiter.reject(error))
				entry.waiters.clear()
			}
		}
	}

	private settle(entries: Entry[], response: ReadResponse): void {
		const byKey = new Map(response.results.map((result) => [result.key, result]))
		for (const entry of entries) {
			const result = byKey.get(entry.query.key)
			for (const waiter of entry.waiters) {
				this.finish(waiter, () => {
					if (result === undefined) {
						waiter.reject(
							new ReadThroughError(
								`The read answer has no result for the query "${entry.query.key}".`,
								'READ_RESPONSE_INVALID',
								false,
							),
						)
						return
					}
					waiter.resolve({ frontier: response.frontier, grantKey: response.grantKey, result })
				})
			}
			entry.waiters.clear()
		}
	}

	private finish(waiter: Waiter, settleIt: () => void): void {
		if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
			waiter.signal.removeEventListener('abort', waiter.onAbort)
		}
		settleIt()
	}

	private async requestWithRetry(entries: Entry[], signal: AbortSignal): Promise<ReadResponse> {
		const body = JSON.stringify({
			v: READ_PROTOCOL_VERSION,
			schemaVersion: this.options.schemaVersion,
			queries: entries.map((entry) => entry.query),
		} satisfies ReadRequest)
		let forceRefresh = false
		let last: ReadThroughError | null = null
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			if (signal.aborted) throw abortError()
			const outcome = await this.attempt(body, forceRefresh, signal)
			if (outcome.kind === 'ok') return outcome.response
			last = outcome.error
			if (outcome.refreshCredential && this.options.auth !== undefined && !forceRefresh) {
				// One refresh of the credential per request: a second 401 is final.
				forceRefresh = true
				continue
			}
			if (!outcome.error.retriable || attempt === this.maxAttempts) throw outcome.error
			const wait = Math.min(
				outcome.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** (attempt - 1),
				this.maxRetryDelayMs,
			)
			await this.sleepImpl(wait, signal)
		}
		throw last ?? new ReadThroughError('The read request failed.', 'READ_FAILED', true)
	}

	private async attempt(
		body: string,
		forceRefresh: boolean,
		signal: AbortSignal,
	): Promise<Attempt> {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			accept: 'application/json',
		}
		try {
			if (this.options.auth !== undefined) {
				const credential = await this.options.auth(
					forceRefresh ? { forceRefresh: true } : undefined,
				)
				headers.authorization = `Bearer ${credential.token}`
			}
			if (this.options.cookies) headers['x-kora-read'] = '1'
			const init: ReadFetchInit = { method: 'POST', headers, body, signal }
			if (this.options.cookies) init.credentials = 'include'
			const response = await this.fetchImpl(this.options.url, init)
			const text = await response.text()
			return interpret(response, text)
		} catch (error) {
			if (signal.aborted) throw abortError()
			if (error instanceof ReadThroughError) return { kind: 'failed', error }
			// A network failure or a credential provider that threw: transient, ask again.
			return {
				kind: 'failed',
				error: new ReadThroughError(
					`The read request failed: ${error instanceof Error ? error.message : String(error)}`,
					'READ_NETWORK_ERROR',
					true,
				),
			}
		}
	}
}

type Attempt =
	| { kind: 'ok'; response: ReadResponse }
	| {
			kind: 'failed'
			error: ReadThroughError
			retryAfterMs?: number
			refreshCredential?: boolean
	  }

function interpret(response: ReadFetchResponse, text: string): Attempt {
	const status = response.status
	if (status === 200) {
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			return invalid('The read answer is not valid JSON.')
		}
		if (!isReadResponse(parsed)) return invalid('The read answer has an unexpected shape.')
		return { kind: 'ok', response: expandResponse(parsed) }
	}
	const body = parseErrorBody(text)
	const message = body?.error.message ?? `The read endpoint answered ${status}.`
	if (status === 404) {
		return {
			kind: 'failed',
			error: new ReadThroughError(
				'The server has no read endpoint: queries are answered by replication.',
				'READ_UNAVAILABLE',
				false,
				404,
			),
		}
	}
	if (status === 401) {
		return {
			kind: 'failed',
			error: new ReadThroughError(message, 'READ_UNAUTHORIZED', false, 401),
			refreshCredential: true,
		}
	}
	const retriable = body?.error.retriable ?? RETRIABLE_STATUSES.has(status)
	const retryAfterMs = body?.error.retryAfterMs ?? retryAfterHeader(response)
	return {
		kind: 'failed',
		error: new ReadThroughError(
			message,
			body?.error.code ?? `READ_HTTP_${status}`,
			retriable,
			status,
		),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
	}
}

/** Restore what the compact wire form leaves out: field versions and `latest` equal to `created`. */
function expandRecord(record: ReadRecord): ReadRecord {
	const fields = record.fieldVersions ?? {}
	const fieldVersions: Record<string, HLCTimestamp> = {}
	for (const field of Object.keys(record.values))
		fieldVersions[field] = fields[field] ?? record.created
	return { ...record, fieldVersions, latest: record.latest ?? record.created }
}

function expandResponse(response: ReadResponse): ReadResponse {
	return {
		...response,
		results: response.results.map((result) => ({
			...result,
			records: result.records.map(expandRecord),
			included: Object.fromEntries(
				Object.entries(result.included ?? {}).map(([name, records]) => [
					name,
					records.map(expandRecord),
				]),
			),
			refreshed: (result.refreshed ?? []).map(expandRecord),
		})),
	}
}

function invalid(message: string): Attempt {
	return { kind: 'failed', error: new ReadThroughError(message, 'READ_RESPONSE_INVALID', false) }
}

function isReadResponse(value: unknown): value is ReadResponse {
	if (typeof value !== 'object' || value === null) return false
	const candidate = value as Record<string, unknown>
	return (
		typeof candidate.frontier === 'number' &&
		typeof candidate.grantKey === 'string' &&
		Array.isArray(candidate.results)
	)
}

function parseErrorBody(text: string): ReadErrorBody | null {
	try {
		const parsed: unknown = JSON.parse(text)
		if (typeof parsed !== 'object' || parsed === null) return null
		const error = (parsed as Record<string, unknown>).error
		if (typeof error !== 'object' || error === null) return null
		const fields = error as Record<string, unknown>
		if (typeof fields.code !== 'string' || typeof fields.message !== 'string') return null
		return {
			error: {
				code: fields.code,
				message: fields.message,
				retriable: fields.retriable === true,
				...(typeof fields.retryAfterMs === 'number' ? { retryAfterMs: fields.retryAfterMs } : {}),
			},
		}
	} catch {
		return null
	}
}

function retryAfterHeader(response: ReadFetchResponse): number | undefined {
	const header = response.headers.get('retry-after')
	if (header === null) return undefined
	const seconds = Number(header)
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

function abortError(): Error {
	return new DOMException('The read was aborted.', 'AbortError')
}

const defaultFetch: ReadFetch = (url, init) => fetch(url, init) as Promise<ReadFetchResponse>

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(abortError())
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		const onAbort = (): void => {
			clearTimeout(timer)
			reject(abortError())
		}
		signal.addEventListener('abort', onAbort, { once: true })
	})
}
