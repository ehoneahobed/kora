/**
 * Paging and column-selection contracts of the read endpoint on every server store (memory,
 * SQLite, and Postgres when KORA_PG_TEST_URL is set): the row limits hold across pages, a
 * keyset cursor walks nulls and ties exactly like one big read, and the candidate scan does
 * not load large columns the answer then still carries.
 */
import { defineSchema, t } from '@korajs/core'
import { afterAll, describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { ReadQuery, ReadResponse, ReadResult } from '../../src/read/read-types'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import type { KoraSyncServerConfig } from '../../src/types'
import { deliveryStoreKinds, removeDeliveryTempFiles } from '../fixtures/delivery-stores'
import { dropTrackedPgSchemas } from '../fixtures/pg-test-schemas'

afterAll(dropTrackedPgSchemas)
afterAll(removeDeliveryTempFiles)

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				orgId: t.string(),
				title: t.string(),
				pos: t.number().default(0),
				rank: t.number().optional(),
				notes: t.richtext(),
			},
		},
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) =>
		token === 'ann' ? { userId: 'ann', scopes: { items: { orgId: 'a' } } } : null,
})

type Query = Partial<ReadQuery>

async function send(server: KoraSyncServer, queries: Query[]): Promise<ReadResponse> {
	const answer = await server.handleReadRequest({
		method: 'POST',
		authorization: 'Bearer ann',
		contentType: 'application/json',
		body: JSON.stringify({
			v: 1,
			schemaVersion: 1,
			queries: queries.map((q, i) => ({
				key: `q${i}`,
				collection: 'items',
				where: {},
				orderBy: [],
				...q,
			})),
		}),
	})
	expect(answer.status, answer.body).toBe(200)
	return JSON.parse(answer.body ?? '') as ReadResponse
}

/** Follows cursors to the end; returns the ids in order and the last result. */
async function walk(
	server: KoraSyncServer,
	query: Query,
): Promise<{ ids: string[]; last: ReadResult }> {
	const ids: string[] = []
	let cursor: string | undefined
	for (let i = 0; i < 50; i++) {
		const result = (await send(server, [{ ...query, ...(cursor ? { cursor } : {}) }])).results[0]
		if (result === undefined) throw new Error('no result')
		ids.push(...result.records.map((r) => r.id))
		cursor = result.cursor
		if (cursor === undefined) return { ids, last: result }
	}
	throw new Error('paging did not end')
}

