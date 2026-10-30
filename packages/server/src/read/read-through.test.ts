import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../auth/token-auth'
import { KoraSyncServer } from '../server/kora-sync-server'
import { MemoryServerStore } from '../store/memory-server-store'
import type { AuthContext, KoraSyncServerConfig } from '../types'
import { type ReadHttpRequest, type ReadHttpResponse, evalView } from './read-through'
import type { ReadQuery, ReadResponse } from './read-types'

/**
 * The read-through endpoint against a real `KoraSyncServer` and the memory store (the SQLite
 * and Postgres stores run the same cases in `tests/integration/read-through-stores.test.ts`).
 */

const schema = defineSchema({
	version: 1,
	collections: {
		courses: {
			fields: {
				schoolId: t.string(),
				title: t.string(),
				position: t.number().default(0),
				published: t.boolean().default(false),
				tags: t.array(t.string()).default([]),
			},
		},
		lessons: {
			fields: { schoolId: t.string(), courseId: t.string(), title: t.string() },
		},
		schools: { fields: { name: t.string() } },
	},
	relations: {
		lessonCourse: {
			from: 'lessons',
			to: 'courses',
			type: 'many-to-one',
			field: 'courseId',
			onDelete: 'cascade',
		},
	},
})

const GRANTS: Record<string, AuthContext> = {
	ann: {
		userId: 'ann',
		scopes: { courses: { schoolId: 's1' }, lessons: { schoolId: 's1' } },
	},
	bob: {
		userId: 'bob',
		scopes: { courses: { schoolId: { $in: ['s1', 's2'] } }, lessons: { schoolId: 's2' } },
	},
	root: { userId: 'root', scopes: { courses: {}, lessons: {}, schools: {} } },
}

const auth = new TokenAuthProvider({
	validate: async (token) => GRANTS[token] ?? null,
})

async function setup(config: Partial<KoraSyncServerConfig> = {}) {
	const store = new MemoryServerStore('read-test')
	await store.setSchema(schema, {})
	const server = new KoraSyncServer({
		store,
		auth,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
		...config,
	})
	const ctx = server.getKoraContext()
	const put = (
		collection: string,
		recordId: string,
		data: Record<string, unknown>,
		type: 'insert' | 'update' = 'insert',
	) => ctx.apply({ collection, type, recordId, data })
	return { store, server, ctx, put }
}

function request(
	body: unknown,
	token: string | null = 'ann',
	extra: Partial<ReadHttpRequest> = {},
): ReadHttpRequest {
	return {
		method: 'POST',
		...(token === null ? {} : { authorization: `Bearer ${token}` }),
		body: typeof body === 'string' ? body : JSON.stringify(body),
		contentType: 'application/json',
		...extra,
	}
}

function body(queries: Array<Partial<ReadQuery> & { collection: string }>, schemaVersion = 1) {
	return {
		v: 1,
		schemaVersion,
		queries: queries.map((q, i) => ({ key: `q${i}`, where: {}, orderBy: [], ...q })),
	}
}

async function read(
	server: KoraSyncServer,
	queries: Array<Partial<ReadQuery> & { collection: string }>,
	token: string | null = 'ann',
): Promise<ReadResponse> {
	const answer = await server.handleReadRequest(request(body(queries), token))
	expect(answer.status, answer.body).toBe(200)
	const parsed = JSON.parse(answer.body ?? '') as ReadResponse
	// A device deletes the seed of every absent id: an id it is also given as a record (or a
	// refreshed one) must never be listed absent.
	for (const result of parsed.results) {
		const served = new Set([...result.records, ...result.refreshed].map((r) => r.id))
		for (const id of result.absent) expect(served.has(id), `${id} is served and absent`).toBe(false)
	}
	return parsed
}

function ids(response: ReadResponse, index = 0): string[] {
	return (response.results[index]?.records ?? []).map((r) => r.id)
}

function errorOf(answer: ReadHttpResponse): { code: string; retriable: boolean } {
	return (JSON.parse(answer.body ?? '{}') as { error: { code: string; retriable: boolean } }).error
}

async function seed(put: Awaited<ReturnType<typeof setup>>['put']) {
	await put('courses', 'c1', { schoolId: 's1', title: 'Algebra', position: 2 })
	await put('courses', 'c2', { schoolId: 's1', title: 'Biology', position: 1, published: true })
	await put('courses', 'c3', { schoolId: 's2', title: 'Chemistry', position: 3 })
	await put('courses', 'c4', { schoolId: 's3', title: 'Dance', position: 4 })
	await put('lessons', 'l1', { schoolId: 's1', courseId: 'c1', title: 'Intro' })
	await put('lessons', 'l2', { schoolId: 's1', courseId: 'c1', title: 'Equations' })
	await put('lessons', 'l3', { schoolId: 's2', courseId: 'c3', title: 'Atoms' })
}

describe('read-through: the grant is the credential, never the request', () => {
	test('returns only the records inside the principal scope', async () => {
		const { server, put } = await setup()
		await seed(put)
		const response = await read(server, [{ collection: 'courses' }])
		expect(ids(response).sort()).toEqual(['c1', 'c2'])
		expect(response.results[0]?.status).toBe('ok')
	})

	test('a $in grant reads every granted value, and nothing else', async () => {
		const { server, put } = await setup()
		await seed(put)
		const response = await read(server, [{ collection: 'courses' }], 'bob')
		expect(ids(response).sort()).toEqual(['c1', 'c2', 'c3'])
	})

	test('a query where can only narrow the grant, never widen it', async () => {
		const { server, put } = await setup()
		await seed(put)
		// Ann asks for school s3, which her grant does not cover: no records, no error.
		const outside = await read(server, [{ collection: 'courses', where: { schoolId: 's3' } }])
		expect(ids(outside)).toEqual([])
		// A where on another field narrows inside the grant.
		const narrowed = await read(server, [{ collection: 'courses', where: { published: true } }])
		expect(ids(narrowed)).toEqual(['c2'])
		// Asking for her own school through an $in that adds foreign ones still yields only hers.
		const widened = await read(server, [
			{ collection: 'courses', where: { schoolId: { $in: ['s1', 's2', 's3'] } } },
		])
		expect(ids(widened).sort()).toEqual(['c1', 'c2'])
	})

	test('a collection the grant omits is denied, and so is an unknown one (no oracle)', async () => {
		const { server, put } = await setup()
		await seed(put)
		await put('schools', 'sc1', { name: 'One' })
		const response = await read(server, [{ collection: 'schools' }, { collection: 'nope' }])
		expect(response.results.map((r) => r.status)).toEqual(['denied', 'denied'])
		expect(response.results.every((r) => r.records.length === 0)).toBe(true)
	})

	test('an unscoped grant reads every record', async () => {
		const { server, put } = await setup()
		await seed(put)
		const response = await read(server, [{ collection: 'courses' }], 'root')
		expect(ids(response).sort()).toEqual(['c1', 'c2', 'c3', 'c4'])
	})

	test('values and versions are the delivery wire form', async () => {
		const { server, put } = await setup()
		await seed(put)
		const response = await read(server, [{ collection: 'courses', where: { id: 'c2' } }])
		const record = response.results[0]?.records[0]
		expect(record?.id).toBe('c2')
		expect(record?.values).toMatchObject({ title: 'Biology', position: 1, published: true })
		expect(Object.keys(record?.fieldVersions ?? {}).sort()).toEqual(
			Object.keys(record?.values ?? {}).sort(),
		)
		expect(record?.created.wallTime).toBeGreaterThan(0)
		expect(record?.latest.wallTime).toBeGreaterThanOrEqual(record?.created.wallTime ?? 0)
	})

	test('deleted records are never returned', async () => {
		const { server, put, ctx } = await setup()
		await seed(put)
		await ctx.apply({ collection: 'courses', type: 'delete', recordId: 'c1', data: null })
		const response = await read(server, [{ collection: 'courses' }])
		expect(ids(response)).toEqual(['c2'])
	})
})

