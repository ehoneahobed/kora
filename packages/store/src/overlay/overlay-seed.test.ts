import { fc } from '@fast-check/vitest'
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import type { CollectionRecord } from '../types'
import { PendingWrites } from './pending-writes'
import type { PredictedChange } from './predict'
import { GatedAdapter, quiesce } from './test-support'

/*
 * S5 follow-up: the committed-row cache is seeded from rows that active subscriptions
 * delivered, so editing a row the user is looking at needs no base read. The risk is a
 * seeded row that is staler than the database; these tests pin the rule (seed only from a
 * result no change has overtaken) at the registry, at the subscription manager, and with a
 * property over random local and remote writes. Nothing sleeps: gates and setImmediate
 * turns only.
 */

function row(id: string, extra: Record<string, unknown> = {}): CollectionRecord {
	return { id, createdAt: 10, updatedAt: 10, title: id, ...extra }
}

function insertChange(id: string): PredictedChange {
	return {
		predicted: true,
		kind: 'insert',
		collection: 'todos',
		recordId: id,
		patch: {},
		record: row(id),
	}
}

describe('PendingWrites.seedFromRead', () => {
	test('a result no change overtook fills the cache with copies', () => {
		const registry = new PendingWrites({ now: () => 0 })
		const stamp = registry.seedStamp('todos')
		const delivered = [row('a', { n: 1 }), row('b', { n: 2 })]
		expect(registry.seedFromRead('todos', delivered, stamp)).toBe(2)
		expect(registry.baseFor('todos', 'a')).toMatchObject({
			found: 'record',
			source: 'cache',
			record: { n: 1 },
		})
		// A subscriber may keep or mutate what it was handed: the cache holds its own copy.
		const first = delivered[0]
		if (!first) throw new Error('unreachable')
		first.n = 99
		expect(registry.baseFor('todos', 'a')).toMatchObject({ record: { n: 1 } })
		expect(registry.seededRows).toBe(2)
	})

	test.each([
		[
			'a remote apply or cross-tab change (invalidate)',
			(r: PendingWrites) => r.invalidate('todos'),
		],
		['a record-level invalidation', (r: PendingWrites) => r.invalidate('todos', ['a'])],
		[
			'an unpredicted local write starting',
			(r: PendingWrites) => void r.holdUnpredicted('todos', ['a']),
		],
		[
			'a predicted local write committing',
			(r: PendingWrites) => {
				const entry = r.add(insertChange('z'), { dependsOn: null })
				if (!entry.ok) throw new Error('refused')
				r.commit(entry.entry.writeId, {})
			},
		],
		['a clear (user switch, restore, resync)', (r: PendingWrites) => void r.clear()],
	])('a read issued before %s seeds nothing', (_name, change) => {
		const registry = new PendingWrites({ now: () => 0 })
		const stamp = registry.seedStamp('todos')
		change(registry)
		expect(registry.seedFromRead('todos', [row('a'), row('b')], stamp)).toBe(0)
		expect(registry.baseFor('todos', 'b')).toEqual({ found: 'none' })
	})

	test('a change to another collection does not spoil a read', () => {
		const registry = new PendingWrites({ now: () => 0 })
		const stamp = registry.seedStamp('todos')
		registry.invalidate('notes')
		expect(registry.seedFromRead('todos', [row('a')], stamp)).toBe(1)
	})

	test('records with an entry, an unpredicted write in flight or a cached row are left alone', () => {
		const registry = new PendingWrites({ now: () => 0 })
		registry.cacheRecord('todos', row('cached', { n: 7 }))
		const pending = registry.add(insertChange('pending'), { dependsOn: null })
		if (!pending.ok) throw new Error('refused')
		const stamp = registry.seedStamp('todos')
		registry.holdUnpredicted('todos', ['held'])
		// holdUnpredicted moved the stamp, so take the token again as a later read would.
		const later = registry.seedStamp('todos')
		const seeded = registry.seedFromRead(
			'todos',
			[row('cached', { n: 0 }), row('pending', { n: 0 }), row('held', { n: 0 }), row('free')],
			later,
		)
		expect(seeded).toBe(1)
		expect(registry.baseFor('todos', 'cached')).toMatchObject({ record: { n: 7 } })
		expect(registry.baseFor('todos', 'held')).toEqual({ found: 'none' })
		expect(registry.baseFor('todos', 'free')).toMatchObject({ source: 'cache' })
		expect(stamp).not.toBe(later)
	})

	test('the cache cap holds, the top of the result is kept, and seeds evict the least recently used', () => {
		const registry = new PendingWrites({ now: () => 0, rowCacheSize: 3 })
		registry.cacheRecord('todos', row('old1'))
		registry.cacheRecord('todos', row('old2'))
		const rows = ['r0', 'r1', 'r2', 'r3', 'r4'].map((id) => row(id))
		// Only `rowCacheSize` rows are taken from one result, from the top.
		expect(registry.seedFromRead('todos', rows, registry.seedStamp('todos'))).toBe(3)
		expect(registry.cachedRows).toBe(3)
		for (const id of ['r0', 'r1', 'r2']) {
			expect(registry.baseFor('todos', id).found).toBe('record')
		}
		for (const id of ['r3', 'r4', 'old1', 'old2']) {
			expect(registry.baseFor('todos', id)).toEqual({ found: 'none' })
		}
		// The first rows of the result are the most recently used: r2 goes first.
		registry.cacheRecord('todos', row('x'))
		// baseFor above touched r0, r1, r2 in that order, so r0 is now the oldest.
		expect(registry.baseFor('todos', 'r0')).toEqual({ found: 'none' })
		expect(registry.baseFor('todos', 'r1').found).toBe('record')
		expect(registry.cachedRows).toBe(3)
	})

	test('seeding evicts in recency order: the first rows of a result outlive the last', () => {
		const registry = new PendingWrites({ now: () => 0, rowCacheSize: 4 })
		registry.seedFromRead(
			'todos',
			['a', 'b', 'c', 'd'].map((id) => row(id)),
			registry.seedStamp('todos'),
		)
		registry.cacheRecord('todos', row('new1'))
		registry.cacheRecord('todos', row('new2'))
		// Two rows were evicted: the bottom two of the result.
		expect(registry.baseFor('todos', 'd')).toEqual({ found: 'none' })
		expect(registry.baseFor('todos', 'c')).toEqual({ found: 'none' })
		expect(registry.baseFor('todos', 'a').found).toBe('record')
		expect(registry.baseFor('todos', 'b').found).toBe('record')
	})

	test('a zero-size cache seeds nothing', () => {
		const registry = new PendingWrites({ now: () => 0, rowCacheSize: 0 })
		expect(registry.seedFromRead('todos', [row('a')], registry.seedStamp('todos'))).toBe(0)
	})

	test('a commit that reports no row forgets the cached one (its outcome came from a lookup)', () => {
		const registry = new PendingWrites({ now: () => 0 })
		registry.seedFromRead('todos', [row('a', { n: 1 })], registry.seedStamp('todos'))
		const update = registry.add(
			{
				predicted: true,
				kind: 'update',
				collection: 'todos',
				recordId: 'a',
				patch: { n: 2 },
				record: row('a', { n: 2 }),
			},
			{ dependsOn: null },
		)
		if (!update.ok) throw new Error('refused')
		registry.commit(update.entry.writeId, { operationIds: ['op'] })
		registry.settleCollection('todos', registry.epoch)
		expect(registry.baseFor('todos', 'a')).toEqual({ found: 'none' })
	})
})

