import { fc } from '@fast-check/vitest'
import { defineSchema, t } from '@korajs/core'
import type { KoraEvent } from '@korajs/core'
import { OperationTooLargeError } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { RecordNotFoundError, WriteNotDurableError } from '../errors'
import { Store } from '../store/store'
import type { Transaction } from '../types'
import type { OverlayControllerInternals } from './overlay-controller'
import type { PendingWrites } from './pending-writes'

/**
 * The prepare-once plumbing of `execute-*.ts` (instant-UI S2), driven through the real
 * `Collection` API with an overlay installed. Nothing here is user-visible: the overlay
 * only keeps its registry honest, and the write path behaves exactly as without it.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				done: t.boolean().default(false),
				n: t.number().default(0),
				note: t.string().optional(),
			},
		},
		stats: {
			fields: { label: t.string(), owner: t.string().merge('server-authoritative').optional() },
		},
		parents: { fields: { name: t.string() } },
		kids: { fields: { name: t.string(), parentId: t.string().optional() } },
	},
	relations: {
		kidParent: {
			from: 'kids',
			to: 'parents',
			type: 'many-to-one',
			field: 'parentId',
			onDelete: 'cascade',
		},
	},
})

/** Rejects the next write transaction when armed, like a bridge terminated mid-transaction. */
class FaultAdapter extends BetterSqlite3Adapter {
	failNextTransaction = false

	override async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		if (this.failNextTransaction) {
			this.failNextTransaction = false
			throw new Error('injected: transaction failed')
		}
		return super.transaction(fn)
	}
}

/** Reports the durability-lost state when armed (what SqliteWasmAdapter does without durable storage). */
class RefusingAdapter extends BetterSqlite3Adapter {
	refuses = false

	refusesWrites(): boolean {
		return this.refuses
	}
}

/** Commits, then fails the durability barrier (the IndexedDB fallback's failure mode). */
class BarrierFailAdapter extends BetterSqlite3Adapter {
	async ensureDurable(): Promise<void> {
		throw new Error('injected: barrier failed')
	}
}

interface Harness {
	store: Store
	adapter: BetterSqlite3Adapter
	registry: PendingWrites
	/** The public overlay events (`store:write-pending`, `store:write-settled`, `store:overlay-diverged`, ...). */
	overlayEvents: KoraEvent[]
	koraEvents: KoraEvent[]
}

const OVERLAY_EVENT_TYPES = [
	'store:write-pending',
	'store:write-settled',
	'store:overlay-diverged',
	'store:overlay-disabled',
] as const

async function open(
	adapter: BetterSqlite3Adapter,
	internals: OverlayControllerInternals = {},
	limits: { maxPendingWrites?: number; maxRecordsPerWrite?: number } = {},
	storeOptions: { maxOperationBytes?: number } = {},
): Promise<Harness> {
	const emitter = new SimpleEventEmitter()
	const koraEvents: KoraEvent[] = []
	const overlayEvents: KoraEvent[] = []
	emitter.on('operation:created', (event) => koraEvents.push(event))
	for (const type of OVERLAY_EVENT_TYPES) emitter.on(type, (event) => overlayEvents.push(event))
	const store = new Store({
		schema,
		adapter,
		nodeId: 'overlay-node',
		emitter,
		instantUpdates: limits,
		instantUpdatesInternals: internals,
		...storeOptions,
	})
	await store.open()
	const controller = store.getOverlayController()
	if (!controller) throw new Error('the store was built without an overlay')
	return { store, adapter, registry: controller.registry, overlayEvents, koraEvents }
}

const typesOf = (events: readonly KoraEvent[]): string[] =>
	events.map((event) =>
		event.type === 'store:write-settled' ? `${event.type}:${event.outcome}` : event.type,
	)

/** What a settle plus a remote-apply invalidation leaves: the registry knows nothing of `todos`. */
function forgetEverything(h: Harness): void {
	h.registry.settleCollection('todos', h.registry.epoch)
	h.registry.invalidate('todos')
}

