import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import { GatedAdapter, quiesce, useSynchronousDigest } from './test-support'

useSynchronousDigest()

/*
 * I2: with instant updates on, the operation log is byte-for-byte the log written with it
 * off. Record ids come from a deterministic generator and the clock is a fixed instant
 * (Date only; no timers are faked), so ids, hashes, sequence numbers, timestamps and causal
 * dependencies must be equal, including when the commits of the "on" run are held back and
 * released later by the test.
 */

let nextId = 0
vi.mock('@korajs/core', async (importOriginal) => {
	const original = await importOriginal<typeof import('@korajs/core')>()
	return {
		...original,
		generateUUIDv7: (): string => {
			nextId++
			return `01900000-0000-7000-8000-${String(nextId).padStart(12, '0')}`
		},
	}
})

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				done: t.boolean().default(false),
				n: t.number().default(0),
				tags: t.array(t.string()).default([]),
			},
		},
	},
})

interface RunOptions {
	instant: boolean
	/** Hold every commit until the whole workload has been issued. */
	gated: boolean
}

/** The same workload every time: chains without awaits, a bulk insert, a delete. */
async function runWorkload(options: RunOptions): Promise<Operation[]> {
	nextId = 0
	const adapter = options.gated
		? new GatedAdapter(':memory:')
		: new BetterSqlite3Adapter(':memory:')
	const emitter = new SimpleEventEmitter()
	const created: Operation[] = []
	emitter.on('operation:created', (event) => created.push(event.operation))
	let groupsPredicted = 0
	emitter.on('store:write-pending', (event) => {
		if (event.kind === 'transaction' && event.predicted) groupsPredicted++
	})
	const store = new Store({
		schema,
		adapter,
		nodeId: 'identity-node',
		emitter,
		...(options.instant ? { instantUpdates: true } : {}),
	})
	await store.open()
	created.length = 0
	// A live query, so the "on" run actually patches something.
	store
		.collection('todos')
		.where({ done: false })
		.orderBy('n', 'asc')
		.subscribe(() => {})
	await quiesce()

	if (options.gated && adapter instanceof GatedAdapter) adapter.gating = true
	const todos = store.collection('todos')
	const writes: Array<Promise<unknown>> = []
	const first = todos.insert({ title: 'a', n: 3 })
	writes.push(first)
	const second = todos.insert({ title: 'b', n: 1, tags: ['x', 'y'] })
	writes.push(second)
	writes.push(todos.insertMany([{ title: 'c' }, { title: 'd', n: 9 }]))
	// Updates of records whose inserts have not committed yet (the dependency chain).
	const firstRecord = await Promise.race([first, Promise.resolve(null)])
	void firstRecord
	if (options.gated && adapter instanceof GatedAdapter) {
		// Let each gated commit land one by one, in the order issued.
		for (let i = 0; i < 3; i++) {
			for (let turn = 0; turn < 50 && adapter.gates.length === 0; turn++) await quiesce()
			adapter.gates.shift()?.release()
		}
		adapter.gating = false
	}
	const [a, b] = (await Promise.all([first, second])) as Array<{ id: string }>
	await Promise.all(writes)
	if (options.gated && adapter instanceof GatedAdapter) adapter.gating = true
	const chain = [
		todos.update(a?.id ?? '', { n: 4 }),
		todos.update(a?.id ?? '', { title: 'a2', done: true }),
		todos.update(b?.id ?? '', { tags: ['z'] }),
		todos.update(a?.id ?? '', { done: false }),
		todos.delete(b?.id ?? ''),
	]
	if (options.gated && adapter instanceof GatedAdapter) {
		for (let i = 0; i < chain.length; i++) {
			for (let turn = 0; turn < 50 && adapter.gates.length === 0; turn++) await quiesce()
			adapter.gates.shift()?.release()
		}
		adapter.gating = false
	}
	await Promise.all(chain)
	await quiesce()
	// S6a: transactions (what app.transaction / app.mutation run), predicted as entry groups
	// with the flag on: a named mutation that inserts, updates its own insert and updates an
	// existing record, then a bulk insert inside a transaction.
	if (options.gated && adapter instanceof GatedAdapter) adapter.gating = true
	const transactions = [
		store.transaction(async (tx) => {
			tx.setMutationName('complete-task')
			const col = tx.collection('todos')
			const e = await col.insert({ title: 'e', n: 2 })
			await col.update(e.id, { done: true })
			await col.update(a?.id ?? '', { n: 8 })
		}),
		store.transaction(async (tx) => {
			await tx.collection('todos').insertMany([{ title: 'f' }, { title: 'g', n: 5 }])
		}),
	]
	if (options.gated && adapter instanceof GatedAdapter) {
		for (let i = 0; i < transactions.length; i++) {
			for (let turn = 0; turn < 50 && adapter.gates.length === 0; turn++) await quiesce()
			adapter.gates.shift()?.release()
		}
		adapter.gating = false
	}
	await Promise.all(transactions)
	await quiesce()
	if (options.instant) {
		// The transactions really were predicted (otherwise this proves nothing for S6a).
		expect(groupsPredicted).toBe(2)
	}
	// The log as stored, not only as published.
	const stored = await adapter.query<{ id: string; sequence_number: number }>(
		'SELECT id, sequence_number FROM _kora_ops_todos ORDER BY sequence_number',
	)
	expect(stored.map((row) => row.id)).toEqual(created.map((operation) => operation.id))
	await store.close()
	return created
}

describe('I2: instant updates do not change the operation log', () => {
	const RealDate = Date

	beforeEach(() => {
		// Only Date: the HLC reads it, and nothing in these tests waits on a timer.
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new RealDate('2026-10-30T12:00:00.000Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test('off, on, and on with every commit held back produce identical logs', async () => {
		const off = await runWorkload({ instant: false, gated: false })
		vi.setSystemTime(new RealDate('2026-10-30T12:00:00.000Z'))
		const on = await runWorkload({ instant: true, gated: false })
		vi.setSystemTime(new RealDate('2026-10-30T12:00:00.000Z'))
		const onHeld = await runWorkload({ instant: true, gated: true })

		expect(off.length).toBe(14)
		expect(on).toEqual(off)
		expect(onHeld).toEqual(off)
		// Spot-check what identity means here: the ids are content hashes and are equal too.
		expect(onHeld.map((operation) => operation.id)).toEqual(off.map((operation) => operation.id))
		expect(onHeld.map((operation) => operation.sequenceNumber)).toEqual(
			off.map((operation) => operation.sequenceNumber),
		)
		expect(onHeld.map((operation) => operation.timestamp)).toEqual(
			off.map((operation) => operation.timestamp),
		)
	})
})