// --- through a real Store -----------------------------------------------------------

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				n: t.number().default(0),
				done: t.boolean().default(false),
				note: t.string().optional(),
			},
		},
	},
})

/** Holds the first read issued after `holdNextRead()` until `releaseRead()`; the rows are read first. */
class HoldingAdapter extends GatedAdapter {
	private held: Promise<void> | null = null
	private release: (() => void) | null = null
	private armed = false

	holdNextRead(): void {
		this.armed = true
	}

	releaseRead(): void {
		this.release?.()
	}

	override async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		const rows = await super.query<T>(sql, params)
		if (this.armed && sql.includes('ORDER BY')) {
			this.armed = false
			this.held = new Promise<void>((resolve) => {
				this.release = resolve
			})
			await this.held
		}
		return rows
	}
}

interface World {
	store: Store
	adapter: HoldingAdapter
	peer: Store
	registry: PendingWrites
	reads: { count: number }
	delivered: CollectionRecord[][]
	remote(write: () => Promise<unknown>): Promise<void>
}

let open: World[] = []

async function world(rowCacheSize?: number): Promise<World> {
	const adapter = new HoldingAdapter(':memory:')
	const emitter = new SimpleEventEmitter()
	const peerEmitter = new SimpleEventEmitter()
	const reads = { count: 0 }
	const holder: { store?: Store } = {}
	const store = new Store({
		schema,
		adapter,
		nodeId: 'node-a',
		emitter,
		instantUpdates: true,
		instantUpdatesInternals: {
			baseReadTimeoutMs: 60_000,
			strict: true,
			...(rowCacheSize !== undefined ? { rowCacheSize } : {}),
			readRecord: async (_ctx, collection, id): Promise<CollectionRecord | null> => {
				reads.count++
				return (await holder.store?.collection(collection).findById(id)) ?? null
			},
		},
	})
	const peer = new Store({
		schema,
		adapter: new BetterSqlite3Adapter(':memory:'),
		nodeId: 'node-b',
		emitter: peerEmitter,
	})
	holder.store = store
	await store.open()
	await peer.open()
	const controller = store.getOverlayController()
	if (!controller) throw new Error('the store was built without an overlay')
	const fromPeer: Array<Promise<unknown>> = []
	peerEmitter.on('operation:created', (event) => {
		fromPeer.push(store.applyRemoteOperation(event.operation as Operation))
	})
	const w: World = {
		store,
		adapter,
		peer,
		registry: controller.registry,
		reads,
		delivered: [],
		async remote(write) {
			await write()
			await Promise.all(fromPeer.splice(0))
		},
	}
	open.push(w)
	return w
}