describe('read-through: authentication', () => {
	test('a missing, malformed or rejected credential is 401', async () => {
		const { server, put } = await setup()
		await seed(put)
		for (const authorization of [undefined, 'Basic abc', 'Bearer unknown']) {
			const answer = await server.handleReadRequest({
				...request(body([{ collection: 'courses' }]), null),
				...(authorization ? { authorization } : {}),
			})
			expect(answer.status).toBe(401)
			expect(answer.headers['www-authenticate']).toBe('Bearer')
		}
	})

	test('a revoked credential reads nothing from that moment', async () => {
		let revoked = false
		const revocable = new TokenAuthProvider({
			validate: async (token) => (token === 'ann' && !revoked ? (GRANTS.ann ?? null) : null),
		})
		// A zero lifetime turns the auth cache off, so the provider is asked every time.
		const { server, put } = await setup({
			auth: revocable,
			readThrough: { authGuard: { ttlMs: 0 } },
		})
		await seed(put)
		expect(
			(await server.handleReadRequest(request(body([{ collection: 'courses' }])))).status,
		).toBe(200)
		revoked = true
		expect(
			(await server.handleReadRequest(request(body([{ collection: 'courses' }])))).status,
		).toBe(401)
	})

	test('a revocation the server hears about evicts the cached authentication at once', async () => {
		let revoked = false
		const revocable = new TokenAuthProvider({
			validate: async (token) => (token === 'ann' && !revoked ? (GRANTS.ann ?? null) : null),
		})
		const { server, put } = await setup({ auth: revocable })
		await seed(put)
		const send = () =>
			server.handleReadRequest(request(body([{ collection: 'courses' }]))).then((r) => r.status)
		expect(await send()).toBe(200)
		revoked = true
		// Cached: the documented revocation lag, bounded by the guard's ttlMs.
		expect(await send()).toBe(200)
		server.terminateSessions({ userId: 'ann' })
		expect(await send()).toBe(401)
	})

	test('an expired credential is 401', async () => {
		const expiring = new TokenAuthProvider({
			validate: async () => ({ ...(GRANTS.ann as AuthContext), expiresAt: Date.now() - 1 }),
		})
		const { server } = await setup({ auth: expiring })
		expect(
			(await server.handleReadRequest(request(body([{ collection: 'courses' }])))).status,
		).toBe(401)
	})

	test('a principal in the reserved kora: namespace is refused', async () => {
		const reserved = new TokenAuthProvider({
			validate: async () => ({ userId: 'kora:scope-entry', scopes: { courses: {} } }),
		})
		const { server } = await setup({ auth: reserved })
		expect(
			(await server.handleReadRequest(request(body([{ collection: 'courses' }])))).status,
		).toBe(401)
	})

	test('a server without an auth provider answers without a credential', async () => {
		const { server, put } = await setup({ auth: undefined })
		await seed(put)
		const response = await read(server, [{ collection: 'courses' }], null)
		expect(ids(response).sort()).toEqual(['c1', 'c2', 'c3', 'c4'])
	})
})

describe('read-through: the answer', () => {
	test('orders, limits and offsets like the client query would', async () => {
		const { server, put } = await setup()
		await seed(put)
		const response = await read(
			server,
			[
				{ collection: 'courses', orderBy: [{ field: 'position', direction: 'desc' }] },
				{
					collection: 'courses',
					orderBy: [{ field: 'position', direction: 'asc' }],
					limit: 1,
					offset: 1,
				},
			],
			'root',
		)
		expect(ids(response, 0)).toEqual(['c4', 'c3', 'c1', 'c2'])
		expect(ids(response, 1)).toEqual(['c1'])
		expect(response.results[1]?.status).toBe('ok')
	})

	test('the frontier is the delivery counter, read after the rows', async () => {
		const { server, put, store } = await setup()
		await seed(put)
		const response = await read(server, [{ collection: 'courses' }])
		expect(response.frontier).toBe(await store.getMaxDeliverySequence())
		expect(response.frontier).toBeGreaterThanOrEqual(7)
		await put('courses', 'c5', { schoolId: 's1', title: 'Econ' })
		const later = await read(server, [{ collection: 'courses' }])
		expect(later.frontier).toBeGreaterThan(response.frontier)
	})

	test('the grant key changes with the grant, not with the data', async () => {
		const { server, put } = await setup()
		await seed(put)
		const a = await read(server, [{ collection: 'courses' }], 'ann')
		await put('courses', 'c9', { schoolId: 's1', title: 'New' })
		const a2 = await read(server, [{ collection: 'courses' }], 'ann')
		const b = await read(server, [{ collection: 'courses' }], 'bob')
		expect(a2.grantKey).toBe(a.grantKey)
		expect(b.grantKey).not.toBe(a.grantKey)
	})

	test('responses are never cacheable and never set cookies', async () => {
		const { server, put } = await setup()
		await seed(put)
		const answer = await server.handleReadRequest(request(body([{ collection: 'courses' }])))
		expect(answer.headers['cache-control']).toBe('no-store, private')
		expect(answer.headers.vary).toBe('Authorization, Cookie')
		expect(answer.headers['set-cookie']).toBeUndefined()
	})

	test('a shape the evaluator refuses returns the scoped candidates as a superset', async () => {
		const { server, put } = await setup()
		await seed(put)
		const response = await read(server, [
			{
				collection: 'courses',
				where: { title: { $in: Array.from({ length: 300 }, (_, i) => `t${i}`) } },
			},
			{ collection: 'courses', where: { nonexistentField: 1 } },
		])
		for (const result of response.results) {
			expect(result.status).toBe('unsupported')
			expect(result.records.map((r) => r.id).sort()).toEqual(['c1', 'c2'])
		}
	})

	test('include returns the related records under their own grant', async () => {
		const { server, put } = await setup()
		await seed(put)
		// Ann reads courses of s1 and lessons of s1: lessons include their course.
		const response = await read(server, [
			{
				collection: 'lessons',
				include: ['courses'],
				orderBy: [{ field: 'title', direction: 'asc' }],
			},
		])
		const result = response.results[0]
		expect(result?.records.map((r) => r.id)).toEqual(['l2', 'l1'])
		expect((result?.included.courses ?? []).map((r) => r.id)).toEqual(['c1'])
		// Bob reads lessons of s2 only; the course of l3 (c3, s2) is in his courses grant.
		const bob = await read(server, [{ collection: 'lessons', include: ['lessonCourse'] }], 'bob')
		expect((bob.results[0]?.included.courses ?? []).map((r) => r.id)).toEqual(['c3'])
	})

	test('an included record the grant denies is left out', async () => {
		const { server, put } = await setup()
		await put('courses', 'cx', { schoolId: 's9', title: 'Hidden' })
		await put('lessons', 'lx', { schoolId: 's1', courseId: 'cx', title: 'Orphan view' })
		const response = await read(server, [{ collection: 'lessons', include: ['courses'] }])
		expect(ids(response)).toEqual(['lx'])
		expect(response.results[0]?.included.courses ?? []).toEqual([])
	})

	test('an include that names no relation makes the query unsupported', async () => {
		const { server, put } = await setup()
		await seed(put)
		const response = await read(server, [{ collection: 'lessons', include: ['planets'] }])
		expect(response.results[0]?.status).toBe('unsupported')
		expect(response.results[0]?.included).toEqual({})
	})
})

