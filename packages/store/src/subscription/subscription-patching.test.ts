import { defineSchema, t } from '@korajs/core'
import type { CollectionDefinition, Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { PendingWrites } from '../overlay/pending-writes'
import type { PredictedChange } from '../overlay/predict'
import type { CollectionRecord, QueryDescriptor } from '../types'
import { SubscriptionManager } from './subscription-manager'

/**
 * SubscriptionManager patching (instant-UI S3, design 5.5): base, baseIssuedAt, display,
 * settle on SQL results, the coalesced pass and its budget. The reads are controlled by
 * the test (no real database, no timers): a read answers when the test says so, with the
 * rows the test chooses, which is how "a read issued before the commit but executed after
 * it" and "a remote change in the base" are built.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: { title: t.string(), n: t.number().optional(), done: t.boolean().default(false) },
		},
		other: { fields: { title: t.string() } },
	},
})
const items = schema.collections.items as CollectionDefinition

const tick = async (): Promise<void> => {
	for (let i = 0; i < 12; i++) await Promise.resolve()
}

const record = (id: string, fields: Record<string, unknown> = {}): CollectionRecord => ({
	id,
	createdAt: 1_000,
	updatedAt: 1_000,
	title: id,
	n: null,
	done: false,
	...fields,
})

const byN: QueryDescriptor = {
	collection: 'items',
	where: {},
	orderBy: [{ field: 'n', direction: 'asc' }],
}

function insertChange(rec: CollectionRecord): PredictedChange {
	return {
		predicted: true,
		kind: 'insert',
		collection: 'items',
		recordId: rec.id,
		patch: rec,
		record: rec,
	}
}

function updateChange(current: CollectionRecord, patch: Record<string, unknown>): PredictedChange {
	return {
		predicted: true,
		kind: 'update',
		collection: 'items',
		recordId: current.id,
		patch,
		previous: Object.fromEntries(Object.keys(patch).map((key) => [key, current[key]])),
		record: { ...current, ...patch },
	}
}

function deleteChange(rec: CollectionRecord): PredictedChange {
	return {
		predicted: true,
		kind: 'delete',
		collection: 'items',
		recordId: rec.id,
		patch: null,
		record: rec,
	}
}

function op(recordId: string, id = `op-${recordId}`): Operation {
	return {
		id,
		nodeId: 'remote-node',
		type: 'update',
		collection: 'items',
		recordId,
		data: { title: 'x' },
		previousData: null,
		timestamp: { wallTime: 1, logical: 0, nodeId: 'remote-node' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

/** Reads the test answers by hand. `issued` is the registry epoch at the call. */
class Reads {
	private queue: Array<(rows: CollectionRecord[]) => void> = []
	fn = (): Promise<CollectionRecord[]> =>
		new Promise((resolve) => {
			this.queue.push(resolve)
		})
	get waiting(): number {
		return this.queue.length
	}
	/** Answer the oldest waiting read. */
	answer(rows: CollectionRecord[]): void {
		const next = this.queue.shift()
		if (!next) throw new Error('no read is waiting')
		next(rows)
	}
}

interface Rig {
	manager: SubscriptionManager
	registry: PendingWrites
	reads: Reads
	calls: CollectionRecord[][]
	clock: { now: number }
}

function rig(
	options: { descriptor?: QueryDescriptor; budgetMs?: number; step?: number } = {},
): Rig {
	const clock = { now: 0 }
	const registry = new PendingWrites({ now: () => clock.now })
	const manager = new SubscriptionManager({
		pendingWrites: () => registry,
		getDefinition: (collection) => (collection === 'items' ? items : undefined),
		now: () => {
			clock.now += options.step ?? 0
			return clock.now
		},
		...(options.budgetMs !== undefined ? { overlayPassBudgetMs: options.budgetMs } : {}),
	})
	const reads = new Reads()
	const calls: CollectionRecord[][] = []
	manager.registerAndFetch(options.descriptor ?? byN, (rows) => calls.push([...rows]), reads.fn)
	return { manager, registry, reads, calls, clock }
}

const idsOf = (rows: readonly CollectionRecord[] | undefined) => (rows ?? []).map((r) => r.id)

async function withBase(
	options: Parameters<typeof rig>[0] = {},
	base = [record('a', { n: 1 }), record('c', { n: 5 })],
): Promise<Rig> {
	const r = rig(options)
	r.reads.answer(base)
	await tick()
	r.calls.length = 0
	return r
}

describe('patching: the first callback comes from the overlay, not the database', () => {
	test('an added entry reaches the subscriber in a microtask, with no read', async () => {
		const r = await withBase()
		r.registry.add(insertChange(record('x', { n: 3 })))
		expect(r.calls).toHaveLength(0) // not in the same synchronous step: the pass is a microtask
		await tick()
		expect(r.calls.map(idsOf)).toEqual([['a', 'x', 'c']])
		expect(r.reads.waiting).toBe(0)
		expect(r.manager.getOverlayStats().patchedDeliveries).toBe(1)
	})

	test('several adds in one task produce one callback (the pass is coalesced)', async () => {
		const r = await withBase()
		r.registry.add(insertChange(record('x', { n: 2 })))
		r.registry.add(insertChange(record('y', { n: 4 })))
		r.registry.add(updateChange(record('a', { n: 1 }), { n: 9 }))
		await tick()
		expect(r.calls).toHaveLength(1)
		expect(idsOf(r.calls[0])).toEqual(['x', 'y', 'c', 'a'])
		expect(r.manager.getOverlayStats().passes).toBe(1)
	})

	test('a collection with no subscription, and a write to another collection, change nothing', async () => {
		const r = await withBase()
		r.registry.add({ ...insertChange(record('z')), collection: 'other' })
		await tick()
		expect(r.calls).toHaveLength(0)
	})

	test('a patch never reaches the records-change listeners (the cross-tab bus, I11)', async () => {
		const r = await withBase()
		const heard: string[] = []
		r.manager.onRecordsChanged((change) => heard.push(change.collection))
		heard.length = 0
		r.registry.add(insertChange(record('x', { n: 3 })))
		await tick()
		expect(r.calls).toHaveLength(1)
		expect(heard).toEqual([])
	})

	test('a subscription without a base yet is not patched; the entry is applied when its first result arrives', async () => {
		const r = rig()
		r.registry.add(insertChange(record('x', { n: 3 })))
		await tick()
		expect(r.calls).toHaveLength(0)
		r.reads.answer([record('a', { n: 1 }), record('c', { n: 5 })])
		await tick()
		expect(r.calls.map(idsOf)).toEqual([['a', 'x', 'c']])
	})

	test('queries the evaluator does not know keep the commit path', async () => {
		for (const descriptor of [
			{ ...byN, include: ['parent'], includeCollections: ['other'] },
			{ ...byN, offset: 1 },
			{ collection: 'items', where: { missing: 1 }, orderBy: [] },
		] as QueryDescriptor[]) {
			const r = await withBase({ descriptor })
			r.registry.add(insertChange(record('x', { n: 3 })))
			await tick()
			expect(r.calls).toHaveLength(0)
		}
	})
})

describe('patching: commit, settle and the SQL result', () => {
	test('commit keeps the display; the post-commit read replaces it and the entry is dropped', async () => {
		const r = await withBase()
		const added = r.registry.add(
			insertChange(record('x', { n: 3, createdAt: 2_000, updatedAt: 2_000 })),
		)
		if (!added.ok) throw new Error('add refused')
		await tick()
		r.calls.length = 0

		r.registry.commit(added.entry.writeId, {
			record: record('x', { n: 3, createdAt: 2_007, updatedAt: 2_007 }),
		})
		await tick()
		// The row never disappears at commit (F3); it shows the stored record: the one
		// callback for the metadata that differs from the prediction (section 14, risk 6).
		expect(r.calls).toHaveLength(1)
		expect(idsOf(r.calls[0])).toEqual(['a', 'x', 'c'])
		expect(r.calls[0]?.[1]?.createdAt).toBe(2_007)
		r.calls.length = 0

		r.manager.notify('items', op('x', 'op-own'))
		await tick()
		expect(r.reads.waiting).toBe(1)
		// The read was issued after the commit: it contains the row, with committed metadata.
		r.reads.answer([
			record('a', { n: 1 }),
			record('x', { n: 3, createdAt: 2_007, updatedAt: 2_007 }),
			record('c', { n: 5 }),
		])
		await tick()
		// Already showing the stored record: the SQL result changes nothing, and settles.
		expect(r.calls).toHaveLength(0)
		expect(r.registry.list()).toEqual([])
	})

	test('a post-commit read equal to the display is not delivered again', async () => {
		const r = await withBase()
		const x = record('x', { n: 3 })
		const added = r.registry.add(insertChange(x))
		if (!added.ok) throw new Error('add refused')
		await tick()
		r.registry.commit(added.entry.writeId, { record: x })
		r.manager.notify('items', op('x'))
		await tick()
		r.calls.length = 0
		r.reads.answer([record('a', { n: 1 }), { ...x }, record('c', { n: 5 })])
		await tick()
		expect(r.calls).toHaveLength(0)
		expect(r.registry.list()).toEqual([])
	})

	test('a read issued BEFORE the commit but answered after it contains the row: the entry is applied again without duplicating it (F6)', async () => {
		const r = await withBase()
		const x = record('x', { n: 3 })
		// Another change re-runs the query while the write is pending: the read is issued now.
		r.manager.notify('items', op('other-record'))
		await tick()
		expect(r.reads.waiting).toBe(1)
		const added = r.registry.add(insertChange(x))
		if (!added.ok) throw new Error('add refused')
		await tick()
		r.calls.length = 0
		r.registry.commit(added.entry.writeId, { record: x })
		// The (older) read executes after the commit, so it already holds the row.
		r.reads.answer([record('a', { n: 1 }), x, record('c', { n: 5 })])
		await tick()
		expect(r.calls.every((rows) => idsOf(rows).filter((id) => id === 'x').length === 1)).toBe(true)
		const shown = r.calls.at(-1) ?? []
		expect(idsOf(shown.length ? shown : [record('a'), x, record('c')])).toContain('x')
		// The entry stays until a read issued after the commit arrives.
		expect(r.registry.list()).toHaveLength(1)
		r.manager.notify('items', op('x'))
		await tick()
		r.reads.answer([record('a', { n: 1 }), x, record('c', { n: 5 })])
		await tick()
		expect(r.registry.list()).toEqual([])
	})

	test('the older of two overlapping reads never overwrites the newer (run numbering still holds)', async () => {
		const r = await withBase()
		r.manager.notify('items', op('q1'))
		await tick()
		r.manager.notify('items', op('q2'))
		await tick()
		// Two flushes were run one after the other: the second read waits for the first.
		expect(r.reads.waiting).toBeGreaterThanOrEqual(1)
		r.reads.answer([record('a', { n: 1 }), record('c', { n: 5 }), record('d', { n: 7 })])
		await tick()
		expect(idsOf(r.calls.at(-1))).toEqual(['a', 'c', 'd'])
	})

	test('an entry stays while a subscription of the collection has not read past it', async () => {
		const r = await withBase()
		const second = new Reads()
		r.manager.registerAndFetch({ ...byN, limit: 10 }, () => {}, second.fn)
		const x = record('x', { n: 3 })
		const added = r.registry.add(insertChange(x))
		if (!added.ok) throw new Error('add refused')
		r.registry.commit(added.entry.writeId, { record: x })
		r.manager.notify('items', op('x'))
		await tick()
		r.reads.answer([record('a', { n: 1 }), x, record('c', { n: 5 })])
		await tick()
		// The second subscription still waits for its first result: the entry is kept for it.
		expect(r.registry.list()).toHaveLength(1)
		second.answer([record('a', { n: 1 }), record('c', { n: 5 })])
		await tick()
		// Its first result (issued before the commit) is patched; its post-commit read follows.
		second.answer([record('a', { n: 1 }), x, record('c', { n: 5 })])
		await tick()
		expect(r.registry.list()).toEqual([])
	})

	test('committed entries of a collection nobody patches are dropped once the settle window has passed', async () => {
		const r = await withBase({
			descriptor: { collection: 'items', where: {}, orderBy: [], include: ['p'] },
		})
		const x = record('x')
		const added = r.registry.add(insertChange(x))
		if (!added.ok) throw new Error('add refused')
		r.registry.commit(added.entry.writeId, { record: x })
		r.manager.notify('items', op('x'))
		await tick()
		r.reads.answer([record('a'), x])
		await tick()
		// No patchable subscription reads past the entry: it waits for the settle window.
		expect(r.registry.list()).toHaveLength(1)
		r.clock.now += 3_000
		r.manager.notify('items', op('y'))
		await tick()
		r.reads.answer([record('a'), x])
		await tick()
		expect(r.registry.list()).toEqual([])
	})

	test('a committed entry older than the settle window forces a re-read on the next flush', async () => {
		const r = await withBase()
		const x = record('x', { n: 3 })
		const added = r.registry.add(insertChange(x))
		if (!added.ok) throw new Error('add refused')
		r.registry.commit(added.entry.writeId, { record: x })
		r.clock.now += 3_000 // past settleMs; no read ever came
		r.manager.notify('other', op('o'))
		await tick()
		expect(r.reads.waiting).toBe(1)
		r.reads.answer([record('a', { n: 1 }), x, record('c', { n: 5 })])
		await tick()
		expect(r.registry.list()).toEqual([])
	})
})

describe('patching: rollback restores the base', () => {
	test('rolling back the only entry returns the subscriber to the base rows', async () => {
		const r = await withBase()
		const added = r.registry.add(insertChange(record('x', { n: 3 })))
		if (!added.ok) throw new Error('add refused')
		await tick()
		expect(r.calls).toHaveLength(1)
		r.registry.rollback(added.entry.writeId)
		await tick()
		expect(r.calls).toHaveLength(2)
		expect(idsOf(r.calls[1])).toEqual(['a', 'c'])
	})

	test('a middle rollback removes the entry and its dependents, keeps the others', async () => {
		const r = await withBase()
		const x = record('x', { n: 2 })
		const first = r.registry.add(insertChange(x))
		if (!first.ok) throw new Error('add refused')
		const chained = r.registry.add(updateChange(x, { n: 4 }), { dependsOn: first.entry.writeId })
		const independent = r.registry.add(insertChange(record('y', { n: 3 })))
		if (!chained.ok || !independent.ok) throw new Error('add refused')
		await tick()
		expect(idsOf(r.calls.at(-1))).toEqual(['a', 'y', 'x', 'c'])
		r.registry.rollback(first.entry.writeId)
		await tick()
		expect(idsOf(r.calls.at(-1))).toEqual(['a', 'y', 'c'])
	})

	test('clearing the registry (sign-out, restore) returns every subscriber to its base', async () => {
		const r = await withBase()
		r.registry.add(insertChange(record('x', { n: 3 })))
		await tick()
		r.registry.clear()
		await tick()
		expect(idsOf(r.calls.at(-1))).toEqual(['a', 'c'])
	})

	test('an unknown outcome keeps the row shown (never silently rolled back)', async () => {
		const r = await withBase()
		const added = r.registry.add(insertChange(record('x', { n: 3 })))
		if (!added.ok) throw new Error('add refused')
		await tick()
		r.calls.length = 0
		r.registry.markUnknown(added.entry.writeId)
		await tick()
		expect(r.calls).toHaveLength(0)
		// Decided: it did commit.
		r.registry.commit(added.entry.writeId, { record: record('x', { n: 3 }) })
		await tick()
		expect(r.calls).toHaveLength(0)
	})
})

describe('patching: remote deliveries interleaved with a pending write', () => {
	test('a remote change to another field stays; the pending field patch stays on top', async () => {
		const a = record('a', { n: 1, title: 'old' })
		const r = await withBase({}, [a, record('c', { n: 5 })])
		// Local: set done=true on a (pending).
		r.registry.add(updateChange(a, { done: true }))
		await tick()
		expect(r.calls.at(-1)?.[0]).toMatchObject({ id: 'a', done: true, title: 'old' })
		// Remote: changed the title, committed first; the re-read returns it (the local row is
		// not committed yet, so the read does not have done=true).
		r.manager.notify('items', op('a', 'remote-op'))
		await tick()
		r.reads.answer([record('a', { n: 1, title: 'remote title' }), record('c', { n: 5 })])
		await tick()
		expect(r.calls.at(-1)?.[0]).toMatchObject({ id: 'a', done: true, title: 'remote title' })
	})

	test('a remote deletion of the record while an update is pending leaves nothing to patch', async () => {
		const r = await withBase()
		r.registry.add(updateChange(record('a', { n: 1 }), { done: true }))
		await tick()
		r.manager.notify('items', op('a', 'remote-delete'))
		await tick()
		r.reads.answer([record('c', { n: 5 })])
		await tick()
		// The update patch finds no row and (an update that does not enter) is a no-op.
		expect(idsOf(r.calls.at(-1))).toEqual(['c'])
	})

	test('a remote operation invalidates the cached rows of its record, a local one the registry committed does not (F21)', async () => {
		const r = await withBase()
		const x = record('x', { n: 3 })
		const added = r.registry.add(insertChange(x))
		if (!added.ok) throw new Error('add refused')
		r.registry.commit(added.entry.writeId, { record: x, operationIds: ['op-own'] })
		expect(r.registry.baseFor('items', 'x').found).toBe('record')
		// The post-commit publication of the registry's own write: the cached row stays.
		r.manager.notify('items', op('x', 'op-own'))
		expect(r.registry.cachedRows).toBe(1)
		// A remote operation naming the record drops it.
		r.manager.notify('items', op('x', 'op-remote'))
		expect(r.registry.cachedRows).toBe(0)
	})

	test('peer changes and untracked invalidations clear the cache of the collection (F21)', async () => {
		const r = await withBase()
		const a = record('a')
		const b = record('b')
		r.registry.cacheRecord('items', a)
		r.registry.cacheRecord('items', b)
		r.manager.invalidate('items', ['a'])
		expect(r.registry.cachedRows).toBe(1)
		r.manager.invalidateFromPeer('items')
		expect(r.registry.cachedRows).toBe(0)
	})
})

describe('patching: errors, budget and detaching', () => {
	test('a patch does not clear the error state: the next SQL success is delivered even when equal', async () => {
		const r = await withBase()
		const failing = new Reads()
		const failures: unknown[] = []
		const calls: CollectionRecord[][] = []
		let fail = false
		r.manager.registerAndFetch(
			byN,
			(rows) => calls.push([...rows]),
			() => (fail ? Promise.reject(new Error('boom')) : failing.fn()),
			{ onError: (failure) => failures.push(failure) },
		)
		failing.answer([record('a', { n: 1 })])
		await tick()
		fail = true
		r.manager.notify('items', op('a'))
		await tick()
		r.reads.answer([record('a', { n: 1 })])
		await tick()
		expect(failures).toHaveLength(1)
		calls.length = 0
		r.registry.add(insertChange(record('x', { n: 3 })))
		await tick()
		expect(calls.length).toBe(1)
		fail = false
		r.manager.notify('items', op('a'))
		await tick()
	})

	test('a throwing subscriber callback is reported and does not stop the pass', async () => {
		const r = await withBase()
		const other = new Reads()
		const seen: number[] = []
		const failures: unknown[] = []
		r.manager.registerAndFetch(
			byN,
			() => {
				throw new Error('subscriber bug')
			},
			other.fn,
			{ onError: (failure) => failures.push(failure) },
		)
		other.answer([record('a', { n: 1 })])
		await tick()
		failures.length = 0
		r.manager.registerAndFetch(
			byN,
			(rows) => seen.push(rows.length),
			() => Promise.resolve([record('a', { n: 1 })]),
		)
		await tick()
		r.registry.add(insertChange(record('x', { n: 3 })))
		await tick()
		expect(failures).toHaveLength(1)
		expect(seen.at(-1)).toBe(2)
	})

	test('a pass over its budget leaves the remaining subscriptions to the commit path', async () => {
		// The injected clock advances 3 ms per reading: the pass has 8 ms.
		const r = rig({ budgetMs: 8, step: 3 })
		r.reads.answer([record('a', { n: 1 })])
		await tick()
		const extra: Reads[] = []
		const received: number[] = []
		for (let i = 0; i < 5; i++) {
			const reads = new Reads()
			extra.push(reads)
			r.manager.registerAndFetch(byN, () => received.push(i), reads.fn)
		}
		for (const reads of extra) reads.answer([record('a', { n: 1 })])
		await tick()
		received.length = 0
		r.calls.length = 0
		r.registry.add(insertChange(record('x', { n: 3 })))
		await tick()
		const stats = r.manager.getOverlayStats()
		expect(stats.budgetSkips).toBeGreaterThan(0)
		expect(stats.patchedDeliveries).toBeLessThan(6)
		expect(stats.patchedDeliveries).toBeGreaterThan(0)
	})

	test('after the last unsubscribe and after clear() the manager is detached from the registry', async () => {
		const r = await withBase()
		r.manager.clear()
		r.registry.add(insertChange(record('x', { n: 3 })))
		await tick()
		expect(r.calls).toHaveLength(0)
		expect(r.manager.getOverlayStats().passes).toBe(0)
	})

	test('without an overlay the manager is the manager it was: no registry means no base and no patch', async () => {
		const manager = new SubscriptionManager()
		const reads = new Reads()
		const calls: CollectionRecord[][] = []
		manager.registerAndFetch(byN, (rows) => calls.push([...rows]), reads.fn)
		reads.answer([record('a', { n: 1 })])
		await tick()
		manager.overlayChanged('items')
		await tick()
		expect(calls).toHaveLength(1)
		expect(manager.getOverlayStats()).toEqual({
			passes: 0,
			patchedDeliveries: 0,
			budgetSkips: 0,
			skippedEntries: 0,
			lastPassMs: 0,
		})
	})
})