afterEach(async () => {
	for (const w of open) {
		w.adapter.autoRelease = true
		for (const gate of w.adapter.gates.splice(0)) gate.release()
		await w.store.close()
		await w.peer.close()
	}
	open = []
})

const strip = (record: CollectionRecord | null | undefined) => {
	if (!record) return record
	const { createdAt: _c, updatedAt: _u, ...rest } = record
	return rest
}

async function until(done: () => boolean): Promise<void> {
	for (let i = 0; i < 50 && !done(); i++) await quiesce()
}

function watch(w: World): void {
	w.store
		.collection('items')
		.where({})
		.orderBy('id', 'asc')
		.subscribe((rows) => w.delivered.push([...rows]))
}

describe('seeding through a subscription', () => {
	test('editing a row the user is looking at needs no read, and the prediction equals the stored row', async () => {
		const w = await world()
		const record = await w.peer.collection('items').insert({ title: 'a', n: 1 })
		await w.remote(async () => {})
		watch(w)
		await quiesce()
		expect(w.registry.seededRows).toBeGreaterThan(0)
		const reads = w.reads.count

		w.adapter.gating = true
		const write = w.store.collection('items').update(record.id, { title: 'edited', done: true })
		await until(() => w.adapter.gates.length === 1)
		const predicted = w.registry.pendingFor('items', record.id)?.record
		expect(predicted).toBeDefined()
		// Shown before the commit, and no base read was made for it.
		expect(w.delivered.at(-1)?.[0]).toMatchObject({ title: 'edited', done: true })
		w.adapter.gates.shift()?.release()
		await write
		w.adapter.gating = false
		await quiesce()

		expect(w.reads.count).toBe(reads)
		expect(strip(predicted)).toEqual(strip(await w.store.collection('items').findById(record.id)))
		expect(w.registry.misses.size).toBe(0)
	})

	test('a delete of a row on screen needs no read either', async () => {
		const w = await world()
		const record = await w.peer.collection('items').insert({ title: 'gone' })
		await w.remote(async () => {})
		watch(w)
		await quiesce()
		const reads = w.reads.count
		w.adapter.gating = true
		const write = w.store.collection('items').delete(record.id)
		await until(() => w.adapter.gates.length === 1)
		expect(w.delivered.at(-1)).toEqual([])
		w.adapter.gates.shift()?.release()
		await write
		w.adapter.gating = false
		expect(w.reads.count).toBe(reads)
		expect(w.registry.misses.size).toBe(0)
	})

	test('a remote change between the seed and the write is not predicted from the seeded row', async () => {
		const w = await world()
		const record = await w.peer.collection('items').insert({ title: 'a', n: 1 })
		await w.remote(async () => {})
		watch(w)
		await quiesce()
		expect(w.registry.baseFor('items', record.id).found).toBe('record')

		// A remote edit of another field lands after the seed; the re-read it triggers is
		// still in flight when the user edits the row.
		w.adapter.holdNextRead()
		await w.remote(() => w.peer.collection('items').update(record.id, { n: 50 }))
		await quiesce()
		expect(w.registry.baseFor('items', record.id)).toEqual({ found: 'none' })

		w.adapter.gating = true
		const reads = w.reads.count
		const write = w.store.collection('items').update(record.id, { title: 'mine' })
		await until(() => w.adapter.gates.length === 1)
		const predicted = w.registry.pendingFor('items', record.id)?.record
		// It read the fresh row: never the stale n=1.
		expect(w.reads.count).toBe(reads + 1)
		expect(predicted).toMatchObject({ title: 'mine', n: 50 })
		w.adapter.gates.shift()?.release()
		w.adapter.releaseRead()
		await write
		w.adapter.gating = false
		await quiesce()
		expect(strip(predicted)).toEqual(strip(await w.store.collection('items').findById(record.id)))
	})

	test('a result the registry heard a change after issuing seeds nothing', async () => {
		const w = await world()
		const record = await w.peer.collection('items').insert({ title: 'a', n: 1 })
		await w.remote(async () => {})
		watch(w)
		await quiesce()
		const issued = w.registry.seededRows

		// A re-run is issued and held; the registry hears of a change to the collection
		// (what a cross-tab change does) before the result is delivered. No newer run
		// replaces the held one, so it is delivered as current: it must not seed.
		w.adapter.holdNextRead()
		w.store.getSubscriptionManager().invalidate('items')
		await quiesce()
		w.registry.invalidate('items')
		w.adapter.releaseRead()
		await quiesce()
		expect(w.registry.seededRows).toBe(issued)
		expect(w.registry.baseFor('items', record.id)).toEqual({ found: 'none' })

		// The next result, issued after the change, seeds again.
		w.store.getSubscriptionManager().invalidate('items')
		await quiesce()
		expect(w.registry.baseFor('items', record.id).found).toBe('record')
	})

	test('a pending local write on the record is the base, not the seeded row', async () => {
		const w = await world()
		const record = await w.peer.collection('items').insert({ title: 'a', n: 1 })
		await w.remote(async () => {})
		watch(w)
		await quiesce()
		w.adapter.gating = true
		const first = w.store.collection('items').update(record.id, { n: 2 })
		const second = w.store.collection('items').update(record.id, { title: 'b' })
		await until(() => w.adapter.gates.length === 2)
		// The chained update was derived from the first one's prediction.
		expect(w.registry.pendingFor('items', record.id)?.record).toMatchObject({ n: 2, title: 'b' })
		for (const gate of w.adapter.gates.splice(0)) gate.release()
		await Promise.all([first, second])
		w.adapter.gating = false
		await quiesce()
		expect(await w.store.collection('items').findById(record.id)).toMatchObject({
			n: 2,
			title: 'b',
		})
	})

	test('the cache cap holds for a large result and a row beyond it is read, not guessed', async () => {
		const w = await world(4)
		const ids: string[] = []
		for (let i = 0; i < 10; i++) {
			ids.push((await w.peer.collection('items').insert({ title: `t${i}` })).id)
		}
		await w.remote(async () => {})
		watch(w)
		await quiesce()
		expect(w.registry.cachedRows).toBe(4)
		const sorted = [...ids].sort()
		const last = sorted[9]
		if (!last) throw new Error('unreachable')
		const reads = w.reads.count
		await w.store.collection('items').update(last, { n: 5 })
		expect(w.reads.count).toBe(reads + 1)
		const first = sorted[0]
		if (!first) throw new Error('unreachable')
		await w.store.collection('items').update(first, { n: 6 })
		expect(w.reads.count).toBe(reads + 1)
		expect(w.registry.cachedRows).toBeLessThanOrEqual(4)
	})
})

