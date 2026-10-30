import { defineSchema, op, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Store } from '../store/store'
import type { CollectionRecord } from '../types'
import type { PendingWrites } from './pending-writes'
import { GatedAdapter, quiesce } from './test-support'

/**
 * Instant-UI S6b, deterministic scenarios on a real Store with commits held at a gate: atomic
 * operations and the counter / max / min / append-only strategies show their folded value
 * while the commit is pending, roll back with their chain, and are predicted inside a
 * transaction. The property test (overlay-atomic.test.ts) covers the combinatorics.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		stats: {
			fields: {
				label: t.string(),
				views: t.number().merge('counter').default(0),
				peak: t.number().merge('max').default(0),
				floor: t.number().merge('min').default(100),
				score: t.number().default(0),
				tags: t.array(t.string()).default([]),
				audit: t.array(t.string()).merge('append-only').default([]),
				note: t.string().merge('server-authoritative').optional(),
			},
		},
		plain: { fields: { name: t.string(), n: t.number().merge('counter').default(0) } },
	},
})

describe('atomic operations and merge strategies are predicted (S6b)', () => {
	let store: Store
	let adapter: GatedAdapter
	let registry: PendingWrites
	let seen: CollectionRecord[][]
	let diverged: number

	beforeEach(async () => {
		adapter = new GatedAdapter(':memory:')
		const emitter = new SimpleEventEmitter()
		diverged = 0
		emitter.on('store:overlay-diverged', () => {
			diverged += 1
		})
		store = new Store({
			schema,
			adapter,
			nodeId: 'atomic-node',
			emitter,
			instantUpdates: true,
			instantUpdatesInternals: { strict: true, baseReadTimeoutMs: 3_600_000 },
		})
		await store.open()
		const controller = store.getOverlayController()
		if (!controller) throw new Error('the store was built without an overlay')
		registry = controller.registry
		seen = []
		store
			.collection('stats')
			.where({})
			.orderBy('id', 'asc')
			.subscribe((rows) => seen.push([...rows]))
		await quiesce()
	})
	afterEach(async () => {
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		await quiesce()
		await store.close()
	})

	async function seedOne(): Promise<string> {
		adapter.gating = false
		const row = await store.collection('stats').insert({ label: 'a', views: 4, peak: 3, floor: 9 })
		await quiesce()
		registry.settleCollection('stats', registry.epoch)
		adapter.gating = true
		return row.id
	}
	const latest = (): CollectionRecord | undefined => seen.at(-1)?.[0]

	test('op.increment on a plain number shows the sum before the commit', async () => {
		const id = await seedOne()
		const pending = store.collection('stats').update(id, { score: op.increment(5) })
		await quiesce()
		expect(latest()?.score).toBe(5)
		expect(registry.misses.size).toBe(0)
		adapter.gates.shift()?.release()
		await pending
		await quiesce()
		expect((await store.collection('stats').findById(id))?.score).toBe(5)
		expect(diverged).toBe(0)
	})

	test('counter, max and min fields fold: two pending writes chain', async () => {
		const id = await seedOne()
		const stats = store.collection('stats')
		const first = stats.update(id, { views: op.increment(2), peak: op.max(10), floor: op.min(5) })
		const second = stats.update(id, { views: op.increment(3), peak: op.max(7), floor: op.min(8) })
		await quiesce()
		expect(latest()).toMatchObject({ views: 9, peak: 10, floor: 5 })
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		await Promise.all([first, second])
		await quiesce()
		expect(await stats.findById(id)).toMatchObject({ views: 9, peak: 10, floor: 5 })
		expect(registry.misses.size).toBe(0)
		expect(diverged).toBe(0)
	})

	test('a plain write to a counter field is predicted as the fold gives it', async () => {
		const id = await seedOne()
		const pending = store.collection('stats').update(id, { views: 20 })
		await quiesce()
		const shown = latest()?.views
		adapter.gates.shift()?.release()
		await pending
		await quiesce()
		expect((await store.collection('stats').findById(id))?.views).toBe(shown)
		expect(diverged).toBe(0)
	})

	test('arrays are multisets: append, duplicate append and remove', async () => {
		const id = await seedOne()
		const stats = store.collection('stats')
		const writes = [
			stats.update(id, { tags: op.append('x') }),
			stats.update(id, { tags: op.append('x') }),
			stats.update(id, { tags: op.append('y') }),
			stats.update(id, { tags: op.remove('x') }),
			stats.update(id, { audit: op.append('seen') }),
		]
		await quiesce()
		const shown = latest()
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		await Promise.all(writes)
		await quiesce()
		const stored = await stats.findById(id)
		expect(stored?.tags).toEqual(shown?.tags)
		expect(stored?.audit).toEqual(['seen'])
		expect(stored?.tags).toEqual(['y'])
		expect(registry.misses.size).toBe(0)
		expect(diverged).toBe(0)
	})

	test('a failed commit rolls back its atomic chain and the display returns to the base', async () => {
		const id = await seedOne()
		const stats = store.collection('stats')
		const failing = stats.update(id, { views: op.increment(100) }).catch(() => 'failed')
		const derived = stats.update(id, { views: op.increment(1) }).catch(() => 'failed')
		await quiesce()
		expect(latest()?.views).toBe(105)
		adapter.gates.shift()?.fail()
		// The failed commit's outcome lookup queues behind the second write's held commit.
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		await Promise.all([failing, derived])
		await quiesce()
		// Only the second write reached the database: the display shows exactly that.
		const stored = await stats.findById(id)
		expect(stored?.views).toBe(5)
		expect(latest()?.views).toBe(5)
		expect(registry.list()).toEqual([])
	})

	test('a transaction with atomic writes is predicted as one group', async () => {
		const id = await seedOne()
		const pending = store.transaction(async (tx) => {
			const stats = tx.collection('stats')
			await stats.update(id, { views: op.increment(1) })
			await stats.update(id, { views: op.increment(1), tags: op.append('t') })
		})
		await quiesce()
		expect(latest()).toMatchObject({ views: 6, tags: ['t'] })
		adapter.gates.shift()?.release()
		await pending
		await quiesce()
		expect(await store.collection('stats').findById(id)).toMatchObject({ views: 6, tags: ['t'] })
		expect(registry.misses.size).toBe(0)
		expect(diverged).toBe(0)
	})

	test('a field that cannot be predicted (server-authoritative) is a counted miss, not a guess', async () => {
		const id = await seedOne()
		const pending = store.collection('stats').update(id, { note: 'x' })
		await quiesce()
		expect(registry.misses.size).toBeGreaterThan(0)
		adapter.gates.shift()?.release()
		await pending
		await quiesce()
		expect(diverged).toBe(0)
	})

	test('a query ordered by a counter field is patched in place', async () => {
		adapter.gating = false
		const stats = store.collection('stats')
		const a = await stats.insert({ label: 'a', views: 1 })
		const b = await stats.insert({ label: 'b', views: 2 })
		await quiesce()
		registry.settleCollection('stats', registry.epoch)
		const ranked: string[][] = []
		stats
			.where({})
			.orderBy('views', 'desc')
			.subscribe((rows) => ranked.push(rows.map((row) => String(row.label))))
		await quiesce()
		adapter.gating = true
		const pending = stats.update(a.id, { views: op.increment(10) })
		await quiesce()
		expect(ranked.at(-1)).toEqual(['a', 'b'])
		adapter.gates.shift()?.release()
		await pending
		await quiesce()
		expect(ranked.at(-1)).toEqual(['a', 'b'])
		expect(b.id).toBeDefined()
		expect(diverged).toBe(0)
	})

	test('an insert entry keeps its fold state only where an array write can build on it', async () => {
		adapter.gating = true
		const withArrays = store.collection('stats').insert({ label: 'a' })
		const withoutArrays = store.collection('plain').insert({ name: 'p' })
		await quiesce()
		const byCollection = new Map(registry.list().map((entry) => [entry.collection, entry]))
		expect(byCollection.get('stats')?.foldState).not.toBeNull()
		expect(byCollection.get('plain')).toBeDefined()
		expect(byCollection.get('plain')?.foldState).toBeNull()
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		await Promise.all([withArrays, withoutArrays])
	})
})