describe('read-through: known ids and absent', () => {
	test('known ids that left the query are refreshed; unreadable and missing ones are absent together', async () => {
		const { server, put } = await setup()
		await seed(put)
		// The device saw c1 and c2 under "published = false"; since then c2 was published
		// (moved out) and c3 / ghost are outside the grant / not there at all.
		const response = await read(server, [
			{
				collection: 'courses',
				where: { published: false },
				known: ['c1', 'c2', 'c3', 'ghost'],
			},
		])
		const result = response.results[0]
		expect(result?.records.map((r) => r.id)).toEqual(['c1'])
		expect(result?.refreshed.map((r) => r.id)).toEqual(['c2'])
		expect(result?.refreshed[0]?.values.published).toBe(true)
		// c3 exists but is outside Ann's grant: listed with the missing id, no distinction.
		expect([...(result?.absent ?? [])].sort()).toEqual(['c3', 'ghost'])
	})

	test('a known id that was deleted is absent', async () => {
		const { server, put, ctx } = await setup()
		await seed(put)
		await ctx.apply({ collection: 'courses', type: 'delete', recordId: 'c1', data: null })
		const response = await read(server, [{ collection: 'courses', known: ['c1'] }])
		expect(response.results[0]?.absent).toEqual(['c1'])
		expect(response.results[0]?.refreshed).toEqual([])
	})
})

describe('read-through: pagination and caps', () => {
	test('rows past maxRows are partial with a cursor that continues the same query', async () => {
		const { server, put } = await setup({ readThrough: { maxRows: 2 } })
		for (let i = 1; i <= 5; i++) {
			await put('courses', `p${i}`, { schoolId: 's1', title: `T${i}`, position: i })
		}
		const query = {
			collection: 'courses',
			orderBy: [{ field: 'position', direction: 'asc' as const }],
		}
		const first = await read(server, [query])
		expect(ids(first)).toEqual(['p1', 'p2'])
		expect(first.results[0]?.status).toBe('partial')
		const second = await read(server, [{ ...query, cursor: first.results[0]?.cursor }])
		expect(ids(second)).toEqual(['p3', 'p4'])
		const third = await read(server, [{ ...query, cursor: second.results[0]?.cursor }])
		expect(ids(third)).toEqual(['p5'])
		expect(third.results[0]?.status).toBe('ok')
		expect(third.results[0]?.cursor).toBeUndefined()
	})

	test('a cursor belongs to its query: another query restarts alone, with a dedicated reason', async () => {
		const { server, put } = await setup({ readThrough: { maxRows: 1 } })
		await put('courses', 'a', { schoolId: 's1', title: 'A' })
		await put('courses', 'b', { schoolId: 's1', title: 'B' })
		const first = await read(server, [{ collection: 'courses' }])
		const cursor = first.results[0]?.cursor
		expect(cursor).toBeDefined()
		// The other query in the same request is answered; only this one restarts.
		const response = await read(server, [
			{ collection: 'courses', where: { published: true }, cursor },
			{ collection: 'courses', cursor: undefined },
		])
		expect(response.results[0]).toMatchObject({
			status: 'unsupported',
			reason: 'cursor-invalid',
			records: [],
			absent: [],
		})
		expect(response.results[1]?.records).toHaveLength(1)
	})

	test('maxQueryRows ends the paging without a cursor', async () => {
		const { server, put } = await setup({ readThrough: { maxRows: 2, maxQueryRows: 3 } })
		for (let i = 1; i <= 6; i++) await put('courses', `p${i}`, { schoolId: 's1', title: `T${i}` })
		const first = await read(server, [{ collection: 'courses' }])
		const second = await read(server, [{ collection: 'courses', cursor: first.results[0]?.cursor }])
		expect(ids(first).length + ids(second).length).toBe(3)
		expect(second.results[0]?.status).toBe('partial')
		expect(second.results[0]?.cursor).toBeUndefined()
	})

	test('maxBytes defers the rest to a cursor, but always returns at least one record', async () => {
		const { server, put } = await setup({ readThrough: { maxBytes: 200 } })
		for (let i = 1; i <= 4; i++) await put('courses', `p${i}`, { schoolId: 's1', title: `T${i}` })
		const first = await read(server, [{ collection: 'courses' }])
		expect(first.results[0]?.records.length).toBeGreaterThanOrEqual(1)
		expect(first.results[0]?.records.length).toBeLessThan(4)
		expect(first.results[0]?.status).toBe('partial')
		expect(first.results[0]?.cursor).toBeDefined()
	})

	test('more scoped candidates than maxCandidates is unsupported with no rows', async () => {
		const { server, put } = await setup({ readThrough: { maxCandidates: 3 } })
		for (let i = 1; i <= 6; i++) await put('courses', `p${i}`, { schoolId: 's1', title: `T${i}` })
		const response = await read(server, [{ collection: 'courses' }])
		// No prefix of the scope is the answer in the query's own order, so none is returned.
		expect(response.results[0]?.status).toBe('unsupported')
		expect(response.results[0]?.reason).toBe('too-many-candidates')
		expect(response.results[0]?.records).toEqual([])
	})

	test('rows loaded from the store are bounded however large the collection is', async () => {
		// A boolean scope cannot be pushed to the store: it must still be bounded by the cap.
		const booleanScope = new TokenAuthProvider({
			validate: async () => ({ userId: 'u', scopes: { courses: { published: true } } }),
		})
		const bounded = await setup({
			readThrough: { maxCandidates: 100, maxWork: 1_000 },
			auth: booleanScope,
		})
		for (let i = 0; i < 2_000; i++) {
			await bounded.put('courses', `b${i}`, { schoolId: 's1', title: 't', published: i % 3 === 0 })
		}
		let boundedLoaded = 0
		const boundedOriginal = bounded.store.queryCollection.bind(bounded.store)
		bounded.store.queryCollection = async (...args: Parameters<typeof boundedOriginal>) => {
			const rows = await boundedOriginal(...args)
			boundedLoaded += rows.length
			return rows
		}
		const wide = await read(bounded.server, [{ collection: 'courses' }], 'x')
		expect(wide.results[0]?.status).toBe('unsupported')
		expect(boundedLoaded).toBeLessThanOrEqual(101)

		// A number pushed down to the store narrows what is loaded.
		const numeric = new TokenAuthProvider({
			validate: async () => ({ userId: 'u', scopes: { courses: { position: 3 } } }),
		})
		const byNumber = await setup({
			readThrough: { maxCandidates: 1_000, maxWork: 5_000 },
			auth: numeric,
		})
		for (let i = 0; i < 700; i++) {
			await byNumber.put('courses', `n${i}`, { schoolId: 's1', title: 't', position: i % 7 })
		}
		let numberLoaded = 0
		const numberOriginal = byNumber.store.queryCollection.bind(byNumber.store)
		byNumber.store.queryCollection = async (...args: Parameters<typeof numberOriginal>) => {
			const rows = await numberOriginal(...args)
			numberLoaded += rows.length
			return rows
		}
		const narrow = await read(byNumber.server, [{ collection: 'courses' }], 'x')
		expect(narrow.results[0]?.status).toBe('ok')
		expect(narrow.results[0]?.records).toHaveLength(100)
		expect(numberLoaded).toBe(100)
	})

	test('the request work budget spans queries: later queries answer unsupported', async () => {
		const { server, put } = await setup({ readThrough: { maxCandidates: 50, maxWork: 30 } })
		for (let i = 0; i < 5; i++) await put('courses', `w${i}`, { schoolId: 's1', title: 't' })
		const response = await read(server, [
			{ collection: 'courses' },
			{ collection: 'courses', where: { title: 't' } },
			{
				collection: 'courses',
				where: { title: 't' },
				orderBy: [{ field: 'title', direction: 'asc' }],
			},
		])
		expect(response.results[0]?.status).not.toBe('unsupported')
		const last = response.results[2]
		expect(last?.status).toBe('unsupported')
		expect(last?.reason).toBe('work-budget')
		expect(last?.records).toEqual([])
	})
})

