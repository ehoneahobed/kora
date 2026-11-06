import { describe, expect, it } from 'vitest'
import {
	type ReadFetch,
	type ReadFetchInit,
	ReadThroughClient,
	type ReadThroughClientOptions,
	ReadThroughError,
} from './read-through-client'
import { MAX_READ_QUERIES, type ReadQuery, type ReadResult } from './read-types'

function query(key: string, collection = 'todos'): ReadQuery {
	return { key, collection, where: {}, orderBy: [] }
}

function result(key: string): ReadResult {
	return {
		key,
		status: 'ok',
		records: [],
		included: {},
		includedStatus: {},
		refreshed: [],
		absent: [],
	}
}

interface Reply {
	status: number
	body: unknown
	headers?: Record<string, string>
}

function ok(keys: string[]): Reply {
	return { status: 200, body: { frontier: 7, grantKey: 'g1', results: keys.map(result) } }
}

function fail(status: number, code: string, retriable: boolean, extra: object = {}): Reply {
	return { status, body: { error: { code, message: `${code} happened`, retriable, ...extra } } }
}

/** A harness whose scheduler, sleep and fetch the test drives by hand: nothing depends on time. */
function harness(replies: Array<Reply | Error>, options: Partial<ReadThroughClientOptions> = {}) {
	const calls: Array<{ url: string; init: ReadFetchInit; queries: string[] }> = []
	const sleeps: number[] = []
	let scheduled: (() => void) | null = null
	const fetchImpl: ReadFetch = async (url, init) => {
		const next = replies.shift()
		const parsed = JSON.parse(init.body) as { queries: ReadQuery[] }
		calls.push({ url, init, queries: parsed.queries.map((q) => q.key) })
		if (next === undefined) throw new Error('no reply scripted')
		if (next instanceof Error) throw next
		const headers = next.headers ?? {}
		return {
			status: next.status,
			headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
			text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
		}
	}
	const client = new ReadThroughClient({
		url: 'https://api.test/kora-sync/read',
		schemaVersion: 3,
		fetch: fetchImpl,
		schedule: (flush) => {
			scheduled = flush
		},
		sleep: async (ms) => {
			sleeps.push(ms)
		},
		...options,
	})
	return {
		client,
		calls,
		sleeps,
		flush: (): void => {
			const run = scheduled
			scheduled = null
			run?.()
		},
	}
}