describe('overlay plumbing is off by default', () => {
	test('a store built without instantUpdates has no overlay at all', async () => {
		const store = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'plain-node',
		})
		await store.open()
		expect(store.getOverlayController()).toBeNull()
		await store.close()
	})

	test('a write on such a store touches no registry and behaves as before', async () => {
		const store = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'plain-node',
		})
		await store.open()
		const todos = store.collection('todos')
		const row = await todos.insert({ title: 'a' })
		await todos.update(row.id, { done: true })
		await todos.delete(row.id)
		expect(await todos.findById(row.id)).toBeNull()
		await store.close()
	})
})

describe('predicted writes through the Collection API', () => {
	let h: Harness
	beforeEach(async () => {
		h = await open(new BetterSqlite3Adapter(':memory:'))
	})
	afterEach(async () => {
		await h.store.close()
	})

	test('an insert registers before the transaction, then commits with the operation id', async () => {
		const record = await h.store.collection('todos').insert({ title: 'first' })
		expect(typesOf(h.overlayEvents)).toEqual([
			'store:write-pending',
			'store:write-settled:committed',
		])
		const [pending, settled] = h.overlayEvents
		// The same record id before and after: the React key never changes (5.3a).
		expect(pending).toMatchObject({ kind: 'insert', recordIds: [record.id], predicted: true })
		const created = h.koraEvents.filter((event) => event.type === 'operation:created')
		expect(created).toHaveLength(1)
		expect(settled).toMatchObject({
			outcome: 'committed',
			operationIds: [created[0]?.type === 'operation:created' ? created[0].operation.id : ''],
		})
		expect(h.registry.epoch).toBe(1)
		expect(h.registry.pendingCount).toBe(0)
		expect(h.registry.list()[0]).toMatchObject({ state: 'committed', retiredAt: 1 })
		// A prediction equal to what was stored raises no divergence.
		expect(h.overlayEvents.some((event) => event.type === 'store:overlay-diverged')).toBe(false)
	})

	test('un-awaited updates of one record form a dependency chain in call order', async () => {
		const todos = h.store.collection('todos')
		const { id } = await todos.insert({ title: 'a' })
		h.overlayEvents.length = 0
		const writes = [
			todos.update(id, { n: 1 }),
			todos.update(id, { n: 2, done: true }),
			todos.update(id, { note: 'x' }),
		]
		// All three are registered synchronously, before any of them has committed.
		const entries = h.registry.list().filter((entry) => entry.kind === 'update')
		expect(entries).toHaveLength(3)
		// The first derives from the committed insert (cache), the others from the pending chain.
		expect(entries.map((entry) => entry.dependsOn)).toEqual([
			null,
			entries[0]?.writeId,
			entries[1]?.writeId,
		])
		// The chain carries the predicted record forward: the last one sees all three.
		expect(entries[2]?.record).toMatchObject({ n: 2, done: true, note: 'x' })
		await Promise.all(writes)
		expect(h.registry.pendingCount).toBe(0)
		expect(h.overlayEvents.some((event) => event.type === 'store:overlay-diverged')).toBe(false)
		expect(await todos.findById(id)).toMatchObject({ n: 2, done: true, note: 'x' })
	})

	test('a delete registers a tombstone; the record is gone from the base afterwards', async () => {
		const todos = h.store.collection('todos')
		const { id } = await todos.insert({ title: 'gone' })
		const pending = todos.delete(id)
		expect(h.registry.baseFor('todos', id)).toEqual({ found: 'deleted' })
		await pending
		h.registry.settleCollection('todos', h.registry.epoch)
		expect(h.registry.baseFor('todos', id)).toEqual({ found: 'none' })
		expect(await todos.findById(id)).toBeNull()
	})

	test('a delete of a cascade target is not predicted and still works; an insertMany is predicted', async () => {
		const parent = await h.store.collection('parents').insert({ name: 'p' })
		await h.store.collection('kids').insert({ name: 'k', parentId: parent.id })
		h.overlayEvents.length = 0
		await h.store.collection('parents').delete(parent.id)
		expect(h.overlayEvents).toMatchObject([
			{ type: 'store:write-pending', predicted: false, reason: 'cascade-target' },
		])
		expect(h.registry.list().filter((entry) => entry.collection === 'parents')).toHaveLength(1)
		// insertMany (S4) is shown too: one entry per record, all committed together.
		h.overlayEvents.length = 0
		const many = await h.store.collection('todos').insertMany([{ title: 'a' }, { title: 'b' }])
		expect(many).toHaveLength(2)
		expect(typesOf(h.overlayEvents)).toEqual([
			'store:write-pending',
			'store:write-pending',
			'store:write-settled:committed',
			'store:write-settled:committed',
		])
	})

	test('an update the predictor declines runs unchanged and is counted as a miss', async () => {
		// A server-authoritative field depends on which node wrote last, which the tab cannot know.
		const stats = h.store.collection('stats')
		const { id } = await stats.insert({ label: 'a' })
		await stats.update(id, { owner: 'me' })
		expect(h.registry.misses.get('merge-strategy')).toBe(1)
		expect(await stats.findById(id)).toMatchObject({ owner: 'me' })
	})

	test('an atomic op is predicted (S6b): the shown value is the committed one', async () => {
		const { op } = await import('@korajs/core')
		const todos = h.store.collection('todos')
		const { id } = await todos.insert({ title: 'a', n: 1 })
		await todos.update(id, { n: op.increment(2) })
		expect(h.registry.misses.get('atomic-op')).toBeUndefined()
		expect(await todos.findById(id)).toMatchObject({ n: 3 })
	})

	test('an update of a record that does not exist is not predicted and rejects as before', async () => {
		await expect(h.store.collection('todos').update('missing', { n: 1 })).rejects.toBeInstanceOf(
			RecordNotFoundError,
		)
		expect(h.registry.list()).toEqual([])
		expect(h.registry.misses.get('no-base')).toBe(1)
	})

	test('writes refused by the adapter state are never registered (F2)', async () => {
		const refusing = new RefusingAdapter(':memory:')
		await h.store.close()
		h = await open(refusing)
		refusing.refuses = true
		await h.store.collection('todos').insert({ title: 'a' })
		expect(h.registry.list()).toEqual([])
		expect(h.registry.misses.get('writes-refused')).toBe(1)
	})
})

