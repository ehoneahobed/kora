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
	return JSON.parse(answer.body ?? '') as ReadResponse
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
		const { server, put } = await setup({ auth: revocable })
		await seed(put)
		expect(
			(await server.handleReadRequest(request(body([{ collection: 'courses' }])))).status,
		).toBe(200)
		revoked = true
		expect(
			(await server.handleReadRequest(request(body([{ collection: 'courses' }])))).status,
		).toBe(401)
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

	test('a cursor belongs to its query: another query refuses it', async () => {
		const { server, put } = await setup({ readThrough: { maxRows: 1 } })
		await put('courses', 'a', { schoolId: 's1', title: 'A' })
		await put('courses', 'b', { schoolId: 's1', title: 'B' })
		const first = await read(server, [{ collection: 'courses' }])
		const cursor = first.results[0]?.cursor
		expect(cursor).toBeDefined()
		const answer = await server.handleReadRequest(
			request(body([{ collection: 'courses', where: { published: true }, cursor }])),
		)
		expect(answer.status).toBe(400)
		expect(errorOf(answer).code).toBe('INVALID_READ_REQUEST')
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
	const from = (token: string, clientKey: string) =>
		request(body([{ collection: 'courses' }]), token, { clientKey })

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

	test('garbage tokens spend the address bucket but never block a valid credential', async () => {
		const { server, put } = await setup({
			readThrough: { rate: { perSecond: 1, burst: 2, concurrent: 4 } },
		})
		await seed(put)
		const statuses: number[] = []
		for (let i = 0; i < 4; i++) {
			statuses.push((await server.handleReadRequest(from(`garbage-${i}`, 'proxy'))).status)
		}
		expect(statuses).toEqual([401, 401, 429, 429])
		expect((await server.handleReadRequest(from('ann', 'proxy'))).status).toBe(200)
	})

	test('without an auth provider a request spends one token, not two', async () => {
		const { server, put } = await setup({
			auth: undefined,
			readThrough: { rate: { perSecond: 1, burst: 2, concurrent: 4 } },
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
	async function firstPage(config: Partial<KoraSyncServerConfig> = {}, token = 'root') {
		const harness = await setup({ readThrough: { maxRows: 1, maxQueryRows: 2 }, ...config })
		for (let i = 1; i <= 6; i++) {
			await harness.put('courses', `p${i}`, { schoolId: 's1', title: `T${i}` })
		}
		const first = await read(harness.server, [{ collection: 'courses' }], token)
		return { ...harness, cursor: first.results[0]?.cursor as string }
	}

	test('a forged cursor, with its position rewritten, is refused', async () => {
		const { server, cursor } = await firstPage()
		const [payload] = cursor.split('.')
		const fields = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
			b: number
			n: number
		}
		const forged = `${Buffer.from(JSON.stringify({ ...fields, b: 0, n: 0 })).toString('base64url')}.${cursor.split('.')[1]}`
		for (const bad of [forged, `${payload ?? ''}.AAAA`, 'x', cursor.replace('.', '..')]) {
			const answer = await server.handleReadRequest(
				request(body([{ collection: 'courses', cursor: bad }]), 'root'),
			)
			expect(answer.status).toBe(400)
		}
	})

	test('a cursor does not continue for another principal', async () => {
		const { server, cursor } = await firstPage()
		const answer = await server.handleReadRequest(
			request(body([{ collection: 'courses', cursor }]), 'ann'),
		)
		expect(answer.status).toBe(400)
	})

	test('instances that share a cursorSecret accept each other cursors, others do not', async () => {
		const a = await firstPage({ readThrough: { maxRows: 1, cursorSecret: 'shared' } })
		const b = await setup({ readThrough: { maxRows: 1, cursorSecret: 'shared' } })
		const c = await setup({ readThrough: { maxRows: 1, cursorSecret: 'other' } })
		for (const other of [b, c]) {
			for (let i = 1; i <= 6; i++) {
				await other.put('courses', `p${i}`, { schoolId: 's1', title: `T${i}` })
			}
		}
		const send = (server: KoraSyncServer) =>
			server.handleReadRequest(request(body([{ collection: 'courses', cursor: a.cursor }]), 'root'))
		expect((await send(b.server)).status).toBe(200)
		expect((await send(c.server)).status).toBe(400)
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