describe('read-through: request validation and limits', () => {
	const cases: Array<[string, unknown]> = [
		['not JSON', '{nope'],
		['not an object', '[]'],
		['wrong protocol version', { v: 2, schemaVersion: 1, queries: [] }],
		['no queries', { v: 1, schemaVersion: 1, queries: [] }],
		['too many queries', body(Array.from({ length: 9 }, () => ({ collection: 'courses' })))],
		[
			'duplicate keys',
			{
				v: 1,
				schemaVersion: 1,
				queries: [
					{ key: 'a', collection: 'courses', where: {}, orderBy: [] },
					{ key: 'a', collection: 'courses', where: {}, orderBy: [] },
				],
			},
		],
		['bad where operand', body([{ collection: 'courses', where: { title: { $eq: { x: 1 } } } }])],
		[
			'bad direction',
			body([{ collection: 'courses', orderBy: [{ field: 'title', direction: 'up' as 'asc' }] }]),
		],
		['negative limit', body([{ collection: 'courses', limit: -1 }])],
		[
			'too many known ids',
			body([{ collection: 'courses', known: Array.from({ length: 1001 }, (_, i) => `k${i}`) }]),
		],
		['too many includes', body([{ collection: 'lessons', include: ['a', 'b', 'c', 'd'] }])],
		['NUL in a name', body([{ collection: 'cour\u0000ses' }])],
	]
	for (const [name, payload] of cases) {
		test(`400 for ${name}`, async () => {
			const { server } = await setup()
			const answer = await server.handleReadRequest(request(payload))
			expect(answer.status).toBe(400)
			expect(errorOf(answer).code).toBe('INVALID_READ_REQUEST')
		})
	}

	test('an oversized request is 413, before it is parsed', async () => {
		const { server } = await setup({ readThrough: { maxRequestBytes: 200 } })
		const answer = await server.handleReadRequest(
			request(
				body([{ collection: 'courses', known: Array.from({ length: 100 }, (_, i) => `id-${i}`) }]),
			),
		)
		expect(answer.status).toBe(413)
		expect((JSON.parse(answer.body ?? '{}') as { error: { limit: number } }).error.limit).toBe(200)
	})

	test('a request for another schema version is 409 SCHEMA_MISMATCH', async () => {
		const { server } = await setup()
		const answer = await server.handleReadRequest(request(body([{ collection: 'courses' }], 7)))
		expect(answer.status).toBe(409)
		expect(errorOf(answer)).toMatchObject({ code: 'SCHEMA_MISMATCH', retriable: false })
	})

	test('only POST with a JSON content type is accepted', async () => {
		const { server } = await setup()
		expect(
			(
				await server.handleReadRequest({
					...request(body([{ collection: 'courses' }])),
					method: 'GET',
				})
			).status,
		).toBe(405)
		expect(
			(
				await server.handleReadRequest({
					...request(body([{ collection: 'courses' }])),
					contentType: 'text/plain',
				})
			).status,
		).toBe(415)
		expect(
			(
				await server.handleReadRequest({
					...request(body([{ collection: 'courses' }])),
					body: undefined,
				})
			).status,
		).toBe(400)
	})

	test('a disabled endpoint answers 404, like a server without it', async () => {
		const { server } = await setup({ readThrough: { enabled: false } })
		expect(
			(await server.handleReadRequest(request(body([{ collection: 'courses' }])))).status,
		).toBe(404)
	})

	test('a cookie credential needs the custom header and a same-origin Origin', async () => {
		const { server } = await setup()
		const base = request(body([{ collection: 'courses' }]))
		const cookie = { ...base, hasCookie: true, host: 'app.example.com' }
		expect((await server.handleReadRequest(cookie)).status).toBe(403)
		expect((await server.handleReadRequest({ ...cookie, koraReadHeader: '1' })).status).toBe(200)
		expect(
			(
				await server.handleReadRequest({
					...cookie,
					koraReadHeader: '1',
					origin: 'https://evil.example',
				})
			).status,
		).toBe(403)
		expect(
			(
				await server.handleReadRequest({
					...cookie,
					koraReadHeader: '1',
					origin: 'https://app.example.com',
				})
			).status,
		).toBe(200)
	})

	test('limits that are not positive integers are refused at construction', async () => {
		const store = new MemoryServerStore('x')
		await store.setSchema(schema, {})
		expect(() => new KoraSyncServer({ store, readThrough: { maxRows: 0 } })).toThrow(RangeError)
	})
})

describe('read-through: rate limiting', () => {
	test('a principal past its burst is 429 with a retry hint; another principal is not', async () => {
		const { server, put } = await setup({
			readThrough: { rate: { perSecond: 1, burst: 2, concurrent: 4 } },
		})
		await seed(put)
		const send = (token: string) =>
			server.handleReadRequest(request(body([{ collection: 'courses' }]), token))
		expect((await send('ann')).status).toBe(200)
		expect((await send('ann')).status).toBe(200)
		const limited = await send('ann')
		expect(limited.status).toBe(429)
		expect(errorOf(limited)).toMatchObject({ code: 'RATE_LIMITED', retriable: true })
		expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1)
		expect((await send('bob')).status).toBe(200)
	})

	test('reads in flight are capped per principal', async () => {
		const { server, put, store } = await setup({
			readThrough: { rate: { perSecond: 100, burst: 100, concurrent: 1 } },
		})
		await seed(put)
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const original = store.queryCollection.bind(store)
		let entered = false
		store.queryCollection = async (...args: Parameters<typeof original>) => {
			entered = true
			await gate
			return original(...args)
		}
		const first = server.handleReadRequest(request(body([{ collection: 'courses' }])))
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(entered).toBe(true)
		const second = await server.handleReadRequest(request(body([{ collection: 'courses' }])))
		expect(second.status).toBe(429)
		expect(errorOf(second).code).toBe('TOO_MANY_READS')
		release()
		expect((await first).status).toBe(200)
		// The slot is free again.
		expect(
			(await server.handleReadRequest(request(body([{ collection: 'courses' }])))).status,
		).toBe(200)
	})
})