for (const kind of deliveryStoreKinds()) {
	describe(`read-through paging on ${kind.name}`, () => {
		async function setup(readThrough: KoraSyncServerConfig['readThrough'] = {}, rows = 10) {
			const handle = await kind.make()
			await handle.store.setSchema(schema, {})
			const server = new KoraSyncServer({
				store: handle.store,
				auth,
				relayRetransmitIntervalMs: 0,
				deliveryPollIntervalMs: 0,
				readThrough,
			})
			const ctx = server.getKoraContext()
			const ranks: Array<number | null> = [1, null, 1, 2, null, 2, 3, 1, null, 0]
			for (let i = 0; i < rows; i++) {
				const rank = ranks[i % ranks.length] ?? null
				await ctx.apply({
					collection: 'items',
					type: 'insert',
					recordId: `i${String(i + 1).padStart(2, '0')}`,
					data: {
						orgId: 'a',
						title: `t${i + 1}`,
						pos: i + 1,
						...(rank === null ? {} : { rank }),
						notes: 'hello',
					},
				})
			}
			return { handle, server }
		}

		test('a query limit larger than the page cap pages to exactly the limit', async () => {
			const { handle, server } = await setup({ maxRows: 2, maxQueryRows: 100 })
			try {
				const { ids, last } = await walk(server, {
					limit: 5,
					orderBy: [{ field: 'pos', direction: 'asc' }],
				})
				expect(ids).toEqual(['i01', 'i02', 'i03', 'i04', 'i05'])
				expect(last.status).toBe('ok')
			} finally {
				await handle.done()
			}
		})

		test('maxQueryRows ends a paged chain at exactly that many rows, flagged', async () => {
			const { handle, server } = await setup({ maxRows: 2, maxQueryRows: 4 })
			try {
				const { ids, last } = await walk(server, { orderBy: [{ field: 'pos', direction: 'asc' }] })
				expect(ids).toEqual(['i01', 'i02', 'i03', 'i04'])
				expect(last.status).toBe('partial')
				expect(last.reason).toBe('query-row-cap')
			} finally {
				await handle.done()
			}
		})

		for (const direction of ['asc', 'desc'] as const) {
			test(`a keyset cursor walks nulls and ties like one read (${direction})`, async () => {
				const small = await setup({ maxRows: 2 })
				const big = await setup({ maxRows: 100 })
				try {
					const query = { orderBy: [{ field: 'rank', direction }] }
					const whole = (await send(big.server, [query])).results[0]?.records.map((r) => r.id)
					expect(whole).toHaveLength(10)
					expect((await walk(small.server, query)).ids).toEqual(whole)
				} finally {
					await small.handle.done()
					await big.handle.done()
				}
			})
		}

		test('the candidate scan skips large columns and the answer still carries them', async () => {
			const { handle, server } = await setup()
			try {
				const store = handle.store
				const original = store.queryCollection.bind(store)
				const scans: Array<Record<string, unknown>[]> = []
				store.queryCollection = async (collection, options) => {
					const rows = await original(collection, options)
					scans.push(rows)
					return rows
				}
				const result = (await send(server, [{}])).results[0]
				// Every row loaded by the scan lacks the large column...
				expect(scans.length).toBeGreaterThan(0)
				for (const rows of scans) {
					for (const row of rows) expect('notes' in row).toBe(false)
				}
				// ...and the page is not a churn failure for it: it was read in the confirming pass.
				expect(result?.status).toBe('ok')
				expect(result?.records).toHaveLength(10)
				expect(result?.records[0]?.values.notes).toBeDefined()
			} finally {
				await handle.done()
			}
		})

		test('a collection with large columns costs one version read per record, not a retry', async () => {
			const { handle } = await setup({}, 6)
			try {
				const store = handle.store
				const original = store.getRecordFieldVersions?.bind(store)
				let calls = 0
				store.getRecordFieldVersions = async (collection, id) => {
					calls += 1
					return original ? original(collection, id) : null
				}
				const server = new KoraSyncServer({
					store,
					auth,
					relayRetransmitIntervalMs: 0,
					deliveryPollIntervalMs: 0,
				})
				expect((await send(server, [{}])).results[0]?.records).toHaveLength(6)
				// The scan skipped the richtext column; comparing it as "changed" would read again.
				expect(calls).toBe(6)
			} finally {
				await handle.done()
			}
		})

		test('the store honours a column list on every kind', async () => {
			const { handle } = await setup({}, 2)
			try {
				const light = await handle.store.queryCollection('items', {
					where: { orgId: 'a' },
					orderBy: 'id',
					columns: ['orgId', 'title', 'pos'],
				})
				expect(light).toHaveLength(2)
				for (const row of light) {
					expect('notes' in row).toBe(false)
					expect(row.title).toBeDefined()
				}
				const full = await handle.store.queryCollection('items', {
					where: { orgId: 'a' },
					orderBy: 'id',
				})
				expect('notes' in (full[0] ?? {})).toBe(true)
			} finally {
				await handle.done()
			}
		})

		test('a cursor survives a later query that gets no rows from the byte budget', async () => {
			const { handle, server } = await setup({ maxRows: 2, maxBytes: 1 })
			try {
				const query = { orderBy: [{ field: 'pos', direction: 'asc' as const }] }
				const first = (await send(server, [query])).results[0]
				expect(first?.records.map((r) => r.id)).toEqual(['i01'])
				const resumed = first?.cursor
				expect(resumed).toBeDefined()
				// Two queries in one request: the first spends the whole byte budget, so the
				// second (carrying the cursor) is served nothing and must hand the cursor on intact.
				const both = await send(server, [query, { ...query, cursor: resumed }])
				const starved = both.results[1]
				expect(starved?.records).toEqual([])
				expect(starved?.reason).toBe('byte-budget')
				const next = (await send(server, [{ ...query, cursor: starved?.cursor }])).results[0]
				expect(next?.records.map((r) => r.id)).toEqual(['i02'])
			} finally {
				await handle.done()
			}
		})
	})
}