describe('base read for an update (5.6)', () => {
	let h: Harness
	afterEach(async () => {
		await h.store.close()
	})

	test('a record the registry does not know is read once, then cached', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		let reads = 0
		h = await open(adapter, {
			readRecord: async (ctx, collection, id) => {
				reads++
				const rows = await ctx.adapter.query<Record<string, unknown>>(
					`SELECT * FROM ${collection} WHERE id = ? AND _deleted = 0`,
					[id],
				)
				const row = rows[0]
				return row
					? { id, createdAt: Number(row._created_at), updatedAt: Number(row._updated_at), ...row }
					: null
			},
		})
		const todos = h.store.collection('todos')
		const { id } = await todos.insert({ title: 'a' })
		// The insert's commit filled the cache: the first update needs no read.
		await todos.update(id, { n: 1 })
		expect(reads).toBe(0)
		// Subscriptions have re-read (settled), and a remote apply made the cache stale.
		forgetEverything(h)
		await todos.update(id, { n: 2 })
		expect(reads).toBe(1)
		await todos.update(id, { n: 3 })
		expect(reads).toBe(1)
	})

	test('a read slower than the timeout means the write is not predicted, and it still runs', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		h = await open(adapter, {
			// Never answers: the (shortened) budget is what ends the wait.
			readRecord: () => new Promise(() => {}),
			baseReadTimeoutMs: 1,
		})
		const todos = h.store.collection('todos')
		const { id } = await todos.insert({ title: 'a' })
		forgetEverything(h)
		await todos.update(id, { n: 9 })
		expect(h.registry.misses.get('base-timeout')).toBe(1)
		expect(await todos.findById(id)).toMatchObject({ n: 9 })
	})
})