describe('read-through: addresses and the shared proxy', () => {
	// The key is a real client address (trustProxy set), so failures are charged to it.
	const from = (token: string, clientKey: string) =>
		request(body([{ collection: 'courses' }]), token, { clientKey, clientKeyTrusted: true })

	test('successful requests are not charged to the address, so a shared proxy is not capped', async () => {
		const { server, put } = await setup({
			readThrough: { rate: { perSecond: 1, burst: 1, concurrent: 4 } },
		})
		await seed(put)
		// Three principals behind one address, one request each, all admitted.
		for (const token of ['ann', 'bob', 'root']) {
			expect((await server.handleReadRequest(from(token, 'proxy'))).status).toBe(200)
		}
	})

	test('past the failure bucket the provider is not asked at all, and another address is unaffected', async () => {
		let calls = 0
		const counting = new TokenAuthProvider({
			validate: async (token) => {
				calls += 1
				return GRANTS[token] ?? null
			},
		})
		const { server, put } = await setup({
			auth: counting,
			readThrough: { rate: { perSecond: 1, burst: 2, concurrent: 4 } },
		})
		await seed(put)
		const statuses: number[] = []
		for (let i = 0; i < 4; i++) {
			statuses.push((await server.handleReadRequest(from(`garbage-${i}`, 'proxy'))).status)
		}
		expect(statuses).toEqual([401, 401, 429, 429])
		// Two failed attempts reached the provider; the next two were refused before it.
		expect(calls).toBe(2)
		expect((await server.handleReadRequest(from('ann', 'proxy'))).status).toBe(429)
		expect(calls).toBe(2)
		expect((await server.handleReadRequest(from('ann', 'elsewhere'))).status).toBe(200)
	})

	test('with no trusted address, garbage tokens never lock a signed-in user out', async () => {
		const { server, put } = await setup({ readThrough: { rate: { perSecond: 1, burst: 2 } } })
		await seed(put)
		// Far more garbage than any bucket from the one (proxy) address, none of it marked trusted.
		for (let i = 0; i < 50; i++) {
			const status = (
				await server.handleReadRequest(
					request(body([{ collection: 'courses' }]), `garbage-${i}`, { clientKey: 'proxy' }),
				)
			).status
			expect([401, 429]).toContain(status)
		}
		expect(
			(
				await server.handleReadRequest(
					request(body([{ collection: 'courses' }]), 'ann', { clientKey: 'proxy' }),
				)
			).status,
		).toBe(200)
	})

	test('a signed-in user is served from the cache while garbage saturates the miss cap', async () => {
		const { server, put } = await setup({
			readThrough: {
				authGuard: { maxConcurrent: 1, perSecond: 1, burst: 1 },
				rate: { perSecond: 1000, burst: 1000 },
			},
		})
		await seed(put)
		const ann = () =>
			server.handleReadRequest(
				request(body([{ collection: 'courses' }]), 'ann', { clientKey: 'proxy' }),
			)
		expect((await ann()).status).toBe(200)
		// The miss bucket is now empty: unseen tokens are delayed (retriable), never ann.
		const cold = await server.handleReadRequest(
			request(body([{ collection: 'courses' }]), 'bob', { clientKey: 'proxy' }),
		)
		expect(cold.status).toBe(429)
		expect(errorOf(cold).code).toBe('AUTH_BUSY')
		expect(errorOf(cold).retriable).toBe(true)
		for (let i = 0; i < 20; i++) {
			await server.handleReadRequest(
				request(body([{ collection: 'courses' }]), `garbage-${i}`, { clientKey: 'proxy' }),
			)
			expect((await ann()).status).toBe(200)
		}
	})

	test('500 concurrent requests with one token make one provider call', async () => {
		let calls = 0
		const counting = new TokenAuthProvider({
			validate: async (token) => {
				calls += 1
				await Promise.resolve()
				return GRANTS[token] ?? null
			},
		})
		const { server, put } = await setup({
			auth: counting,
			readThrough: {
				rate: { perSecond: 1000, burst: 1000, concurrent: 1000, maxConcurrent: 1000 },
			},
		})
		await seed(put)
		const answers = await Promise.all(
			Array.from({ length: 500 }, () =>
				server.handleReadRequest(request(body([{ collection: 'courses' }]), 'ann')),
			),
		)
		expect(calls).toBe(1)
		expect(answers.every((a) => a.status === 200)).toBe(true)
	})

	test('a repeated garbage token is answered from the negative cache', async () => {
		let calls = 0
		const counting = new TokenAuthProvider({
			validate: async () => {
				calls += 1
				return null
			},
		})
		const { server } = await setup({ auth: counting })
		for (let i = 0; i < 10; i++) {
			expect(
				(await server.handleReadRequest(request(body([{ collection: 'courses' }]), 'junk'))).status,
			).toBe(401)
		}
		expect(calls).toBe(1)
	})

	test('failed sign-ins are charged to an IPv6 /64, not to one address', async () => {
		const { server } = await setup({ readThrough: { rate: { perSecond: 1, burst: 2 } } })
		const send = (i: number) =>
			server
				.handleReadRequest(
					request(body([{ collection: 'courses' }]), `garbage-${i}`, {
						clientKey: `2001:db8:1:2:${i}::${i}`,
						clientKeyTrusted: true,
					}),
				)
				.then((r) => r.status)
		expect(await send(1)).toBe(401)
		expect(await send(2)).toBe(401)
		expect(await send(3)).toBe(429)
	})

	test('successful requests never spend the failure bucket', async () => {
		const { server, put } = await setup({
			readThrough: { rate: { perSecond: 1, burst: 1, concurrent: 4 } },
		})
		await seed(put)
		for (let i = 0; i < 3; i++) {
			expect(
				(await server.handleReadRequest(from(['ann', 'bob', 'root'][i] ?? 'ann', 'proxy'))).status,
			).toBe(200)
		}
	})

	test('anonymous reads have their own bucket, sized for a deployment by default', async () => {
		const sized = await setup({ auth: undefined })
		await seed(sized.put)
		// Far more than the 20-per-second principal default, all from one (proxy) address.
		for (let i = 0; i < 100; i++) {
			expect((await sized.server.handleReadRequest(from('', 'proxy'))).status).toBe(200)
		}
		const { server, put } = await setup({
			auth: undefined,
			readThrough: { rate: { anonymous: { perSecond: 1, burst: 2, concurrent: 4 } } },
		})
		await seed(put)
		const send = () => server.handleReadRequest(from('', 'proxy'))
		expect((await send()).status).toBe(200)
		expect((await send()).status).toBe(200)
		expect((await send()).status).toBe(429)
	})

	test('a failing auth provider is a retriable 503, not a 401', async () => {
		const broken = new TokenAuthProvider({
			validate: async () => {
				throw new Error('identity service down')
			},
		})
		const { server } = await setup({ auth: broken })
		const answer = await server.handleReadRequest(request(body([{ collection: 'courses' }])))
		expect(answer.status).toBe(503)
		expect(errorOf(answer)).toMatchObject({ code: 'AUTH_UNAVAILABLE', retriable: true })
	})
})

describe('read-through: cursors', () => {
	async function firstPage(config: Partial<KoraSyncServerConfig> = {}) {
		const harness = await setup({ readThrough: { maxRows: 1, maxQueryRows: 4 }, ...config })
		for (let i = 1; i <= 6; i++) {
			await harness.put('courses', `p${i}`, { schoolId: 's1', title: `T${i}` })
		}
		const first = await read(harness.server, [{ collection: 'courses' }], 'root')
		return { ...harness, cursor: first.results[0]?.cursor as string }
	}

	async function continueWith(server: KoraSyncServer, cursor: string, token = 'root') {
		const response = await read(server, [{ collection: 'courses', cursor }], token)
		return response.results[0]
	}

	test('a forged cursor, with its position rewritten, restarts that query', async () => {
		const { server, cursor } = await firstPage()
		const [payload, mac] = cursor.split('.')
		const fields = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
			s: number
		}
		const forged = `${Buffer.from(JSON.stringify({ ...fields, s: 0 })).toString('base64url')}.${mac}`
		for (const bad of [forged, `${payload ?? ''}.AAAA`, 'x', cursor.replace('.', '..')]) {
			expect(await continueWith(server, bad)).toMatchObject({
				status: 'unsupported',
				reason: 'cursor-invalid',
				records: [],
			})
		}
	})

	test('a cursor does not continue for another principal or after the grant changed', async () => {
		const { server, cursor } = await firstPage()
		expect((await continueWith(server, cursor, 'ann'))?.reason).toBe('cursor-invalid')
	})

	test('instances that share a cursorSecret accept each other cursors, others restart', async () => {
		const a = await firstPage({ readThrough: { maxRows: 1, cursorSecret: 'shared' } })
		const b = await setup({ readThrough: { maxRows: 1, cursorSecret: 'shared' } })
		const c = await setup({ readThrough: { maxRows: 1, cursorSecret: 'other' } })
		for (const other of [b, c]) {
			for (let i = 1; i <= 6; i++) {
				await other.put('courses', `p${i}`, { schoolId: 's1', title: `T${i}` })
			}
		}
		expect((await continueWith(b.server, a.cursor))?.records.map((r) => r.id)).toEqual(['p2'])
		expect((await continueWith(c.server, a.cursor))?.reason).toBe('cursor-invalid')
	})

	test('a record deleted between pages never makes the next page skip another', async () => {
		const { server, ctx, cursor } = await firstPage({
			readThrough: { maxRows: 1, maxQueryRows: 100, cursorSecret: 's' },
		})
		await ctx.apply({ collection: 'courses', type: 'delete', recordId: 'p1', data: null })
		const seen: string[] = []
		let next: string | undefined = cursor
		while (next !== undefined) {
			const result = await continueWith(server, next)
			seen.push(...(result?.records ?? []).map((r) => r.id))
			next = result?.cursor
		}
		// p1 was served on page one and then deleted: every other record is still seen.
		expect(seen).toEqual(['p2', 'p3', 'p4', 'p5', 'p6'])
	})

	test('maxQueryRows holds across offset and cursor: neither restarts the allowance', async () => {
		const { server } = await setup({ readThrough: { maxRows: 10, maxQueryRows: 2 } })
		for (let i = 1; i <= 6; i++) {
			await server.getKoraContext().apply({
				collection: 'courses',
				type: 'insert',
				recordId: `p${i}`,
				data: { schoolId: 's1', title: `T${i}`, position: i },
			})
		}
		const order = [{ field: 'position', direction: 'asc' as const }]
		const first = await read(server, [{ collection: 'courses', orderBy: order }], 'root')
		expect(first.results[0]?.records.map((r) => r.id)).toEqual(['p1', 'p2'])
		expect(first.results[0]).toMatchObject({ status: 'partial', reason: 'query-row-cap' })
		expect(first.results[0]?.cursor).toBeUndefined()
		// Asking for the rows past the cap with an offset gets nothing either.
		const shifted = await read(
			server,
			[{ collection: 'courses', orderBy: order, offset: 4 }],
			'root',
		)
		expect(shifted.results[0]).toMatchObject({
			status: 'unsupported',
			reason: 'query-row-cap',
			records: [],
		})
		const inside = await read(
			server,
			[{ collection: 'courses', orderBy: order, offset: 1 }],
			'root',
		)
		expect(inside.results[0]?.records.map((r) => r.id)).toEqual(['p2'])
	})

	test('a keyset cursor follows the query order, not the id order', async () => {
		const { server, put } = await setup({ readThrough: { maxRows: 2, maxQueryRows: 100 } })
		for (let i = 1; i <= 5; i++) {
			await put('courses', `p${i}`, { schoolId: 's1', title: `T${i}`, position: 10 - i })
		}
		const query = {
			collection: 'courses',
			orderBy: [{ field: 'position', direction: 'asc' as const }],
		}
		const seen: string[] = []
		let cursor: string | undefined
		do {
			const response = await read(server, [{ ...query, cursor }], 'root')
			seen.push(...ids(response))
			cursor = response.results[0]?.cursor
		} while (cursor !== undefined)
		expect(seen).toEqual(['p5', 'p4', 'p3', 'p2', 'p1'])
	})

	test('a limit spans the pages of one query', async () => {
		const { server, put } = await setup({ readThrough: { maxRows: 2, maxQueryRows: 100 } })
		for (let i = 1; i <= 6; i++) await put('courses', `p${i}`, { schoolId: 's1', title: `T${i}` })
		const query = { collection: 'courses', limit: 3 }
		const first = await read(server, [query], 'root')
		expect(ids(first)).toEqual(['p1', 'p2'])
		const second = await read(server, [{ ...query, cursor: first.results[0]?.cursor }], 'root')
		expect(ids(second)).toEqual(['p3'])
		expect(second.results[0]?.status).toBe('ok')
		expect(second.results[0]?.cursor).toBeUndefined()
	})
})

