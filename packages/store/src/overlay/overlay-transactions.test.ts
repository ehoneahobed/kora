import { defineSchema, op, t } from '@korajs/core'
import type { KoraEvent } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Store } from '../store/store'
import type { CollectionRecord } from '../types'
import type { PendingWrites } from './pending-writes'
import { GatedAdapter, quiesce, useSynchronousDigest } from './test-support'

useSynchronousDigest()

/**
 * Instant-UI S6a: `store.transaction` (what `app.transaction` and `app.mutation` call)
 * predicted as one entry group, end to end on a real Store with commits held at a gate by
 * the test. Design: docs/design/instant-ui-updates.md, "S6a design". No timers.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				done: t.boolean().default(false),
				rank: t.number().default(0),
				n: t.number().default(0),
			},
		},
		lists: { fields: { name: t.string(), size: t.number().default(0) } },
		owners: { fields: { name: t.string() } },
		pets: { fields: { name: t.string(), ownerId: t.string().optional() } },
	},
	relations: {
		petOwner: {
			from: 'pets',
			to: 'owners',
			type: 'many-to-one',
			field: 'ownerId',
			onDelete: 'cascade',
		},
	},
})

async function until(done: () => boolean, turns = 200): Promise<void> {
	for (let i = 0; i < turns && !done(); i++) await quiesce()
	if (!done()) throw new Error(`until(): condition not reached after ${turns} turns`)
}

const titles = (rows: readonly CollectionRecord[] | undefined): unknown[] =>
	(rows ?? []).map((row) => row.title)
const names = (rows: readonly CollectionRecord[] | undefined): unknown[] =>
	(rows ?? []).map((row) => row.name)

describe('transactions as one entry group (S6a)', () => {
	let store: Store
	let adapter: GatedAdapter
	let registry: PendingWrites
	let todosSeen: CollectionRecord[][]
	let listsSeen: CollectionRecord[][]
	let events: KoraEvent[]

	async function open(
		internals: {
			readRecord?: () => Promise<CollectionRecord | null>
			baseReadTimeoutMs?: number
		} = {},
		limits: { maxRecordsPerWrite?: number; maxPendingWrites?: number } | null = null,
	): Promise<void> {
		adapter = new GatedAdapter(':memory:')
		const emitter = new SimpleEventEmitter()
		events = []
		for (const type of ['store:write-pending', 'store:write-settled'] as const) {
			emitter.on(type, (event) => events.push(event))
		}
		store = new Store({
			schema,
			adapter,
			nodeId: 'overlay-tx-node',
			emitter,
			instantUpdates: limits ?? true,
			instantUpdatesInternals: { strict: true, ...internals },
		})
		await store.open()
		// A pass stops once it has run longer than its wall-clock budget, leaving the later
		// subscriptions to catch up at the commit. Under CPU load the real clock trips that
		// between two subscriptions and one list is not patched before the commit: a race with
		// the machine, not a state under test. A frozen clock never exhausts the budget.
		store.getSubscriptionManager().configureOverlay({ now: () => 0 })
		const controller = store.getOverlayController()
		if (!controller) throw new Error('the store was built without an overlay')
		registry = controller.registry
		todosSeen = []
		listsSeen = []
		store
			.collection('todos')
			.where({ done: false })
			.orderBy('rank', 'asc')
			.orderBy('id', 'asc')
			.subscribe((rows) => todosSeen.push([...rows]))
		store
			.collection('lists')
			.where({})
			.orderBy('name', 'asc')
			.subscribe((rows) => listsSeen.push([...rows]))
		await quiesce()
	}

	/** Seed rows with the gate open, then settle so the registry is empty. */
	async function seed(write: () => Promise<unknown>): Promise<void> {
		adapter.gating = false
		await write()
		await quiesce()
		// Collections nobody subscribes to settle by the time-based sweep: drop them here.
		for (const collection of ['owners', 'pets'])
			registry.settleCollection(collection, registry.epoch)
		await until(() => registry.list().length === 0)
		adapter.gating = true
		events.length = 0
	}

	async function drain(): Promise<void> {
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		await until(() => registry.list().length === 0)
	}

	/** After every write settled: each list shows exactly what a fresh SELECT returns. */
	async function expectSettled(): Promise<void> {
		await until(() => registry.list().length === 0)
		const select = async () => ({
			todos: await store
				.collection('todos')
				.where({ done: false })
				.orderBy('rank')
				.orderBy('id')
				.exec(),
			lists: await store.collection('lists').where({}).orderBy('name').exec(),
		})
		// An unpredicted write reaches the lists through its post-commit re-run: wait for it.
		for (let turn = 0; turn < 100; turn++) {
			const now = await select()
			if (
				JSON.stringify(now.todos) === JSON.stringify(todosSeen.at(-1) ?? []) &&
				JSON.stringify(now.lists) === JSON.stringify(listsSeen.at(-1) ?? [])
			) {
				break
			}
			await quiesce()
		}
		const fresh = await select()
		expect(todosSeen.at(-1) ?? []).toEqual(fresh.todos)
		expect(listsSeen.at(-1) ?? []).toEqual(fresh.lists)
	}

	beforeEach(async () => {
		await open()
		adapter.gating = true
	})

	afterEach(async () => {
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		await store.close()
	})

	test('every write of a transaction across two collections appears in one pass, before the commit', async () => {
		const todoPasses = todosSeen.length
		const listPasses = listsSeen.length
		const write = store.transaction(async (tx) => {
			await tx.collection('todos').insert({ title: 'a', rank: 2 })
			await tx.collection('lists').insert({ name: 'inbox' })
			await tx.collection('todos').insert({ title: 'b', rank: 1 })
		})
		// Both subscriptions deliver in the same pass but not in the same turn: wait for each one,
		// or the second assertion races the second callback.
		await until(
			() =>
				adapter.gates.length === 1 &&
				todosSeen.length > todoPasses &&
				listsSeen.length > listPasses,
		)
		// Shown, and nothing has committed.
		expect(titles(todosSeen.at(-1))).toEqual(['b', 'a'])
		expect(names(listsSeen.at(-1))).toEqual(['inbox'])
		// One callback per subscription for the whole group (no intermediate half state).
		expect(todosSeen.length - todoPasses).toBe(1)
		expect(listsSeen.length - listPasses).toBe(1)
		expect(registry.list().every((entry) => entry.groupId === registry.list()[0]?.groupId)).toBe(
			true,
		)
		expect(new Set(registry.list().map((entry) => entry.state))).toEqual(new Set(['pending']))

		adapter.gates.shift()?.release()
		await write
		// All members retired with ONE epoch.
		const retired = new Set(registry.list().map((entry) => entry.retiredAt))
		expect(retired.size).toBeLessThanOrEqual(1)
		await expectSettled()
		// One pending and one settled event for the group.
		const pending = events.filter((event) => event.type === 'store:write-pending')
		const settled = events.filter((event) => event.type === 'store:write-settled')
		expect(pending).toHaveLength(1)
		expect(settled).toHaveLength(1)
		const [first] = pending
		if (first?.type !== 'store:write-pending') throw new Error('unreachable')
		expect(first.kind).toBe('transaction')
		expect(first.predicted).toBe(true)
		expect(first.recordIds).toHaveLength(3)
		expect(first.collections).toEqual(['todos', 'lists'])
		const [done] = settled
		if (done?.type !== 'store:write-settled') throw new Error('unreachable')
		expect(done.writeId).toBe(first.writeId)
		expect(done.outcome).toBe('committed')
		expect(done.operationIds).toHaveLength(3)
	})

	test('a failed commit takes every write of the group back in one pass', async () => {
		await seed(() => store.collection('todos').insert({ title: 'kept', rank: 5 }))
		const kept = todosSeen.at(-1)?.[0]
		if (!kept) throw new Error('no seed row')
		const write = store.transaction(async (tx) => {
			await tx.collection('todos').insert({ title: 'new', rank: 1 })
			await tx.collection('todos').update(kept.id, { title: 'kept edited' })
			await tx.collection('lists').insert({ name: 'doomed' })
		})
		await until(() => adapter.gates.length === 1 && titles(todosSeen.at(-1)).length === 2)
		expect(titles(todosSeen.at(-1))).toEqual(['new', 'kept edited'])
		expect(names(listsSeen.at(-1))).toEqual(['doomed'])
		const passes = todosSeen.length
		const outcome = write.then(
			() => 'resolved',
			() => 'rejected',
		)
		adapter.gates.shift()?.fail()
		expect(await outcome).toBe('rejected')
		await until(() => registry.list().length === 0)
		expect(titles(todosSeen.at(-1))).toEqual(['kept'])
		expect(names(listsSeen.at(-1))).toEqual([])
		// The rollback is one pass: never only part of the group taken back.
		for (const rows of todosSeen.slice(passes)) {
			expect([['new', 'kept edited'], ['kept']]).toContainEqual(titles(rows))
		}
		const settled = events.filter((event) => event.type === 'store:write-settled')
		expect(settled.map((event) => event.type === 'store:write-settled' && event.outcome)).toEqual([
			'rolled-back',
		])
		await expectSettled()
	})

	test('reads inside the transaction see its own writes and never the overlay', async () => {
		await seed(() => store.collection('todos').insert({ title: 'base', rank: 1 }))
		const base = todosSeen.at(-1)?.[0]
		if (!base) throw new Error('no seed row')
		// A pending single write the transaction must NOT see (it reads committed rows).
		const pending = store.collection('todos').update(base.id, { title: 'pending single' })
		await until(() => titles(todosSeen.at(-1))[0] === 'pending single')
		adapter.gates.shift()?.release()
		await pending
		adapter.gating = false
		const seenInside: unknown[] = []
		await store.transaction(async (tx) => {
			const todos = tx.collection('todos')
			const inserted = await todos.insert({ title: 'inside', rank: 0 })
			seenInside.push((await todos.findById(inserted.id))?.title)
			await todos.update(inserted.id, { title: 'inside 2' })
			seenInside.push((await todos.findById(inserted.id))?.title)
			seenInside.push((await todos.findById(base.id))?.title)
		})
		expect(seenInside).toEqual(['inside', 'inside 2', 'pending single'])
		await expectSettled()
	})

	test('insert, update and delete of the same record inside one group: predicted from the group', async () => {
		const write = store.transaction(async (tx) => {
			const todos = tx.collection('todos')
			const a = await todos.insert({ title: 'a', rank: 3 })
			await todos.update(a.id, { title: 'a2', rank: 1 })
			const b = await todos.insert({ title: 'b', rank: 2 })
			await todos.delete(b.id)
			await todos.insert({ title: 'c', rank: 4 })
		})
		await until(() => adapter.gates.length === 1 && titles(todosSeen.at(-1)).length > 0)
		expect(titles(todosSeen.at(-1))).toEqual(['a2', 'c'])
		expect(registry.list()).toHaveLength(5)
		// No base read was needed: every update and delete targets a record of the group.
		expect(registry.misses.size).toBe(0)
		adapter.gates.shift()?.release()
		await write
		await expectSettled()
		expect(titles(todosSeen.at(-1))).toEqual(['a2', 'c'])
	})

	test('one declined write makes the whole group unpredicted: nothing is shown before the commit', async () => {
		await seed(() => store.collection('todos').insert({ title: 'counted', rank: 1 }))
		const row = todosSeen.at(-1)?.[0]
		if (!row) throw new Error('no seed row')
		const passes = todosSeen.length
		const write = store.transaction(async (tx) => {
			await tx.collection('todos').insert({ title: 'would show', rank: 0 })
			// An atomic op is not predicted (5.2): the group is not either.
			await tx.collection('todos').update(row.id, { n: op.increment(1) })
		})
		await until(() => adapter.gates.length === 1)
		await quiesce()
		expect(todosSeen.length).toBe(passes)
		expect(registry.list()).toEqual([])
		expect(registry.misses.get('atomic-op')).toBe(1)
		const [miss] = events
		if (miss?.type !== 'store:write-pending') throw new Error('expected a write-pending event')
		expect(miss).toMatchObject({ kind: 'transaction', predicted: false, reason: 'atomic-op' })
		adapter.gates.shift()?.release()
		await write
		await expectSettled()
		expect(titles(todosSeen.at(-1))).toEqual(['would show', 'counted'])
	})

	test('a cascading delete in the group declines the group (S6d is separate)', async () => {
		let owner = ''
		await seed(async () => {
			owner = (await store.collection('owners').insert({ name: 'ann' })).id
		})
		const write = store.transaction(async (tx) => {
			await tx.collection('lists').insert({ name: 'x' })
			await tx.collection('owners').delete(owner)
		})
		await until(() => adapter.gates.length === 1)
		await quiesce()
		expect(registry.list()).toEqual([])
		expect(registry.misses.get('cascade-target')).toBe(1)
		expect(names(listsSeen.at(-1))).toEqual([])
		adapter.gates.shift()?.release()
		await write
		await expectSettled()
	})

	test('a group over the record cap is not predicted at all, never partially', async () => {
		await store.close()
		await open({}, { maxRecordsPerWrite: 2 })
		adapter.gating = true
		const write = store.transaction(async (tx) => {
			for (const title of ['x', 'y', 'z']) await tx.collection('todos').insert({ title })
		})
		await until(() => adapter.gates.length === 1)
		await quiesce()
		expect(registry.list()).toEqual([])
		expect(registry.misses.get('records-cap')).toBe(1)
		expect(todosSeen.at(-1)).toEqual([])
		adapter.gates.shift()?.release()
		await write
		await expectSettled()
		expect(titles(todosSeen.at(-1))).toHaveLength(3)
	})

	test('a group the pending cap cannot hold whole is not predicted (headroom smaller than the group)', async () => {
		await store.close()
		await open({}, { maxPendingWrites: 3 })
		adapter.gating = true
		const single = store.collection('todos').insert({ title: 'single', rank: 9 })
		await until(() => registry.pendingCount === 1)
		const write = store.transaction(async (tx) => {
			for (const title of ['x', 'y', 'z']) await tx.collection('todos').insert({ title })
		})
		await until(() => adapter.gates.length === 2)
		await quiesce()
		expect(registry.pendingCount).toBe(1)
		expect(registry.misses.get('pending-cap')).toBe(1)
		expect(titles(todosSeen.at(-1))).toEqual(['single'])
		await drain()
		await Promise.all([single, write])
		await expectSettled()
	})

	test("an update of a record no list has shown uses the callback's own read of it: no second read", async () => {
		let reads = 0
		await store.close()
		await open({
			readRecord: async () => {
				reads++
				return null
			},
		})
		await seed(() => store.collection('lists').insert({ name: 'hidden', size: 1 }))
		const [hidden] = await store.collection('lists').where({}).exec()
		if (!hidden) throw new Error('no seed row')
		// Forget the row the list subscription seeded: only the callback's read knows it now.
		registry.invalidate('lists')
		adapter.gating = true
		const write = store.transaction(async (tx) => {
			await tx.collection('todos').insert({ title: 'n' })
			await tx.collection('lists').update(hidden.id, { size: 2 })
		})
		await until(() => adapter.gates.length === 1)
		await quiesce()
		expect(registry.list()).toHaveLength(2)
		expect(reads).toBe(0)
		expect(registry.misses.size).toBe(0)
		expect(listsSeen.at(-1)?.[0]).toMatchObject({ name: 'hidden', size: 2 })
		await drain()
		await write
		await expectSettled()
	})

	test('a change after the callback read a row makes that read unusable; a base read that does not answer declines the group', async () => {
		await store.close()
		// The base read never answers; its budget is 0 ms (an event-loop turn, not a sleep).
		await open({
			readRecord: () => new Promise<CollectionRecord | null>(() => {}),
			baseReadTimeoutMs: 0,
		})
		await seed(() => store.collection('lists').insert({ name: 'hidden', size: 1 }))
		const [hidden] = await store.collection('lists').where({}).exec()
		if (!hidden) throw new Error('no seed row')
		registry.invalidate('lists')
		let resume: () => void = () => {}
		const paused = new Promise<void>((resolve) => {
			resume = resolve
		})
		const write = store.transaction(async (tx) => {
			await tx.collection('lists').update(hidden.id, { size: 2 })
			await paused
			await tx.collection('todos').insert({ title: 'n' })
		})
		await quiesce()
		// Something the registry counts changes the collection after the callback's read (a
		// remote apply, another tab): the row it read may be stale now.
		registry.invalidate('lists', [hidden.id])
		resume()
		await until(() => adapter.gates.length === 1)
		expect(registry.list()).toEqual([])
		expect(registry.misses.get('base-timeout')).toBe(1)
		await drain()
		await write
		await expectSettled()
	})

	test('a group derived from a pending single write is removed with it when that write fails (T4)', async () => {
		await seed(() => store.collection('todos').insert({ title: 'root', rank: 1 }))
		const root = todosSeen.at(-1)?.[0]
		if (!root) throw new Error('no seed row')
		let resume: () => void = () => {}
		const paused = new Promise<void>((resolve) => {
			resume = resolve
		})
		// The callback reads the row (committed), then waits: a single update registers and
		// starts meanwhile, so at commit the group derives the record from that pending write.
		const group = store.transaction(async (tx) => {
			await tx.collection('todos').update(root.id, { rank: 7 })
			await paused
			await tx.collection('lists').insert({ name: 'depends' })
		})
		await quiesce()
		// The single write fails inside its transaction, before any statement (no M2 lookup).
		adapter.gateBeforeBody = true
		const single = store.collection('todos').update(root.id, { title: 'root edited' })
		await until(() => adapter.gates.length === 1 && titles(todosSeen.at(-1))[0] === 'root edited')
		resume()
		await until(() => adapter.gates.length === 2 && names(listsSeen.at(-1)).length === 1)
		const groupEntries = registry.list().filter((entry) => entry.groupId !== null)
		const singleEntry = registry.list().find((entry) => entry.groupId === null)
		expect(groupEntries).toHaveLength(2)
		expect(groupEntries[0]?.dependsOn).toBe(singleEntry?.writeId)
		expect(todosSeen.at(-1)?.[0]).toMatchObject({ title: 'root edited', rank: 7 })

		const singleOutcome = single.then(
			() => 'resolved',
			() => 'rejected',
		)
		adapter.gates.shift()?.fail()
		expect(await singleOutcome).toBe('rejected')
		// The single write and the whole group derived from it are gone at once.
		await until(() => registry.pendingCount === 0)
		expect(todosSeen.at(-1)?.[0]).toMatchObject({ title: 'root', rank: 1 })
		expect(names(listsSeen.at(-1))).toEqual([])
		// The group's own transaction still commits (it was valid on its own): the SQL settle
		// shows it, through the normal post-commit path.
		adapter.gates.shift()?.release()
		await group
		await expectSettled()
		expect(todosSeen.at(-1)?.[0]).toMatchObject({ title: 'root', rank: 7 })
		expect(names(listsSeen.at(-1))).toEqual(['depends'])
	})

	test('a single write derived from a group member is removed with the group', async () => {
		let resolveInsert: (id: string) => void = () => {}
		const inserted = new Promise<string>((resolve) => {
			resolveInsert = resolve
		})
		const group = store.transaction(async (tx) => {
			const row = await tx.collection('todos').insert({ title: 'g', rank: 1 })
			resolveInsert(row.id)
		})
		const id = await inserted
		await until(() => adapter.gates.length === 1 && titles(todosSeen.at(-1))[0] === 'g')
		const single = store.collection('todos').update(id, { title: 'g edited' })
		await until(() => titles(todosSeen.at(-1))[0] === 'g edited')
		const outcomes = Promise.allSettled([group, single])
		adapter.gates.shift()?.fail()
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		const [groupResult, singleResult] = await outcomes
		expect(groupResult.status).toBe('rejected')
		expect(singleResult.status).toBe('rejected')
		await expectSettled()
		expect(todosSeen.at(-1)).toEqual([])
	})

	test('with the flag off, a transaction registers nothing and runs the same statements', async () => {
		const plain = new GatedAdapter(':memory:')
		const off = new Store({ schema, adapter: plain, nodeId: 'overlay-tx-off' })
		await off.open()
		expect(off.getOverlayController()).toBeNull()
		const seen: CollectionRecord[][] = []
		off
			.collection('todos')
			.where({})
			.subscribe((rows) => seen.push([...rows]))
		await quiesce()
		plain.gating = true
		const passes = seen.length
		const write = off.transaction(async (tx) => {
			await tx.collection('todos').insert({ title: 'x' })
		})
		await until(() => plain.gates.length === 1)
		await quiesce()
		expect(seen.length).toBe(passes)
		plain.gates.shift()?.release()
		await write
		await until(() => seen.length > passes)
		expect(titles(seen.at(-1))).toEqual(['x'])
		await off.close()
	})
})