describe('failure paths', () => {
	let h: Harness
	afterEach(async () => {
		await h.store.close()
	})

	test('a write that fails inside the transaction is rolled back in the registry', async () => {
		h = await open(new BetterSqlite3Adapter(':memory:'), {}, {}, { maxOperationBytes: 1 })
		await expect(h.store.collection('todos').insert({ title: 'a' })).rejects.toBeInstanceOf(
			OperationTooLargeError,
		)
		expect(typesOf(h.overlayEvents)).toEqual([
			'store:write-pending',
			'store:write-settled:rolled-back',
		])
		expect(h.registry.list()).toEqual([])
		expect(h.registry.pendingCount).toBe(0)
		expect(h.registry.bytes).toBe(0)
		expect(h.koraEvents.filter((event) => event.type === 'operation:created')).toEqual([])
	})

	test('a failed transaction removes its pending dependents with it (F10)', async () => {
		const adapter = new FaultAdapter(':memory:')
		h = await open(adapter)
		const todos = h.store.collection('todos')
		const { id } = await todos.insert({ title: 'a' })
		adapter.failNextTransaction = true
		const first = todos.update(id, { n: 1 })
		const second = todos.update(id, { n: 2 })
		expect(h.registry.list().filter((entry) => entry.state === 'pending')).toHaveLength(2)
		await expect(first).rejects.toThrow('injected: transaction failed')
		// The dependent was removed with its parent; its own (successful) commit finds no
		// entry and is a no-op, never an error.
		await expect(second).resolves.toBeDefined()
		expect(h.registry.list().filter((entry) => entry.kind === 'update')).toEqual([])
		expect(h.registry.pendingCount).toBe(0)
		expect(await todos.findById(id)).toMatchObject({ n: 2 })
	})

	test('a durability-barrier failure after the commit is not a rollback', async () => {
		h = await open(new BarrierFailAdapter(':memory:'))
		await expect(h.store.collection('todos').insert({ title: 'a' })).rejects.toBeInstanceOf(
			WriteNotDurableError,
		)
		expect(typesOf(h.overlayEvents)).toEqual([
			'store:write-pending',
			'store:write-settled:committed',
		])
		expect(h.registry.list()).toHaveLength(1)
		expect(h.registry.list()[0]?.state).toBe('committed')
	})
})

describe('predictions hold under random bursts of overlapping writes', () => {
	test('no divergence between the prediction and what was stored', async () => {
		const op = fc.oneof(
			fc.record({
				kind: fc.constant('update' as const),
				pick: fc.nat(),
				data: fc.record(
					{
						title: fc.string({ maxLength: 6 }),
						done: fc.boolean(),
						n: fc.integer({ min: -50, max: 50 }),
						note: fc.oneof(fc.string({ maxLength: 4 }), fc.constant(undefined)),
					},
					{ requiredKeys: [] },
				),
			}),
			fc.record({ kind: fc.constant('delete' as const), pick: fc.nat() }),
			fc.record({ kind: fc.constant('insert' as const), title: fc.string({ maxLength: 6 }) }),
		)
		const bursts = fc.array(fc.array(op, { minLength: 1, maxLength: 5 }), { maxLength: 6 })
		const h = await open(new BetterSqlite3Adapter(':memory:'))
		try {
			const todos = h.store.collection('todos')
			await fc.assert(
				fc.asyncProperty(bursts, async (plan) => {
					const live: string[] = []
					for (const row of await todos.where({}).exec()) live.push(row.id)
					for (const burst of plan) {
						const pending: Array<Promise<unknown>> = []
						const burstIds = [...live]
						for (const step of burst) {
							if (step.kind === 'insert') {
								pending.push(
									todos.insert({ title: step.title }).then((created) => {
										live.push(created.id)
									}),
								)
							} else if (burstIds.length > 0) {
								const id = burstIds[step.pick % burstIds.length] as string
								if (step.kind === 'delete') {
									burstIds.splice(burstIds.indexOf(id), 1)
									live.splice(live.indexOf(id), 1)
									pending.push(todos.delete(id))
								} else if (Object.keys(step.data).length > 0) {
									pending.push(todos.update(id, step.data))
								}
							}
						}
						// Some writes may legitimately reject (an update after a delete in the
						// same burst); they must never leave the registry inconsistent.
						await Promise.allSettled(pending)
						expect(h.registry.pendingCount).toBe(0)
					}
				}),
				{ numRuns: 60 },
			)
			expect(h.overlayEvents.filter((event) => event.type === 'store:overlay-diverged')).toEqual([])
		} finally {
			await h.store.close()
		}
	}, 120_000)
})