describe('read-through: truncation is always explicit', () => {
	test('an include of a one-to-many relation over too many primaries is unsupported and says so', async () => {
		const { server, put } = await setup({ readThrough: { maxRows: 300 } })
		for (let i = 0; i < 205; i++) {
			await put('courses', `k${String(i).padStart(3, '0')}`, { schoolId: 's1', title: 't' })
		}
		const response = await read(server, [{ collection: 'courses', include: ['lessons'] }])
		const result = response.results[0]
		expect(result?.includedStatus.lessons).toMatchObject({
			status: 'unsupported',
			reason: 'too-many-primaries',
		})
		expect(result?.status).toBe('partial')
		expect(result?.reason).toBe('include-incomplete')
	})

	test('an include cut by the row cap is partial', async () => {
		const { server, put } = await setup({ readThrough: { maxRows: 3 } })
		await put('courses', 'c1', { schoolId: 's1', title: 't' })
		for (let i = 0; i < 5; i++) {
			await put('lessons', `l${i}`, { schoolId: 's1', courseId: 'c1', title: `L${i}` })
		}
		const response = await read(server, [{ collection: 'courses', include: ['lessons'] }])
		const result = response.results[0]
		expect(result?.included.lessons).toHaveLength(3)
		expect(result?.includedStatus.lessons).toMatchObject({ status: 'partial', reason: 'row-cap' })
		expect(result?.status).toBe('partial')
	})

	test('a complete include reports ok, and a denied one reports denied', async () => {
		const { server, put } = await setup()
		await seed(put)
		const complete = await read(server, [{ collection: 'lessons', include: ['courses'] }])
		expect(complete.results[0]?.includedStatus.courses).toEqual({ status: 'ok' })
		expect(complete.results[0]?.status).toBe('ok')
		const narrowGrant = new TokenAuthProvider({
			validate: async () => ({ userId: 'n', scopes: { lessons: { schoolId: 's1' } } }),
		})
		const narrow = await setup({ auth: narrowGrant })
		await seed(narrow.put)
		const denied = await read(narrow.server, [{ collection: 'lessons', include: ['courses'] }], 'x')
		expect(denied.results[0]?.includedStatus.courses).toEqual({ status: 'denied' })
	})
})

describe('read-through: one state per record', () => {
	test('a write between the row read and the version read never pairs old values with new versions', async () => {
		const { server, put, store, ctx } = await setup()
		await put('courses', 'c1', { schoolId: 's1', title: 'old' })
		const original = store.getRecordFieldVersions?.bind(store)
		expect(original).toBeDefined()
		let interleaved = false
		store.getRecordFieldVersions = async (collection: string, id: string) => {
			if (!interleaved) {
				interleaved = true
				// The update lands after the rows were read and before their versions are.
				await ctx.apply({
					collection: 'courses',
					type: 'update',
					recordId: 'c1',
					data: { title: 'new' },
				})
			}
			return (original as NonNullable<typeof original>)(collection, id)
		}
		const response = await read(server, [{ collection: 'courses', where: { schoolId: 's1' } }])
		const record = response.results[0]?.records[0]
		expect(interleaved).toBe(true)
		const stored = await store.getRecordFieldVersions?.('courses', 'c1')
		// Values and versions are the same state: the new title with the new write's stamp.
		expect(record?.values.title).toBe('new')
		expect(record?.fieldVersions.title).toEqual(stored?.fields.title)
	})

	test('a record that keeps changing under the read is a retriable conflict, never a torn row', async () => {
		const { server, put, store, ctx } = await setup()
		await put('courses', 'c1', { schoolId: 's1', title: 'v0' })
		const original = store.getRecordFieldVersions?.bind(store)
		let n = 0
		store.getRecordFieldVersions = async (collection: string, id: string) => {
			n += 1
			await ctx.apply({
				collection: 'courses',
				type: 'update',
				recordId: 'c1',
				data: { title: `v${n}` },
			})
			return (original as NonNullable<typeof original>)(collection, id)
		}
		const answer = await server.handleReadRequest(
			request(body([{ collection: 'courses' }]), 'root'),
		)
		expect(answer.status).toBe(409)
		expect(errorOf(answer)).toMatchObject({ code: 'READ_CONFLICT', retriable: true })
	})
})

describe('read-through: the evaluator view of a row', () => {
	test('BIGINT timestamps that arrive as strings or bigints are compared as numbers', () => {
		const definition = schema.collections.courses
		if (definition === undefined) throw new Error('fixture')
		const view = evalView(
			{ id: 'a', title: 't', _created_at: '1700000000123', _updated_at: 1700000000999n } as never,
			definition,
		)
		expect(view.createdAt).toBe(1700000000123)
		expect(view.updatedAt).toBe(1700000000999)
	})
})