describe('flag off', () => {
	test('no controller exists and a subscription reads nothing extra', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const queries: string[] = []
		const original = adapter.query.bind(adapter)
		adapter.query = (async (sql: string, params?: unknown[]) => {
			queries.push(sql)
			return original(sql, params)
		}) as typeof adapter.query
		const store = new Store({ schema, adapter, nodeId: 'node-off' })
		await store.open()
		expect(store.getOverlayController()).toBeNull()
		const items = store.collection('items')
		const { id } = await items.insert({ title: 'a' })
		const seen: CollectionRecord[][] = []
		items.where({}).subscribe((rows) => seen.push([...rows]))
		await quiesce()
		queries.length = 0
		await items.update(id, { n: 1 })
		await quiesce()
		// One re-run of the subscription's SELECT and nothing else: no base read, no seeding.
		expect(queries).toHaveLength(1)
		expect(seen.at(-1)?.[0]).toMatchObject({ n: 1 })
		expect(store.getSubscriptionManager().getOverlayStats().patchedDeliveries).toBe(0)
		await store.close()
	})
})

// --- property: random local and remote writes ----------------------------------------

type Step =
	| { kind: 'local-update'; index: number; n: number; title: string; settle: boolean }
	| { kind: 'local-delete'; index: number; settle: boolean }
	| { kind: 'remote-update'; index: number; n: number; note: string | null; settle: boolean }
	| { kind: 'remote-delete'; index: number; settle: boolean }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
	fc.record({
		kind: fc.constant('local-update' as const),
		index: fc.nat(3),
		n: fc.integer({ min: 0, max: 5 }),
		title: fc.constantFrom('x', 'y', 'z'),
		settle: fc.boolean(),
	}),
	fc.record({ kind: fc.constant('local-delete' as const), index: fc.nat(3), settle: fc.boolean() }),
	fc.record({
		kind: fc.constant('remote-update' as const),
		index: fc.nat(3),
		n: fc.integer({ min: 0, max: 5 }),
		note: fc.option(fc.constantFrom('p', 'q'), { nil: null }),
		settle: fc.boolean(),
	}),
	fc.record({
		kind: fc.constant('remote-delete' as const),
		index: fc.nat(3),
		settle: fc.boolean(),
	}),
)

