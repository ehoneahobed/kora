import type { HLCTimestamp } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import type { SeedInput } from './seed-store'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: { title: t.string(), done: t.boolean().default(false), tags: t.array(t.string()) },
		},
	},
})

const stamp = (wallTime: number): HLCTimestamp => ({ wallTime, logical: 0, nodeId: 'server' })

function seed(id: string, values: Record<string, unknown>, at = 1_000): SeedInput {
	return {
		collection: 'todos',
		id,
		values: { title: 'a', done: false, tags: [], ...values },
		fieldVersions: { title: stamp(at), done: stamp(at), tags: stamp(at) },
		created: stamp(at),
		latest: stamp(at),
	}
}

const open: Store[] = []
let adapter: BetterSqlite3Adapter
const operationCount = async (): Promise<number> =>
	(await adapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM _kora_ops_todos'))[0]?.n ?? 0
afterEach(async () => {
	for (const store of open.splice(0)) await store.close()
})

async function newStore(): Promise<Store> {
	adapter = new BetterSqlite3Adapter(':memory:')
	const store = new Store({
		schema,
		adapter,
		nodeId: 'device',
		materialization: 'fold',
	})
	await store.open()
	open.push(store)
	return store
}

const META = { frontier: 10, grantKey: 'g1' }

describe('seeding', () => {
	test('a seeded record is readable by local queries and is no operation', async () => {
		const store = await newStore()
		const outcome = await store.seedRecords([seed('r1', { title: 'hello' })], META)
		expect(outcome.seeded).toEqual([{ collection: 'todos', id: 'r1' }])
		const rows = await store.collection('todos').where({}).exec()
		expect(rows).toMatchObject([{ id: 'r1', title: 'hello', done: false, tags: [] }])
		expect(await operationCount()).toBe(0)
		expect(await store.listSeeds()).toEqual([
			{ collection: 'todos', recordId: 'r1', frontier: 10, grantKey: 'g1' },
		])
	})

	test('a query over seeds notifies its subscribers', async () => {
		const store = await newStore()
		const seen: number[] = []
		const stop = store
			.collection('todos')
			.where({})
			.subscribe((rows) => seen.push(rows.length))
		await store.seedRecords([seed('r1', {})], META)
		await new Promise((resolve) => setTimeout(resolve, 20))
		stop()
		expect(seen.at(-1)).toBe(1)
	})

	test('skips are reported, never silent', async () => {
		const store = await newStore()
		const outcome = await store.seedRecords(
			[
				seed('dup', { tags: ['x', 'x'] }),
				{ ...seed('bad', {}), collection: 'nope' },
				seed('ok', {}),
			],
			META,
		)
		expect(outcome.seeded).toEqual([{ collection: 'todos', id: 'ok' }])
		expect(outcome.skipped).toEqual([
			{ collection: 'todos', id: 'dup', reason: 'array-duplicates' },
			{ collection: 'nope', id: 'bad', reason: 'unknown-collection' },
		])
	})

	test('a record with history here is not touched', async () => {
		const store = await newStore()
		const local = await store.collection('todos').insert({ title: 'mine', tags: [] })
		const outcome = await store.seedRecords([seed(local.id, { title: 'server' })], META)
		expect(outcome.skipped).toEqual([{ collection: 'todos', id: local.id, reason: 'has-history' }])
		expect((await store.collection('todos').findById(local.id))?.title).toBe('mine')
	})

	test('only a newer answer replaces a seed, and it replaces the values', async () => {
		const store = await newStore()
		await store.seedRecords([seed('r1', { title: 'v1' })], META)
		const same = await store.seedRecords([seed('r1', { title: 'stale' }, 2_000)], META)
		expect(same.skipped).toEqual([{ collection: 'todos', id: 'r1', reason: 'not-newer' }])
		const newer = await store.seedRecords([seed('r1', { title: 'v2' }, 2_000)], {
			frontier: 11,
			grantKey: 'g1',
		})
		expect(newer.seeded).toHaveLength(1)
		expect((await store.collection('todos').findById('r1'))?.title).toBe('v2')
	})

	test('a local write folds on top of the seed and survives the purge', async () => {
		const store = await newStore()
		await store.seedRecords([seed('r1', { title: 'server' }), seed('r2', {})], META)
		await store.collection('todos').update('r1', { done: true })
		expect((await store.collection('todos').findById('r1'))?.done).toBe(true)
		expect(await operationCount()).toBe(1)

		const purged = await store.purgeSeeds()
		expect(purged.removed.map((p) => p.recordId)).toEqual(['r2'])
		expect(purged.retained.map((p) => p.recordId)).toEqual(['r1'])
		expect(await store.listSeeds()).toEqual([])
		// r2 had no local write: it is gone as if never read. r1 keeps what the user did.
		expect(await store.collection('todos').findById('r2')).toBeNull()
		const r1 = await store.collection('todos').findById('r1')
		expect(r1).toMatchObject({ id: 'r1', done: true, title: 'server' })
	})

	test('purging named seeds leaves the others', async () => {
		const store = await newStore()
		await store.seedRecords([seed('r1', {}), seed('r2', {})], META)
		await store.purgeSeeds([{ collection: 'todos', recordId: 'r1' }])
		expect((await store.listSeeds()).map((s) => s.recordId)).toEqual(['r2'])
		expect(await store.collection('todos').findById('r1')).toBeNull()
		expect(await store.collection('todos').findById('r2')).not.toBeNull()
	})
})

describe('clear points', () => {
	test('a different user signing in cannot read what was read for the previous one', async () => {
		const store = await newStore()
		await store.bindPrincipal('alice')
		await store.seedRecords([seed('r1', {})], META)
		await store.bindPrincipal('alice')
		expect(await store.listSeeds()).toHaveLength(1)
		await store.bindPrincipal('bob')
		expect(await store.listSeeds()).toEqual([])
		expect(await store.collection('todos').findById('r1')).toBeNull()
	})

	test('sign-out clears seeds', async () => {
		const store = await newStore()
		await store.bindPrincipal('alice')
		await store.seedRecords([seed('r1', {})], META)
		store.clearSignedInUser()
		// The purge runs behind the write gate; a later gated write waits for it.
		await store.collection('todos').insert({ title: 'barrier', tags: [] })
		expect(await store.listSeeds()).toEqual([])
	})

	test('reloading from disk clears seeds', async () => {
		const store = await newStore()
		await store.seedRecords([seed('r1', {})], META)
		await store.reloadFromDisk()
		expect(await store.listSeeds()).toEqual([])
	})

	test('a grant change deletes seeds read under the old grant, except those the user wrote to', async () => {
		const store = await newStore()
		await store.seedRecords([seed('old', {}), seed('written', {})], META)
		await store.seedRecords([seed('current', {})], { frontier: 12, grantKey: 'g2' })
		await store.collection('todos').update('written', { done: true })

		const removed = await store.purgeSeedsExceptGrant('g2')

		expect(removed.map((s) => s.recordId)).toEqual(['old'])
		expect((await store.listSeeds()).map((s) => s.recordId)).toEqual(['current', 'written'])
		expect(await store.collection('todos').findById('old')).toBeNull()
		expect(await store.collection('todos').findById('written')).toMatchObject({ done: true })
	})
})