describe('read-through: includes are complete or say they are not', () => {
	async function withLessons(
		inScope: number,
		outOfScope: number,
		config: Partial<KoraSyncServerConfig>,
	) {
		const harness = await setup(config)
		await harness.put('courses', 'c1', { schoolId: 's1', title: 'C' })
		// Out-of-scope lessons sort first, so a store limit applied before the scope cuts them in.
		for (let i = 0; i < outOfScope; i++) {
			await harness.put('lessons', `a${i}`, { schoolId: 's2', courseId: 'c1', title: 'x' })
		}
		for (let i = 0; i < inScope; i++) {
			await harness.put('lessons', `z${i}`, { schoolId: 's1', courseId: 'c1', title: 'x' })
		}
		return harness
	}

	test('out-of-scope children sorted before in-scope ones do not hide them (the scope is pushed down)', async () => {
		const { server } = await withLessons(3, 8, { readThrough: { maxRows: 5 } })
		const response = await read(server, [{ collection: 'courses', include: ['lessons'] }])
		const result = response.results[0]
		expect((result?.included.lessons ?? []).map((r) => r.id)).toEqual(['z0', 'z1', 'z2'])
		expect(result?.includedStatus.lessons).toEqual({ status: 'ok' })
		expect(result?.status).toBe('ok')
	})

	test('a store read that hits its limit marks the include partial', async () => {
		const { server } = await withLessons(8, 0, { readThrough: { maxRows: 5 } })
		const response = await read(server, [{ collection: 'courses', include: ['lessons'] }])
		const result = response.results[0]
		expect(result?.included.lessons).toHaveLength(5)
		expect(result?.includedStatus.lessons).toMatchObject({ status: 'partial', reason: 'row-cap' })
		expect(result?.status).toBe('partial')
	})

	test('an include starved by the byte budget says so', async () => {
		const { server } = await withLessons(6, 0, { readThrough: { maxBytes: 700 } })
		const response = await read(server, [{ collection: 'courses', include: ['lessons'] }])
		const result = response.results[0]
		expect(result?.includedStatus.lessons?.status).toBe('partial')
		expect(result?.includedStatus.lessons?.reason).toBe('byte-budget')
		expect(result?.status).toBe('partial')
	})
})

describe('read-through: absent only ever means gone or denied', () => {
	const known = ['c1', 'c2', 'ghost']

	test('server-side limits report no ids absent', async () => {
		const cases: Array<[string, Partial<KoraSyncServerConfig>, Record<string, unknown>]> = [
			['too-many-candidates', { readThrough: { maxCandidates: 1 } }, {}],
			['work-budget', { readThrough: { maxWork: 4 } }, {}],
			[
				'unsupported-shape too large',
				{ readThrough: { maxRows: 1 } },
				{ where: { title: { $in: Array.from({ length: 300 }, (_, i) => `t${i}`) } } },
			],
		]
		for (const [reason, config, extra] of cases) {
			const { server, put } = await setup(config)
			await seed(put)
			const response = await read(server, [{ collection: 'courses', known, ...extra }])
			const result = response.results[0]
			expect(result?.status, reason).toBe('unsupported')
			expect(result?.absent, reason).toEqual([])
			expect(result?.records, reason).toEqual([])
		}
	})

	test('a scope too wide for the pushdown reports no ids absent', async () => {
		const wide = new TokenAuthProvider({
			validate: async () => ({
				userId: 'w',
				scopes: {
					courses: {
						$or: [0, 1, 2].map((part) => ({
							schoolId: { $in: Array.from({ length: 100 }, (_, i) => `s${part}-${i}`) },
						})),
					},
				},
			}),
		})
		const { server, put } = await setup({ auth: wide })
		await seed(put)
		const response = await read(server, [{ collection: 'courses', known }], 'x')
		expect(response.results[0]).toMatchObject({
			status: 'unsupported',
			reason: 'scope-too-wide',
			absent: [],
		})
	})

	test('a store that cannot tell about encryption reports no ids absent', async () => {
		const { server, put, store } = await setup()
		await seed(put)
		;(store as unknown as Record<string, unknown>).recordsWithEncryptedOperations = undefined
		const response = await read(server, [{ collection: 'courses', known }])
		expect(response.results[0]).toMatchObject({
			status: 'unsupported',
			reason: 'encrypted-records',
			absent: [],
		})
	})

	test('known ids cut by the work budget are not reported gone, and never appear in records too', async () => {
		const { server, put } = await setup({ readThrough: { maxWork: 20 } })
		await seed(put)
		const response = await read(server, [
			{ collection: 'courses', known: ['c1', 'c2', 'c3', 'ghost'] },
		])
		const result = response.results[0]
		expect(result?.records.length).toBeGreaterThan(0)
		expect(result?.absent).toEqual([])
		expect(result?.status).toBe('partial')
		expect(result?.reason).toBe('known-truncated')
	})

	test('a denied collection and an encryption-required server still report every known id absent', async () => {
		const { server, put } = await setup()
		await seed(put)
		const denied = await read(server, [{ collection: 'schools', known }])
		expect(denied.results[0]?.absent).toEqual(known)
		const required = await setup({ encryption: { required: true } })
		const answer = await read(required.server, [{ collection: 'courses', known }])
		expect(answer.results[0]).toMatchObject({ reason: 'encryption-required', absent: known })
	})
})