describe('ReadThroughClient', () => {
	it('sends the queries of one turn as one request and answers each', async () => {
		const h = harness([ok(['a', 'b'])])
		const a = h.client.read(query('a'))
		const b = h.client.read(query('b'))
		h.flush()
		const [ra, rb] = await Promise.all([a, b])
		expect(h.calls).toHaveLength(1)
		expect(h.calls[0]?.queries).toEqual(['a', 'b'])
		expect(ra).toMatchObject({ frontier: 7, grantKey: 'g1', result: { key: 'a' } })
		expect(rb.result.key).toBe('b')
		const sent = JSON.parse(h.calls[0]?.init.body ?? '{}')
		expect(sent).toMatchObject({ v: 1, schemaVersion: 3 })
	})

	it('restores the field versions and latest stamp the compact wire form leaves out', async () => {
		const created = { wallTime: 10, logical: 0, nodeId: 'n1' }
		const later = { wallTime: 20, logical: 1, nodeId: 'n2' }
		const compact = {
			...result('a'),
			records: [
				{ id: 'r1', values: { title: 'x', done: true }, fieldVersions: { done: later }, created },
			],
			refreshed: [{ id: 'r2', values: { title: 'y' }, fieldVersions: {}, created }],
		}
		const h = harness([{ status: 200, body: { frontier: 1, grantKey: 'g', results: [compact] } }])
		const pending = h.client.read(query('a'))
		h.flush()
		const answer = await pending
		expect(answer.result.records[0]).toMatchObject({
			fieldVersions: { title: created, done: later },
			latest: created,
		})
		expect(answer.result.refreshed[0]).toMatchObject({ fieldVersions: { title: created } })
	})

	it('shares one query between identical callers and refuses a key reused for another query', async () => {
		const h = harness([ok(['a'])])
		const first = h.client.read(query('a'))
		const second = h.client.read(query('a'))
		await expect(h.client.read(query('a', 'other'))).rejects.toMatchObject({
			code: 'READ_KEY_CONFLICT',
		})
		h.flush()
		await Promise.all([first, second])
		expect(h.calls[0]?.queries).toEqual(['a'])
	})

	it('splits more than the per-request maximum into several requests', async () => {
		const keys = Array.from({ length: MAX_READ_QUERIES + 2 }, (_, i) => `q${i}`)
		const h = harness([ok(keys.slice(0, MAX_READ_QUERIES)), ok(keys.slice(MAX_READ_QUERIES))])
		const all = keys.map((key) => h.client.read(query(key)))
		h.flush()
		await Promise.all(all)
		expect(h.calls.map((c) => c.queries.length)).toEqual([MAX_READ_QUERIES, 2])
	})

	it('retries a retriable failure, honoring retryAfterMs, then succeeds', async () => {
		const h = harness([fail(429, 'RATE_LIMITED', true, { retryAfterMs: 1_200 }), ok(['a'])])
		const p = h.client.read(query('a'))
		h.flush()
		await p
		expect(h.calls).toHaveLength(2)
		expect(h.sleeps).toEqual([1_200])
	})

	it('backs off deterministically and caps the wait', async () => {
		const h = harness(
			[fail(503, 'AUTH_UNAVAILABLE', true), fail(503, 'AUTH_UNAVAILABLE', true), ok(['a'])],
			{ maxRetryDelayMs: 300 },
		)
		const p = h.client.read(query('a'))
		h.flush()
		await p
		expect(h.sleeps).toEqual([250, 300])
	})

	it('gives up after the attempt budget with a retriable error', async () => {
		const h = harness([
			fail(503, 'AUTH_UNAVAILABLE', true),
			fail(503, 'AUTH_UNAVAILABLE', true),
			fail(503, 'AUTH_UNAVAILABLE', true),
		])
		const p = h.client.read(query('a'))
		h.flush()
		const error = await p.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(ReadThroughError)
		expect(error).toMatchObject({ code: 'AUTH_UNAVAILABLE', retriable: true, status: 503 })
		expect(h.calls).toHaveLength(3)
	})

	it('does not retry a refusal that is not retriable', async () => {
		const h = harness([fail(409, 'SCHEMA_MISMATCH', false)])
		const p = h.client.read(query('a'))
		h.flush()
		await expect(p).rejects.toMatchObject({
			code: 'SCHEMA_MISMATCH',
			retriable: false,
			status: 409,
		})
		expect(h.calls).toHaveLength(1)
	})

	it('retries a network error', async () => {
		const h = harness([new TypeError('offline'), ok(['a'])])
		const p = h.client.read(query('a'))
		h.flush()
		await p
		expect(h.calls).toHaveLength(2)
	})

	it('sends the credential, refreshes it once on 401, and treats a second 401 as final', async () => {
		const seen: Array<unknown> = []
		const auth = async (options?: { forceRefresh?: boolean }) => {
			seen.push(options)
			return { token: options?.forceRefresh ? 'fresh' : 'stale' }
		}
		const h = harness([fail(401, 'UNAUTHORIZED', false), ok(['a'])], { auth })
		const p = h.client.read(query('a'))
		h.flush()
		await p
		expect(seen).toEqual([undefined, { forceRefresh: true }])
		expect(h.calls[0]?.init.headers.authorization).toBe('Bearer stale')
		expect(h.calls[1]?.init.headers.authorization).toBe('Bearer fresh')

		const h2 = harness([fail(401, 'UNAUTHORIZED', false), fail(401, 'UNAUTHORIZED', false)], {
			auth,
		})
		const p2 = h2.client.read(query('a'))
		h2.flush()
		await expect(p2).rejects.toMatchObject({ status: 401, retriable: false })
		expect(h2.calls).toHaveLength(2)
	})

	it('remembers a missing endpoint and never asks again', async () => {
		const h = harness([{ status: 404, body: '' }])
		const p = h.client.read(query('a'))
		h.flush()
		await expect(p).rejects.toMatchObject({ code: 'READ_UNAVAILABLE', retriable: false })
		expect(h.client.unavailable).toBe(true)
		await expect(h.client.read(query('b'))).rejects.toMatchObject({ code: 'READ_UNAVAILABLE' })
		expect(h.calls).toHaveLength(1)
	})

	it('sends the cookie header only when cookies are enabled', async () => {
		const h = harness([ok(['a'])], { cookies: true })
		const p = h.client.read(query('a'))
		h.flush()
		await p
		expect(h.calls[0]?.init.headers['x-kora-read']).toBe('1')
		expect(h.calls[0]?.init.credentials).toBe('include')
		const plain = harness([ok(['a'])])
		const q = plain.client.read(query('a'))
		plain.flush()
		await q
		expect(plain.calls[0]?.init.headers['x-kora-read']).toBeUndefined()
		expect(plain.calls[0]?.init.credentials).toBeUndefined()
	})

	it('rejects a malformed answer and an answer missing a query', async () => {
		const bad = harness([{ status: 200, body: { nope: true } }])
		const p = bad.client.read(query('a'))
		bad.flush()
		await expect(p).rejects.toMatchObject({ code: 'READ_RESPONSE_INVALID' })
		const missing = harness([ok(['other'])])
		const q = missing.client.read(query('a'))
		missing.flush()
		await expect(q).rejects.toMatchObject({ code: 'READ_RESPONSE_INVALID' })
	})

	it('aborts one waiter without disturbing the others, and cancels the fetch only when all abort', async () => {
		const h = harness([ok(['a', 'b'])])
		const first = new AbortController()
		const a = h.client.read(query('a'), { signal: first.signal })
		const b = h.client.read(query('b'))
		first.abort()
		await expect(a).rejects.toMatchObject({ name: 'AbortError' })
		h.flush()
		await expect(b).resolves.toMatchObject({ result: { key: 'b' } })

		let sawSignal: AbortSignal | undefined
		const hung = harness([], {
			fetch: async (_url, init) => {
				sawSignal = init.signal
				return new Promise(() => {})
			},
		})
		const only = new AbortController()
		const c = hung.client.read(query('c'), { signal: only.signal })
		hung.flush()
		await Promise.resolve()
		only.abort()
		await expect(c).rejects.toMatchObject({ name: 'AbortError' })
		expect(sawSignal?.aborted).toBe(true)
	})

	it('rejects immediately for a signal that is already aborted', async () => {
		const h = harness([])
		const controller = new AbortController()
		controller.abort()
		await expect(h.client.read(query('a'), { signal: controller.signal })).rejects.toMatchObject({
			name: 'AbortError',
		})
		expect(h.calls).toHaveLength(0)
	})
})
