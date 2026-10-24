import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterAll, describe, expect, test } from 'vitest'
import { SqliteServerStore } from './sqlite-server-store'

const schema = defineSchema({
	version: 1,
	collections: { lessons: { fields: { title: t.string() } } },
})

const tmp = mkdtempSync(join(tmpdir(), 'kora-tomb-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
let made = 0

interface Internals {
	tombstoneStarts: {
		size: number
		resolve: (key: string, compute: () => Promise<number | null>) => unknown
	}
}

function openPair(): {
	file: string
	a: SqliteServerStore
	b: SqliteServerStore
	raw: Database.Database
} {
	made += 1
	const file = join(tmp, `t-${made}.sqlite`)
	const raw = new Database(file)
	return {
		file,
		raw,
		a: new SqliteServerStore(drizzle(raw), 's'),
		b: new SqliteServerStore(drizzle(new Database(file)), 's'),
	}
}

let seq = 0
function op(
	id: string,
	type: Operation['type'],
	wallTime: number,
	data: Record<string, unknown> | null,
): Operation {
	seq += 1
	return {
		id,
		nodeId: 'node-a',
		type,
		collection: 'lessons',
		recordId: 'r',
		data,
		previousData: null,
		timestamp: { wallTime, logical: 0, nodeId: 'node-a' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

async function seed(store: SqliteServerStore): Promise<void> {
	await store.applyRemoteOperation(op('ins', 'insert', 1000, { title: 'a' }))
	await store.applyRemoteOperation(op('del', 'delete', 2000, null))
	await store.applyRemoteOperation(op('stale', 'update', 1500, { title: 'stale' }))
}

describe('tombstone start cache in a store', () => {
	test('a lookup that runs during setSchema is not kept', async () => {
		const { a } = openPair()
		await a.setSchema(schema)
		await seed(a)
		const installing = a.setSchema(schema)
		const start = await a.getTombstoneStart('lessons', 'r', 'stale')
		expect(start).not.toBeNull()
		await installing
		expect((a as unknown as Internals).tombstoneStarts.size).toBe(0)
		await a.close()
	})

	test('a lookup that runs during a replace-mode restore is not kept', async () => {
		const { a } = openPair()
		await a.setSchema(schema)
		await seed(a)
		const backup = await a.exportBackup()
		const restoring = a.importBackup(backup, false)
		const start = await a.getTombstoneStart('lessons', 'r', 'stale')
		expect(start).not.toBeNull()
		await restoring
		expect((a as unknown as Internals).tombstoneStarts.size).toBe(0)
		await a.close()
	})

	test('another instance restoring changes the key this instance looks up under', async () => {
		const { a, b } = openPair()
		await a.setSchema(schema)
		await b.setSchema(schema)
		await seed(a)
		const keys: string[] = []
		const cache = (a as unknown as Internals).tombstoneStarts
		const resolve = cache.resolve.bind(cache)
		cache.resolve = (key, compute) => {
			keys.push(key)
			return resolve(key, compute)
		}
		await a.getTombstoneStart('lessons', 'r', 'stale')
		await b.importBackup(await a.exportBackup(), false)
		await a.getTombstoneStart('lessons', 'r', 'stale')
		expect(keys).toHaveLength(2)
		const epochs = keys.map((key) => (JSON.parse(key) as unknown[])[4])
		expect(epochs[0]).not.toEqual(epochs[1])
		await a.close()
		await b.close()
	})

	test('a record with more operations than the replay bound and no usable flags is undecided, replays in yielding pages, and is not replayed again at once', async () => {
		const { a, raw } = openPair()
		await a.setSchema(schema)
		await a.applyRemoteOperation(op('ins', 'insert', 1000, { title: 'a' }))
		for (let i = 0; i < 5_100; i++) {
			await a.applyRemoteOperation(op(`u${i}`, 'update', 1001 + i, { title: `t${i}` }))
		}
		// What an older instance leaves: snapshots without tombstone state.
		raw.prepare('UPDATE operations SET scope_snapshot = NULL').run()
		let worst = 0
		let last = performance.now()
		const timer = setInterval(() => {
			const now = performance.now()
			worst = Math.max(worst, now - last)
			last = now
		}, 1)
		const t0 = performance.now()
		const first = await a.getTombstoneStart('lessons', 'r', 'u5099')
		const firstMs = performance.now() - t0
		const t1 = performance.now()
		const second = await a.getTombstoneStart('lessons', 'r', 'u5099')
		const secondMs = performance.now() - t1
		clearInterval(timer)
		console.info(
			`undecidable replay: ${firstMs.toFixed(0)} ms in total, worst event-loop gap ${worst.toFixed(0)} ms; repeat ${secondMs.toFixed(1)} ms`,
		)
		expect(first).toBeNull()
		expect(second).toBeNull()
		// The repeat is served from the short-lived undecided entry, not a second replay.
		expect(secondMs).toBeLessThan(firstMs / 5)
		await a.close()
	}, 300_000)
})