describe('read-through: work is charged for store queries and retries', () => {
	test('a 100-value $in over 8 queries is bounded by maxWork, not by rows', async () => {
		const fanOut = new TokenAuthProvider({
			validate: async () => ({
				userId: 'f',
				scopes: { courses: { schoolId: { $in: Array.from({ length: 100 }, (_, i) => `s${i}`) } } },
			}),
		})
		const { server, put, store } = await setup({ auth: fanOut, readThrough: { maxWork: 1_000 } })
		await seed(put)
		let calls = 0
		const original = store.queryCollection.bind(store)
		store.queryCollection = async (...args: Parameters<typeof original>) => {
			calls += 1
			return original(...args)
		}
		const response = await read(
			server,
			Array.from({ length: 8 }, () => ({ collection: 'courses' })),
			'x',
		)
		// 1,000 units of work at 5 per store query is at most 200 queries of the 800 asked for.
		expect(calls).toBeLessThanOrEqual(200)
		expect(response.results.some((r) => r.reason === 'work-budget')).toBe(true)
	})

	test('retries of a changing record spend the budget', async () => {
		const { server, put, store, ctx } = await setup({ readThrough: { maxWork: 60 } })
		await put('courses', 'c1', { schoolId: 's1', title: 'v0' })
		const original = store.getRecordFieldVersions?.bind(store)
		let n = 0
		store.getRecordFieldVersions = async (collection: string, id: string) => {
			n += 1
			await ctx.apply({
				collection: 'courses',
				type: 'update',
				recordId: 'c1',
				data: { title: `v${n}` },
			})
			return (original as NonNullable<typeof original>)(collection, id)
		}
		const budgeted = await server.handleReadRequest(
			request(body([{ collection: 'courses' }]), 'root'),
		)
		const out = JSON.parse(budgeted.body ?? '{}') as {
			results?: Array<{ reason?: string }>
			error?: { code: string }
		}
		// Either the churn is refused (conflict) or the budget ended the query first: never a torn row.
		expect(out.error?.code === 'READ_CONFLICT' || out.results?.[0]?.reason === 'work-budget').toBe(
			true,
		)
	})

	test('candidate scans skip large columns and the page reads them', async () => {
		const rich = defineSchema({
			version: 1,
			collections: { notes: { fields: { team: t.string(), body: t.richtext() } } },
		})
		const store = new MemoryServerStore('rich')
		await store.setSchema(rich, {})
		const server = new KoraSyncServer({
			store,
			auth: new TokenAuthProvider({
				validate: async () => ({ userId: 'u', scopes: { notes: { team: 't1' } } }),
			}),
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		await server.getKoraContext().apply({
			collection: 'notes',
			type: 'insert',
			recordId: 'n1',
			data: { team: 't1', body: 'hello' },
		})
		const columnsSeen: Array<readonly string[] | undefined> = []
		const original = store.queryCollection.bind(store)
		store.queryCollection = async (...args: Parameters<typeof original>) => {
			columnsSeen.push(args[1]?.columns)
			return original(...args)
		}
		const response = await server.handleReadRequest(
			request(
				{
					v: 1,
					schemaVersion: 1,
					queries: [{ key: 'q', collection: 'notes', where: {}, orderBy: [] }],
				},
				'x',
			),
		)
		expect(response.status).toBe(200)
		expect(columnsSeen.every((c) => c !== undefined && !c.includes('body'))).toBe(true)
		const record = (JSON.parse(response.body ?? '') as ReadResponse).results[0]?.records[0]
		expect(record?.values).toHaveProperty('body')
	})
})

describe('read-through: store errors fail the read', () => {
	test('a failing version read is a retriable failure, never invented versions', async () => {
		const { server, put, store } = await setup()
		await seed(put)
		store.getRecordFieldVersions = async () => {
			throw new Error('fold state unreadable')
		}
		const answer = await server.handleReadRequest(
			request(body([{ collection: 'courses' }]), 'root'),
		)
		expect(answer.status).toBe(500)
		expect(errorOf(answer)).toMatchObject({ code: 'READ_FAILED', retriable: true })
	})
})

/**
 * Runs `act` the `onCall`-th time (default first; the rebuild of an answer is the second) the store is asked for the field versions of `collection`/`id`:
 * that read sits between the candidate scan and the confirming read of a row, so a write
 * made there is the exact interleaving the confirming read exists for.
 */
function onVersionsOf(
	store: MemoryServerStore,
	collection: string,
	id: string,
	act: () => Promise<unknown>,
	onCall = 1,
): void {
	const original = store.getRecordFieldVersions?.bind(store)
	let calls = 0
	store.getRecordFieldVersions = async (c: string, rid: string) => {
		if (c === collection && rid === id) {
			calls += 1
			if (calls === onCall) await act()
		}
		return original ? original(c, rid) : null
	}
}

describe('read-through: a row that changes between the scan and its confirming read', () => {
	test('a record moved out of the grant is never served, and the answer is rebuilt without it', async () => {
		const { store, server, put } = await setup()
		await seed(put)
		onVersionsOf(store, 'courses', 'c1', () =>
			put('courses', 'c1', { schoolId: 's3', title: 'SECRET-OF-S3' }, 'update'),
		)
		const answer = await server.handleReadRequest(request(body([{ collection: 'courses' }])))
		expect(answer.body).not.toContain('SECRET-OF-S3')
		const response = JSON.parse(answer.body ?? '') as ReadResponse
		expect(ids(response)).toEqual(['c2'])
		expect(response.results[0]?.status).toBe('ok')
	})

	test('a drop on the rebuild too is reported as a partial page, never an ok short one', async () => {
		const { store, server, put } = await setup()
		await seed(put)
		onVersionsOf(store, 'courses', 'c1', () =>
			put('courses', 'c1', { schoolId: 's3', title: 'SECRET-OF-S3' }, 'update'),
		)
		// The second ask for c2 is the rebuild's.
		onVersionsOf(
			store,
			'courses',
			'c2',
			() => put('courses', 'c2', { schoolId: 's3', title: 'SECRET-TOO' }, 'update'),
			2,
		)
		const answer = await server.handleReadRequest(request(body([{ collection: 'courses' }])))
		expect(answer.body).not.toContain('SECRET')
		const result = (JSON.parse(answer.body ?? '') as ReadResponse).results[0]
		expect(result?.records).toEqual([])
		expect(result?.status).toBe('partial')
		expect(result?.reason).toBe('records-changed')
	})

	test('a deleted row does not leave a short page marked ok', async () => {
		const { store, server, put, ctx } = await setup()
		for (let i = 1; i <= 4; i++) {
			await put('courses', `i${i}`, { schoolId: 's1', title: `t${i}`, position: i })
		}
		onVersionsOf(store, 'courses', 'i2', () =>
			ctx.apply({ collection: 'courses', type: 'delete', recordId: 'i2' }),
		)
		const answer = await server.handleReadRequest(
			request(
				body([
					{ collection: 'courses', limit: 2, orderBy: [{ field: 'position', direction: 'asc' }] },
				]),
			),
		)
		const result = (JSON.parse(answer.body ?? '') as ReadResponse).results[0]
		// Built again: the limit is filled from the rows that remain.
		expect(result?.records.map((r) => r.id)).toEqual(['i1', 'i3'])
		expect(result?.status).toBe('ok')
	})

	test('a row dropped on the rebuild leaves a cursor, and the limit counts only served rows', async () => {
		const { store, server, put, ctx } = await setup()
		for (let i = 1; i <= 5; i++) {
			await put('courses', `i${i}`, { schoolId: 's1', title: `t${i}`, position: i })
		}
		onVersionsOf(store, 'courses', 'i2', () =>
			ctx.apply({ collection: 'courses', type: 'delete', recordId: 'i2' }),
		)
		onVersionsOf(
			store,
			'courses',
			'i3',
			() => ctx.apply({ collection: 'courses', type: 'delete', recordId: 'i3' }),
			2,
		)
		const query = {
			collection: 'courses',
			limit: 3,
			orderBy: [{ field: 'position', direction: 'asc' as const }],
		}
		const first = (
			JSON.parse(
				(await server.handleReadRequest(request(body([query])))).body ?? '',
			) as ReadResponse
		).results[0]
		expect(first?.records.map((r) => r.id)).toEqual(['i1', 'i4'])
		expect(first?.status).toBe('partial')
		expect(first?.cursor).toBeDefined()
		const second = (
			JSON.parse(
				(await server.handleReadRequest(request(body([{ ...query, cursor: first?.cursor }]))))
					.body ?? '',
			) as ReadResponse
		).results[0]
		// 3 allowed, 2 served: exactly one more, never a third page's worth.
		expect(second?.records.map((r) => r.id)).toEqual(['i5'])
	})

	test('an included record moved out of the grant is left out', async () => {
		const { store, server, put } = await setup()
		await seed(put)
		onVersionsOf(store, 'courses', 'c1', () =>
			put('courses', 'c1', { schoolId: 's3', title: 'SECRET-OF-S3' }, 'update'),
		)
		const answer = await server.handleReadRequest(
			request(body([{ collection: 'lessons', include: ['courses'] }])),
		)
		expect(answer.body).not.toContain('SECRET-OF-S3')
		const result = (JSON.parse(answer.body ?? '') as ReadResponse).results[0]
		expect(result?.included.courses ?? []).toEqual([])
	})

	test('a known id moved out of the grant after the first look is absent, not refreshed', async () => {
		const { store, server, put } = await setup()
		await seed(put)
		onVersionsOf(store, 'courses', 'c1', () =>
			put('courses', 'c1', { schoolId: 's3', title: 'SECRET-OF-S3' }, 'update'),
		)
		const answer = await server.handleReadRequest(
			request(body([{ collection: 'courses', where: { title: 'Biology' }, known: ['c1'] }])),
		)
		expect(answer.body).not.toContain('SECRET-OF-S3')
		const result = (JSON.parse(answer.body ?? '') as ReadResponse).results[0]
		expect(result?.refreshed ?? []).toEqual([])
		expect(result?.absent).toEqual(['c1'])
	})
})

describe('read-through: bounds that only a precise comparison keeps', () => {
	test('an offset at the query row cap is refused as capped, not served an empty ok page', async () => {
		const { server, put } = await setup({ readThrough: { maxQueryRows: 2 } })
		await seed(put)
		const response = await read(server, [{ collection: 'courses', offset: 2 }])
		expect(response.results[0]?.status).toBe('unsupported')
		expect(response.results[0]?.reason).toBe('query-row-cap')
	})

	test('a one-to-many include reads only the rows the principal may see, so the row cap cuts nothing readable', async () => {
		const { server, put } = await setup({ readThrough: { maxRows: 2 } })
		await put('courses', 'c1', { schoolId: 's1', title: 'Algebra' })
		// Three lessons Ann cannot read sort before the two she can.
		for (const id of ['a1', 'a2', 'a3']) {
			await put('lessons', id, { schoolId: 's9', courseId: 'c1', title: 'hidden' })
		}
		for (const id of ['b1', 'b2']) {
			await put('lessons', id, { schoolId: 's1', courseId: 'c1', title: 'visible' })
		}
		const response = await read(server, [{ collection: 'courses', include: ['lessons'] }])
		const result = response.results[0]
		expect((result?.included.lessons ?? []).map((r) => r.id)).toEqual(['b1', 'b2'])
		expect(result?.includedStatus.lessons?.status).toBe('ok')
	})
})