describe('seeded predictions equal the stored rows (property)', () => {
	test('over random local writes interleaved with remote changes', async () => {
		let predictedWrites = 0
		let seededWrites = 0
		await fc.assert(
			fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 12 }), async (steps) => {
				const w = await world()
				try {
					const ids: string[] = []
					for (let i = 0; i < 4; i++) {
						ids.push((await w.peer.collection('items').insert({ title: `t${i}`, n: i })).id)
					}
					await w.remote(async () => {})
					watch(w)
					await quiesce()
					const alive = new Set(ids)
					const items = w.store.collection('items')
					const peerItems = w.peer.collection('items')
					for (const step of steps) {
						const id = ids[step.index]
						if (!id || !alive.has(id)) continue
						if (step.kind === 'remote-update') {
							await w.remote(() =>
								peerItems.update(id, {
									n: step.n,
									note: step.note === null ? undefined : step.note,
								}),
							)
						} else if (step.kind === 'remote-delete') {
							await w.remote(() => peerItems.delete(id))
							alive.delete(id)
						} else {
							const fromSeed = w.registry.baseFor('items', id).found === 'record'
							w.adapter.gating = true
							const write =
								step.kind === 'local-update'
									? items.update(id, { n: step.n, title: step.title })
									: items.delete(id)
							await until(() => w.adapter.gates.length === 1)
							const entry = w.registry.pendingFor('items', id)
							const predicted = entry?.record
							w.adapter.gates.shift()?.release()
							await write
							w.adapter.gating = false
							if (step.kind === 'local-delete') alive.delete(id)
							if (entry && step.kind === 'local-update') {
								predictedWrites++
								if (fromSeed) seededWrites++
								const stored = await items.findById(id)
								expect(strip(predicted)).toEqual(strip(stored))
							}
						}
						if (step.settle) await quiesce()
					}
				} finally {
					w.adapter.autoRelease = true
					for (const gate of w.adapter.gates.splice(0)) gate.release()
					await w.store.close()
					await w.peer.close()
					open = open.filter((x) => x !== w)
				}
			}),
			{ numRuns: 60 },
		)
		// The property is only meaningful if it exercised the seeded path.
		expect(predictedWrites).toBeGreaterThan(0)
		expect(seededWrites).toBeGreaterThan(0)
	}, 120_000)
})
