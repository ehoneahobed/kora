/**
 * SRV-7 repro: the server never compacts its operation log, and every write rebuilds
 * the target record by re-reading and replaying the record's ENTIRE history (SQLite),
 * or by filtering the ENTIRE log (memory store). Per-write cost therefore grows with
 * history: a hot record (counter, status field) degrades linearly per write, i.e.
 * quadratically overall. Correct behavior: per-write apply cost is independent of how
 * many operations the record already has (incremental fold or snapshot + tail).
 */
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'

const schema = defineSchema({
	version: 1,
	collections: { counters: { fields: { label: t.string(), n: t.number() } } },
})

function op(i: number): Operation {
	return {
		id: `srv7-${i}`,
		nodeId: 'w',
		type: i === 0 ? 'insert' : 'update',
		collection: 'counters',
		recordId: 'hot',
		data: i === 0 ? { label: 'hot', n: 0 } : { n: i },
		previousData: i === 0 ? null : { n: i - 1 },
		timestamp: { wallTime: 1_700_000_000_000 + i, logical: 0, nodeId: 'w' },
		sequenceNumber: i + 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

async function measure(store: {
	applyRemoteOperation(op: Operation): Promise<unknown>
}): Promise<{ early: number; late: number }> {
	const N = 3000
	const W = 300
	let early = 0
	let late = 0
	for (let i = 0; i < N; i++) {
		const start = performance.now()
		await store.applyRemoteOperation(op(i))
		const dt = performance.now() - start
		if (i > 0 && i <= W) early += dt
		if (i >= N - W) late += dt
	}
	return { early, late }
}

describe('SRV-7 per-write cost grows with record history', () => {
	test('SQLite server store: late writes to a hot record cost about the same as early ones', async () => {
		const store = createSqliteServerStore({ filename: ':memory:' })
		await store.setSchema(schema)
		const { early, late } = await measure(store)
		await store.close()
		console.log(`SRV-7 sqlite: first300=${early.toFixed(1)}ms last300(after ~2700 ops)=${late.toFixed(1)}ms ratio=${(late / early).toFixed(1)}x`)
		expect(late / early).toBeLessThan(2)
	}, 120000)

	test('memory server store: late writes cost about the same as early ones', async () => {
		const store = new MemoryServerStore('m')
		await store.setSchema(schema)
		const { early, late } = await measure(store)
		await store.close()
		console.log(`SRV-7 memory: first300=${early.toFixed(1)}ms last300=${late.toFixed(1)}ms ratio=${(late / early).toFixed(1)}x`)
		expect(late / early).toBeLessThan(2)
	}, 120000)
})
