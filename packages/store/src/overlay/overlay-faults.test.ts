import { defineSchema, t } from '@korajs/core'
import type { KoraEvent, Operation } from '@korajs/core'
import { OperationTooLargeError } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { BridgeTerminatedError, OverlayDivergedError, WriteNotDurableError } from '../errors'
import { Store } from '../store/store'
import type { CollectionRecord, Transaction } from '../types'
import type { OverlayController, OverlayControllerInternals } from './overlay-controller'
import type { PendingWrites } from './pending-writes'
import { GatedAdapter, quiesce } from './test-support'

/*
 * Instant-UI S4: the fault-injection matrix (design 12.3), the failure matrix of section 7,
 * the lifecycle (clear points, caps, the breaker, the settle check) and the per-write
 * `durable` option, all through the real Store with a controllable adapter. Every wait is a
 * count of event-loop turns or a fake clock: no real sleeps.
 */

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				done: t.boolean().default(false),
				n: t.number().default(0),
			},
		},
		owners: { fields: { name: t.string() } },
		pets: { fields: { name: t.string(), ownerId: t.string().optional() } },
	},
	relations: {
		petOwner: {
			from: 'pets',
			to: 'owners',
			type: 'many-to-one',
			field: 'ownerId',
			onDelete: 'restrict',
		},
	},
})

// --- fault injection ---

type Fault =
	/** The transaction is refused before BEGIN. */
	| { readonly kind: 'before-begin'; readonly error: Error }
	/** The write's `after`+1th statement fails (a statement error, quota, a terminated bridge). */
	| { readonly kind: 'statement'; readonly after: number; readonly error: Error }
	/** COMMIT fails and nothing landed. */
	| { readonly kind: 'commit-lost'; readonly error: Error }
	/** COMMIT landed but its answer is an error (a leader change cut the reply). */
	| { readonly kind: 'commit-landed'; readonly error: Error }
	/** Only counts the statements of the write. */
	| { readonly kind: 'count' }

/**
 * better-sqlite3 with one-shot faults. Reads of the operation log can be made to fail too
 * (the adapter still unavailable when the M2 lookup runs), and one query can be preceded by
 * a hook (to change the database underneath a live query's SQL re-run).
 */
class FaultAdapter extends BetterSqlite3Adapter {
	fault: Fault | null = null
	writeStatements = 0
	failLookups = false
	failBarrier = false
	barrier: Promise<void> | null = null
	beforeNextTodoQuery: (() => Promise<void>) | null = null

	override async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		const fault = this.fault
		if (!fault) return super.transaction(fn)
		this.fault = null
		switch (fault.kind) {
			case 'before-begin':
				throw fault.error
			case 'count': {
				this.writeStatements = 0
				return super.transaction((tx) => fn(this.wrap(tx, Number.POSITIVE_INFINITY, null)))
			}
			case 'statement':
				return super.transaction((tx) => fn(this.wrap(tx, fault.after, fault.error)))
			case 'commit-lost':
				return super.transaction(async (tx) => {
					await fn(tx)
					throw fault.error
				})
			case 'commit-landed':
				await super.transaction(fn)
				throw fault.error
		}
	}

	override async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		if (this.failLookups && sql.includes('_kora_ops_')) throw new Error('injected: log unreadable')
		const hook = this.beforeNextTodoQuery
		if (hook && /FROM\s+"?todos"?/i.test(sql) && !sql.includes('_kora_')) {
			this.beforeNextTodoQuery = null
			await hook()
		}
		return super.query<T>(sql, params)
	}

	async ensureDurable(): Promise<void> {
		if (this.failBarrier) throw new Error('injected: barrier failed')
		if (this.barrier) await this.barrier
	}

	private wrap(tx: Transaction, after: number, error: Error | null): Transaction {
		let seen = 0
		return {
			execute: async (sql, params) => {
				seen++
				this.writeStatements = seen
				if (error && seen > after) throw error
				return tx.execute(sql, params)
			},
			query: (sql, params) => tx.query(sql, params),
		}
	}
}

// --- harness ---

const OVERLAY_EVENTS = [
	'store:write-pending',
	'store:write-settled',
	'store:overlay-diverged',
	'store:overlay-disabled',
	'store:quota-exceeded',
	'store:write-durability',
	'query:patched',
] as const

interface Harness {
	store: Store
	controller: OverlayController
	registry: PendingWrites
	created: Operation[]
	events: KoraEvent[]
	/** Last result of the subscription on all todos (id order). */
	seen: { rows: CollectionRecord[] }
	rollbacks: Array<{ writeId: string; error: unknown }>
	raised: Error[]
}

async function open(
	adapter: BetterSqlite3Adapter,
	internals: OverlayControllerInternals = {},
	options: {
		limits?: { maxPendingWrites?: number; maxRecordsPerWrite?: number }
		maxOperationBytes?: number
		subscribe?: boolean
	} = {},
): Promise<Harness> {
	const emitter = new SimpleEventEmitter()
	const created: Operation[] = []
	const events: KoraEvent[] = []
	const raised: Error[] = []
	emitter.on('operation:created', (event) => created.push(event.operation))
	for (const type of OVERLAY_EVENTS) emitter.on(type, (event) => events.push(event))
	const store = new Store({
		schema,
		adapter,
		nodeId: 'fault-node',
		emitter,
		instantUpdates: options.limits ?? true,
		// Strict (a divergence raises) like every test build, but collected, not thrown.
		instantUpdatesInternals: { strict: true, raise: (error) => raised.push(error), ...internals },
		...(options.maxOperationBytes !== undefined
			? { maxOperationBytes: options.maxOperationBytes }
			: {}),
	})
	await store.open()
	const controller = store.getOverlayController()
	if (!controller) throw new Error('the store was built without an overlay')
	const seen = { rows: [] as CollectionRecord[] }
	if (options.subscribe !== false) {
		store
			.collection('todos')
			.where({})
			.orderBy('id', 'asc')
			.subscribe((rows) => {
				seen.rows = [...rows]
			})
	}
	const rollbacks: Array<{ writeId: string; error: unknown }> = []
	controller.onRollback((info) => rollbacks.push({ writeId: info.writeId, error: info.error }))
	await quiesce()
	return {
		store,
		controller,
		registry: controller.registry,
		created,
		events,
		seen,
		rollbacks,
		raised,
	}
}

const labels = (events: readonly KoraEvent[]): string[] =>
	events.map((event) =>
		event.type === 'store:write-settled' ? `${event.type}:${event.outcome}` : event.type,
	)

const titles = (rows: readonly CollectionRecord[]): string[] => rows.map((row) => String(row.title))

async function until(done: () => boolean, turns = 5000): Promise<void> {
	for (let i = 0; i < turns && !done(); i++) await quiesce()
	// A bounded wait that silently gave up made slow runners fail later, on an unrelated
	// assertion. Fail here, naming the cause.
	if (!done()) throw new Error(`until(): condition not reached after ${turns} event-loop turns`)
}

/** The settled state: what the subscription shows is what a fresh query returns. */
async function expectDisplayedEqualsStored(h: Harness): Promise<void> {
	const stored = await h.store.collection('todos').where({}).orderBy('id', 'asc').exec()
	expect(h.seen.rows).toEqual(stored)
}

async function opCount(adapter: BetterSqlite3Adapter): Promise<number> {
	const rows = await adapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM _kora_ops_todos')
	return rows[0]?.n ?? 0
}

const harnesses: Harness[] = []
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.store.close().catch(() => {})
})

async function make(
	adapter: BetterSqlite3Adapter,
	internals?: OverlayControllerInternals,
	options?: Parameters<typeof open>[2],
): Promise<Harness> {
	const h = await open(adapter, internals, options)
	harnesses.push(h)
	return h
}

// --- the fault-injection matrix (design 12.3) ---

describe('fault injection: every point of a write', () => {
	type Kind = 'insert' | 'update' | 'delete'

	/** Seeds one stored record, arms the fault and runs one write. */
	async function run(
		kind: Kind,
		arm: (adapter: FaultAdapter) => void,
		internals?: OverlayControllerInternals,
	) {
		const adapter = new FaultAdapter(':memory:')
		const h = await make(adapter, internals)
		const seed = await h.store.collection('todos').insert({ title: 'seed' })
		await quiesce()
		h.created.length = 0
		h.events.length = 0
		const before = await opCount(adapter)
		arm(adapter)
		const todos = h.store.collection('todos')
		const write: Promise<unknown> =
			kind === 'insert'
				? todos.insert({ title: 'new' })
				: kind === 'update'
					? todos.update(seed.id, { title: 'changed' })
					: todos.delete(seed.id)
		const outcome = await write.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		)
		await until(() => h.registry.list().length === 0)
		await quiesce()
		return { adapter, h, seed, before, outcome }
	}

	const KINDS: readonly Kind[] = ['insert', 'update', 'delete']

	for (const kind of KINDS) {
		describe(kind, () => {
			test('refused before BEGIN: rejects, the row never sticks, nothing is published', async () => {
				const error = new Error('injected: refused')
				const { h, adapter, before, outcome } = await run(kind, (a) => {
					a.fault = { kind: 'before-begin', error }
				})
				expect(outcome.ok).toBe(false)
				if (!outcome.ok) expect(outcome.error).toBe(error)
				expect(h.created).toEqual([])
				expect(await opCount(adapter)).toBe(before)
				expect(h.registry.list()).toEqual([])
				expect(h.controller.pending).toBe(0)
				expect(labels(h.events)).toContain('store:write-settled:rolled-back')
				expect(h.rollbacks).toHaveLength(1)
				await expectDisplayedEqualsStored(h)
			})

			test('fails after EVERY statement of the write: always a clean rollback', async () => {
				const counting = new FaultAdapter(':memory:')
				const probe = await make(counting)
				const seed = await probe.store.collection('todos').insert({ title: 'seed' })
				counting.fault = { kind: 'count' }
				const todos = probe.store.collection('todos')
				if (kind === 'insert') await todos.insert({ title: 'x' })
				else if (kind === 'update') await todos.update(seed.id, { title: 'x' })
				else await todos.delete(seed.id)
				const statements = counting.writeStatements
				expect(statements).toBeGreaterThan(1)
				for (let after = 0; after < statements; after++) {
					const error = new Error(`injected: statement ${after + 1}`)
					const { h, adapter, before, outcome } = await run(kind, (a) => {
						a.fault = { kind: 'statement', after, error }
					})
					expect(outcome.ok, `after ${after} statements`).toBe(false)
					if (!outcome.ok) expect(outcome.error).toBe(error)
					expect(h.created, `after ${after} statements`).toEqual([])
					expect(await opCount(adapter), `after ${after} statements`).toBe(before)
					expect(h.registry.list(), `after ${after} statements`).toEqual([])
					expect(h.controller.pending).toBe(0)
					expect(h.raised).toEqual([])
					await expectDisplayedEqualsStored(h)
					await h.store.close()
				}
			})

			test('COMMIT not landed: the log is searched, the write is rolled back', async () => {
				const error = new Error('injected: commit lost')
				const { h, adapter, before, outcome } = await run(kind, (a) => {
					a.fault = { kind: 'commit-lost', error }
				})
				expect(outcome.ok).toBe(false)
				if (!outcome.ok) expect(outcome.error).toBe(error)
				expect(h.created).toEqual([])
				expect(await opCount(adapter)).toBe(before)
				expect(h.registry.list()).toEqual([])
				expect(labels(h.events)).toContain('store:write-settled:rolled-back')
				await expectDisplayedEqualsStored(h)
			})

			test('COMMIT landed but rejected (M2): the write is committed, published once, resolves', async () => {
				const error = new Error('injected: reply lost')
				const { h, adapter, before, outcome } = await run(kind, (a) => {
					a.fault = { kind: 'commit-landed', error }
				})
				expect(outcome.ok).toBe(true)
				expect(h.created).toHaveLength(1)
				expect(await opCount(adapter)).toBe(before + 1)
				expect(h.registry.list()).toEqual([])
				expect(labels(h.events)).toContain('store:write-settled:committed')
				expect(labels(h.events)).not.toContain('store:write-settled:rolled-back')
				expect(h.rollbacks).toEqual([])
				await expectDisplayedEqualsStored(h)
			})

			test('bridge terminated mid-transaction: retriable rejection, rolled back', async () => {
				const error = new BridgeTerminatedError('execute', 'leader changed')
				const { h, adapter, before, outcome } = await run(kind, (a) => {
					a.fault = { kind: 'statement', after: 1, error }
				})
				expect(outcome.ok).toBe(false)
				if (!outcome.ok) {
					expect(outcome.error).toBeInstanceOf(BridgeTerminatedError)
					expect((outcome.error as BridgeTerminatedError).context?.retriable).toBe(true)
				}
				expect(h.created).toEqual([])
				expect(await opCount(adapter)).toBe(before)
				expect(h.registry.list()).toEqual([])
				await expectDisplayedEqualsStored(h)
			})

			test('quota exceeded: rolled back and reported as quota', async () => {
				const error = Object.assign(new Error('The quota has been exceeded.'), {
					name: 'QuotaExceededError',
				})
				const { h, outcome } = await run(kind, (a) => {
					a.fault = { kind: 'statement', after: 1, error }
				})
				expect(outcome.ok).toBe(false)
				expect(labels(h.events)).toContain('store:quota-exceeded')
				expect(labels(h.events)).toContain('store:write-settled:rolled-back')
				expect(h.registry.list()).toEqual([])
				await expectDisplayedEqualsStored(h)
			})

			test('durability barrier fails after COMMIT: rejects WriteNotDurableError, the row stays', async () => {
				const { h, adapter, before, outcome } = await run(kind, (a) => {
					a.failBarrier = true
				})
				expect(outcome.ok).toBe(false)
				if (!outcome.ok) expect(outcome.error).toBeInstanceOf(WriteNotDurableError)
				// Committed: stored, published once, not rolled back.
				expect(h.created).toHaveLength(1)
				expect(await opCount(adapter)).toBe(before + 1)
				expect(labels(h.events)).toContain('store:write-settled:committed')
				expect(labels(h.events)).toContain('store:write-durability')
				expect(h.store.getWriteDurability().state).toBe('failing')
				expect(h.rollbacks).toEqual([])
				expect(h.registry.list()).toEqual([])
				await expectDisplayedEqualsStored(h)
			})
		})
	}
})

// --- section 7, the rows the matrix does not reach ---

describe('failure matrix rows (design section 7)', () => {
	test('success on the IndexedDB fallback: retired at COMMIT, the promise waits for the barrier', async () => {
		const adapter = new FaultAdapter(':memory:')
		const h = await make(adapter)
		let release: () => void = () => {}
		adapter.barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		let resolved = false
		const write = h.store
			.collection('todos')
			.insert({ title: 'fallback' })
			.then(() => {
				resolved = true
			})
		await until(() => labels(h.events).includes('store:write-settled:committed'))
		// Committed and published, shown, but the promise is not resolved before the barrier.
		expect(labels(h.events)).toContain('store:write-settled:committed')
		expect(h.created).toHaveLength(1)
		expect(resolved).toBe(false)
		expect(titles(h.seen.rows)).toEqual(['fallback'])
		release()
		await write
		expect(resolved).toBe(true)
		await until(() => h.registry.list().length === 0)
		await expectDisplayedEqualsStored(h)
	})

	test('refused before the transaction (validation, unknown field): nothing is ever shown', async () => {
		const adapter = new FaultAdapter(':memory:')
		const h = await make(adapter)
		await expect(h.store.collection('todos').insert({ done: true })).rejects.toThrow()
		await expect(h.store.collection('todos').insert({ title: 'x', nope: 1 })).rejects.toThrow()
		await quiesce()
		expect(labels(h.events)).toEqual([])
		expect(h.registry.list()).toEqual([])
		expect(h.seen.rows).toEqual([])
		expect(h.rollbacks).toEqual([])
	})

	test('an update of a record that does not exist rejects and is never shown (RecordNotFoundError)', async () => {
		const h = await make(new FaultAdapter(':memory:'))
		await expect(
			h.store.collection('todos').update('01900000-0000-7000-8000-000000000000', { title: 'x' }),
		).rejects.toThrow()
		await quiesce()
		expect(h.seen.rows).toEqual([])
		expect(h.registry.list()).toEqual([])
	})

	test('a state error inside the transaction (operation too large) rolls back', async () => {
		const adapter = new FaultAdapter(':memory:')
		const h = await make(adapter, undefined, { maxOperationBytes: 400 })
		await expect(
			h.store.collection('todos').insert({ title: 'x'.repeat(2_000) }),
		).rejects.toBeInstanceOf(OperationTooLargeError)
		await until(() => h.registry.list().length === 0)
		expect(h.created).toEqual([])
		expect(h.seen.rows).toEqual([])
		expect(h.controller.pending).toBe(0)
	})

	test('a restricted delete (referential integrity) rejects and the row is back', async () => {
		const adapter = new FaultAdapter(':memory:')
		const h = await make(adapter)
		const owner = await h.store.collection('owners').insert({ name: 'ann' })
		await h.store.collection('pets').insert({ name: 'rex', ownerId: owner.id })
		await quiesce()
		await expect(h.store.collection('owners').delete(owner.id)).rejects.toThrow()
		// Nothing subscribes to owners or pets, so their committed insert entries are released by
		// the time-based settle sweep, not by a result. What must hold is that the rejected delete
		// left nothing pending or unknown behind.
		await quiesce()
		expect(h.registry.list().filter((entry) => entry.state !== 'committed')).toEqual([])
		const stillThere = await h.store.collection('owners').where({}).exec()
		expect(stillThere.map((row) => row.name)).toEqual(['ann'])
	})

	test('transaction that never settles: after the TTL the write is unknown, then the commit decides', async () => {
		let clock = 0
		const adapter = new GatedAdapter(':memory:')
		const h = await make(adapter, {
			now: () => clock,
			pendingTtlMs: 1_000,
			// The sweep is driven by the test, never by a real timer.
			schedule: () => 0,
			cancel: () => {},
		})
		adapter.gating = true
		const write = h.store.collection('todos').insert({ title: 'slow' })
		await until(() => adapter.gates.length === 1)
		expect(titles(h.seen.rows)).toEqual(['slow'])
		clock = 999
		h.controller.sweep()
		expect(h.registry.list()[0]?.state).toBe('pending')
		clock = 1_000
		h.controller.sweep()
		expect(h.registry.list()[0]?.state).toBe('unknown')
		expect(labels(h.events)).toContain('store:write-settled:unknown')
		// Still shown: an unconfirmed write is never silently taken back.
		expect(titles(h.seen.rows)).toEqual(['slow'])
		adapter.gates.shift()?.release()
		await write
		await until(() => h.registry.list().length === 0)
		expect(labels(h.events)).toContain('store:write-settled:committed')
		expect(h.controller.pending).toBe(0)
		await expectDisplayedEqualsStored(h)
	})

	test('a hung transaction that then fails is rolled back out of the unknown state', async () => {
		let clock = 0
		const adapter = new GatedAdapter(':memory:')
		const h = await make(adapter, {
			now: () => clock,
			pendingTtlMs: 1_000,
			schedule: () => 0,
			cancel: () => {},
		})
		adapter.gating = true
		const write = h.store.collection('todos').insert({ title: 'doomed' })
		await until(() => adapter.gates.length === 1)
		clock = 5_000
		h.controller.sweep()
		expect(h.registry.list()[0]?.state).toBe('unknown')
		const settled = write.then(
			() => 'resolved',
			() => 'rejected',
		)
		adapter.gates.shift()?.fail()
		expect(await settled).toBe('rejected')
		await until(() => h.registry.list().length === 0)
		expect(labels(h.events)).toContain('store:write-settled:rolled-back')
		expect(h.seen.rows).toEqual([])
	})
})

describe('commit outcome unknown (M2) when the log cannot be read at once', () => {
	test('lost COMMIT, log unreadable: stays shown as unknown; the next successful read finds it absent and rolls it back', async () => {
		const adapter = new FaultAdapter(':memory:')
		const h = await make(adapter)
		adapter.failLookups = true
		adapter.fault = { kind: 'commit-lost', error: new Error('injected: commit lost') }
		await expect(h.store.collection('todos').insert({ title: 'maybe' })).rejects.toThrow()
		await quiesce()
		expect(h.registry.list()[0]?.state).toBe('unknown')
		expect(labels(h.events)).toContain('store:write-settled:unknown')
		expect(titles(h.seen.rows)).toEqual(['maybe'])
		expect(h.rollbacks).toEqual([])
		// The adapter answers again; any successful read of the collection decides it.
		adapter.failLookups = false
		h.store
			.collection('todos')
			.where({ done: false })
			.subscribe(() => {})
		await until(() => h.registry.list().length === 0)
		expect(labels(h.events)).toContain('store:write-settled:rolled-back')
		expect(h.rollbacks).toHaveLength(1)
		expect(h.seen.rows).toEqual([])
		await expectDisplayedEqualsStored(h)
	})

	test('landed COMMIT, log unreadable: stays shown as unknown; the next successful read finds it and commits it', async () => {
		const adapter = new FaultAdapter(':memory:')
		const h = await make(adapter)
		adapter.failLookups = true
		adapter.fault = { kind: 'commit-landed', error: new Error('injected: reply lost') }
		await expect(h.store.collection('todos').insert({ title: 'landed' })).rejects.toThrow()
		await quiesce()
		expect(h.registry.list()[0]?.state).toBe('unknown')
		adapter.failLookups = false
		h.store
			.collection('todos')
			.where({ done: false })
			.subscribe(() => {})
		await until(() => h.registry.list().length === 0)
		expect(labels(h.events)).toContain('store:write-settled:committed')
		expect(h.rollbacks).toEqual([])
		expect(titles(h.seen.rows)).toEqual(['landed'])
		await expectDisplayedEqualsStored(h)
	})
})

// --- same-record chains ---

describe('same-record chains without awaits', () => {
	test('insert, update, update, delete: a middle rollback takes its dependents, the insert survives', async () => {
		const adapter = new GatedAdapter(':memory:')
		const h = await make(adapter)
		adapter.gating = true
		const todos = h.store.collection('todos')
		const insert = todos.insert({ title: 'a' })
		await until(() => adapter.gates.length === 1)
		const id = h.registry.list()[0]?.recordId ?? ''
		const first = todos.update(id, { title: 'b' })
		const second = todos.update(id, { title: 'c' })
		const remove = todos.delete(id)
		await until(() => adapter.gates.length === 4)
		expect(h.seen.rows).toEqual([])
		const outcomes = Promise.allSettled([insert, first, second, remove])
		// Commit the insert, fail the first update.
		adapter.gates[0]?.release()
		await quiesce()
		adapter.gates[1]?.fail()
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		const settled = await outcomes
		expect(settled.map((one) => one.status)[0]).toBe('fulfilled')
		expect(settled.map((one) => one.status)[1]).toBe('rejected')
		await until(() => h.registry.list().length === 0)
		await expectDisplayedEqualsStored(h)
		expect(h.controller.pending).toBe(0)
		expect(h.raised).toEqual([])
	})

	test('five un-awaited updates of one record all commit and the display ends equal to the database', async () => {
		const adapter = new GatedAdapter(':memory:')
		const h = await make(adapter)
		const record = await h.store.collection('todos').insert({ title: 't0', n: 0 })
		await quiesce()
		adapter.gating = true
		adapter.autoRelease = true
		const writes: Array<Promise<unknown>> = []
		for (let i = 1; i <= 5; i++) {
			writes.push(h.store.collection('todos').update(record.id, { n: i, title: `t${i}` }))
		}
		await Promise.all(writes)
		await until(() => h.registry.list().length === 0)
		expect(h.seen.rows[0]?.title).toBe('t5')
		await expectDisplayedEqualsStored(h)
		expect(h.raised).toEqual([])
	})
})

// --- the clear points (I12) ---

describe('the overlay is cleared with the data it described (I12)', () => {
	/** A write held before its commit, shown, with the gate still closed. */
	async function holdOne() {
		const adapter = new GatedAdapter(':memory:')
		const h = await make(adapter)
		adapter.gating = true
		const write = h.store.collection('todos').insert({ title: 'in flight' })
		await until(() => adapter.gates.length === 1)
		expect(titles(h.seen.rows)).toEqual(['in flight'])
		return { adapter, h, write }
	}

	/** A committed write whose settle never ran: no subscription, so its entry lingers. */
	async function lingering() {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const h = await make(adapter, undefined, { subscribe: false })
		await h.store.collection('todos').insert({ title: 'committed' })
		expect(h.registry.list().length).toBeGreaterThan(0)
		return { adapter, h }
	}

	test('sign-out drops pending writes before anything re-runs', async () => {
		const { adapter, h, write } = await holdOne()
		h.store.clearSignedInUser()
		expect(h.registry.list()).toEqual([])
		adapter.gates.shift()?.release()
		await write
		await quiesce()
		expect(h.raised).toEqual([])
	})

	test("a different signed-in user starts without the previous user's pending writes", async () => {
		const { adapter, h, write } = await lingering().then(async (state) => ({
			...state,
			write: Promise.resolve(),
		}))
		await h.store.bindPrincipal('user-a')
		expect(h.registry.list().length).toBeGreaterThan(0) // the first user: nothing to drop
		await h.store.bindPrincipal('user-b')
		expect(h.registry.list()).toEqual([])
		await write
		expect(adapter).toBeDefined()
	})

	test('reloadFromDisk clears the overlay', async () => {
		const { h } = await lingering()
		await h.store.reloadFromDisk()
		expect(h.registry.list()).toEqual([])
	})

	test('a backup restore clears the overlay', async () => {
		const { h } = await lingering()
		const backup = await h.store.exportBackup()
		await h.store.collection('todos').insert({ title: 'after the backup' })
		expect(h.registry.list().length).toBeGreaterThan(0)
		await h.store.importBackup(backup)
		expect(h.registry.list()).toEqual([])
	})

	test('a delivery watermark going back to 0 (full resync) clears the overlay; moving forward does not', async () => {
		const { h } = await lingering()
		await h.store.saveDeliveryWatermark('view', 10)
		await h.store.saveDeliveryWatermark('view', 20)
		expect(h.registry.list().length).toBeGreaterThan(0)
		await h.store.saveDeliveryWatermark('view', 0)
		expect(h.registry.list()).toEqual([])
	})

	test('closing the store forgets pending writes and schedules nothing more', async () => {
		const { adapter, h, write } = await holdOne()
		const closing = h.store.close()
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		await write.catch(() => {})
		await closing
		expect(h.registry.list()).toEqual([])
	})

	test('a write committing after the overlay was cleared finds no entry and changes nothing', async () => {
		const { adapter, h, write } = await holdOne()
		h.controller.clear()
		adapter.gates.shift()?.release()
		await write
		await until(() => h.seen.rows.length === 1)
		expect(h.registry.list()).toEqual([])
		await expectDisplayedEqualsStored(h)
		expect(h.raised).toEqual([])
	})
})

// --- caps (I8), insertMany, the durable option ---

describe('caps degrade to waiting for the commit, never to an error', () => {
	test('past maxPendingWrites a write is not shown early, still works, and says why', async () => {
		const adapter = new GatedAdapter(':memory:')
		const h = await make(adapter, undefined, { limits: { maxPendingWrites: 2 } })
		adapter.gating = true
		const todos = h.store.collection('todos')
		const writes = [
			todos.insert({ title: 'one' }),
			todos.insert({ title: 'two' }),
			todos.insert({ title: 'three' }),
		]
		await until(() => adapter.gates.length === 3)
		expect(titles(h.seen.rows).sort()).toEqual(['one', 'two'])
		const pending = h.events.flatMap((event) =>
			event.type === 'store:write-pending' ? [event] : [],
		)
		expect(pending.map((event) => event.predicted)).toEqual([true, true, false])
		expect(pending[2]?.predicted === false ? pending[2].reason : null).toBe('pending-cap')
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		await Promise.all(writes)
		await until(() => h.registry.list().length === 0)
		expect(titles(h.seen.rows).sort()).toEqual(['one', 'three', 'two'])
		expect(h.raised).toEqual([])
	})

	test('insertMany within the record cap is shown at once, one entry per record, one transaction', async () => {
		const adapter = new GatedAdapter(':memory:')
		const h = await make(adapter)
		adapter.gating = true
		const write = h.store
			.collection('todos')
			.insertMany([{ title: 'a' }, { title: 'b' }, { title: 'c' }])
		await until(() => adapter.gates.length === 1)
		expect(adapter.gates).toHaveLength(1)
		expect(titles(h.seen.rows).sort()).toEqual(['a', 'b', 'c'])
		expect(h.registry.list()).toHaveLength(3)
		expect(h.controller.pending).toBe(3)
		adapter.gates.shift()?.release()
		const rows = await write
		expect(rows).toHaveLength(3)
		await until(() => h.registry.list().length === 0)
		expect(h.created).toHaveLength(3)
		await expectDisplayedEqualsStored(h)
	})

	test('insertMany over maxRecordsPerWrite waits for the commit', async () => {
		const adapter = new GatedAdapter(':memory:')
		const h = await make(adapter, undefined, { limits: { maxRecordsPerWrite: 2 } })
		adapter.gating = true
		const write = h.store
			.collection('todos')
			.insertMany([{ title: 'a' }, { title: 'b' }, { title: 'c' }])
		await until(() => adapter.gates.length === 1)
		expect(h.seen.rows).toEqual([])
		const miss = h.events.find((event) => event.type === 'store:write-pending')
		expect(miss?.type === 'store:write-pending' ? miss.predicted : null).toBe(false)
		expect(miss?.type === 'store:write-pending' ? miss.reason : null).toBe('records-cap')
		adapter.gates.shift()?.release()
		await write
		await until(() => h.seen.rows.length === 3)
		await expectDisplayedEqualsStored(h)
	})

	test('insertMany that fails rolls back every record together', async () => {
		const adapter = new FaultAdapter(':memory:')
		const h = await make(adapter)
		adapter.fault = { kind: 'statement', after: 3, error: new Error('injected: statement') }
		await expect(
			h.store.collection('todos').insertMany([{ title: 'a' }, { title: 'b' }]),
		).rejects.toThrow()
		await until(() => h.registry.list().length === 0)
		expect(h.seen.rows).toEqual([])
		expect(h.created).toEqual([])
		expect(h.rollbacks).toHaveLength(2)
	})
})

describe('{ durable: true } on every write kind', () => {
	test('insert, insertMany, update and delete through Store.collection are shown only at commit', async () => {
		const adapter = new GatedAdapter(':memory:')
		const h = await make(adapter)
		const seed = await h.store.collection('todos').insert({ title: 'seed' })
		await until(() => h.registry.list().length === 0)
		adapter.gating = true
		const todos = h.store.collection('todos')

		const insert = todos.insert({ title: 'later' }, { durable: true })
		await until(() => adapter.gates.length === 1)
		expect(titles(h.seen.rows)).toEqual(['seed'])
		adapter.gates.shift()?.release()
		await insert
		await until(() => titles(h.seen.rows).length === 2)

		const many = todos.insertMany([{ title: 'm1' }, { title: 'm2' }], { durable: true })
		await until(() => adapter.gates.length === 1)
		expect(h.seen.rows).toHaveLength(2)
		adapter.gates.shift()?.release()
		await many
		await until(() => h.seen.rows.length === 4)

		const update = todos.update(seed.id, { title: 'seed 2' }, { durable: true })
		await until(() => adapter.gates.length === 1)
		expect(titles(h.seen.rows)).toContain('seed')
		adapter.gates.shift()?.release()
		await update
		await until(() => titles(h.seen.rows).includes('seed 2'))

		const remove = todos.delete(seed.id, { durable: true })
		await until(() => adapter.gates.length === 1)
		expect(h.seen.rows).toHaveLength(4)
		adapter.gates.shift()?.release()
		await remove
		await until(() => h.seen.rows.length === 3)

		const pending = h.events.flatMap((event) =>
			event.type === 'store:write-pending' ? [event] : [],
		)
		const durableMisses = pending.filter(
			(event) => event.predicted === false && event.reason === 'durable-option',
		)
		expect(durableMisses).toHaveLength(4)
		await expectDisplayedEqualsStored(h)
		expect(h.raised).toEqual([])
	})

	test('the same writes without the option are shown before the commit', async () => {
		const adapter = new GatedAdapter(':memory:')
		const h = await make(adapter)
		adapter.gating = true
		const write = h.store.collection('todos').insert({ title: 'early' })
		await until(() => adapter.gates.length === 1)
		expect(titles(h.seen.rows)).toEqual(['early'])
		adapter.gates.shift()?.release()
		await write
	})
})

// --- the circuit breaker (I10), strict mode, the settle check ---

describe('self-check and circuit breaker (I10)', () => {
	/** An update whose base the (deliberately wrong) reader reports with a stale number. */
	async function wrongUpdate(h: Harness, id: string, title: string) {
		await h.store.collection('todos').update(id, { title })
		await until(() => h.registry.list().length === 0)
	}

	test('three wrong predictions switch prediction off for the collection; the fourth write is not predicted', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const h = await make(adapter, {
			// Wrong on purpose: the stored row has n = 0.
			readRecord: async (_ctx, _collection, id) => ({
				id,
				title: 'stale',
				done: false,
				n: 999,
				createdAt: 1,
				updatedAt: 1,
			}),
			strict: false,
		})
		const ids: string[] = []
		for (let i = 0; i < 4; i++) {
			const row = await h.store.collection('todos').insert({ title: `r${i}` })
			ids.push(row.id)
			h.registry.invalidate('todos')
		}
		await until(() => h.registry.list().length === 0)
		h.events.length = 0
		for (let i = 0; i < 3; i++) {
			h.registry.invalidate('todos')
			await wrongUpdate(h, ids[i] ?? '', `wrong ${i}`)
		}
		const diverged = h.events.filter((event) => event.type === 'store:overlay-diverged')
		expect(diverged).toHaveLength(3)
		expect(diverged[0]?.type === 'store:overlay-diverged' ? diverged[0].fields : []).toContain('n')
		const disabled = h.events.filter((event) => event.type === 'store:overlay-disabled')
		expect(disabled).toHaveLength(1)
		expect(h.controller.isDisabled('todos')).toBe(true)

		h.events.length = 0
		await h.store.collection('todos').insert({ title: 'unpredicted now' })
		const pending = h.events.find((event) => event.type === 'store:write-pending')
		expect(pending?.type === 'store:write-pending' ? pending.predicted : null).toBe(false)
		expect(pending?.type === 'store:write-pending' ? pending.reason : null).toBe(
			'collection-disabled',
		)
		// The data is untouched by any of it.
		const stored = await h.store.collection('todos').where({}).exec()
		expect(stored).toHaveLength(5)
	})

	test('in a test build a divergence raises OverlayDivergedError (it is never swallowed)', async () => {
		const h = await make(new BetterSqlite3Adapter(':memory:'), {
			readRecord: async (_ctx, _collection, id) => ({
				id,
				title: 'stale',
				done: false,
				n: 999,
				createdAt: 1,
				updatedAt: 1,
			}),
		})
		const row = await h.store.collection('todos').insert({ title: 'r' })
		await until(() => h.registry.list().length === 0)
		h.registry.invalidate('todos')
		await h.store.collection('todos').update(row.id, { title: 'r2' })
		await until(() => h.registry.list().length === 0)
		expect(h.raised).toHaveLength(1)
		expect(h.raised[0]).toBeInstanceOf(OverlayDivergedError)
		expect((h.raised[0] as OverlayDivergedError).code).toBe('OVERLAY_DIVERGED')
		expect((h.raised[0] as OverlayDivergedError).fields).toContain('n')
	})

	test('a divergence is reported once per write, not once per subscription', async () => {
		const h = await make(new BetterSqlite3Adapter(':memory:'), {
			readRecord: async (_ctx, _collection, id) => ({
				id,
				title: 'stale',
				done: false,
				n: 999,
				createdAt: 1,
				updatedAt: 1,
			}),
			strict: false,
		})
		for (let i = 0; i < 3; i++) {
			h.store
				.collection('todos')
				.where({})
				.subscribe(() => {})
		}
		const row = await h.store.collection('todos').insert({ title: 'r' })
		await until(() => h.registry.list().length === 0)
		h.registry.invalidate('todos')
		h.events.length = 0
		await h.store.collection('todos').update(row.id, { title: 'r2' })
		await until(() => h.registry.list().length === 0)
		expect(h.events.filter((event) => event.type === 'store:overlay-diverged')).toHaveLength(1)
	})

	test('the settle check: a database that disagrees with the prediction at the SQL re-run is reported', async () => {
		const adapter = new FaultAdapter(':memory:')
		const h = await make(adapter, { strict: false })
		const row = await h.store.collection('todos').insert({ title: 'r', done: false })
		await until(() => h.registry.list().length === 0)
		h.events.length = 0
		// Underneath the live query, between the commit and its SQL re-run.
		adapter.beforeNextTodoQuery = async () => {
			await adapter.execute('UPDATE "todos" SET "done" = 0 WHERE "id" = ?', [row.id])
		}
		await h.store.collection('todos').update(row.id, { done: true })
		await until(() => h.registry.list().length === 0)
		const diverged = h.events.filter((event) => event.type === 'store:overlay-diverged')
		expect(diverged).toHaveLength(1)
		expect(diverged[0]?.type === 'store:overlay-diverged' ? diverged[0].fields : []).toEqual([
			'done',
		])
	})

	test('a clean workload reports nothing', async () => {
		const adapter = new GatedAdapter(':memory:')
		const h = await make(adapter)
		adapter.gating = true
		adapter.autoRelease = true
		const todos = h.store.collection('todos')
		const a = await todos.insert({ title: 'a', n: 1 })
		await todos.update(a.id, { n: 2 })
		await todos.insert({ title: 'b' })
		await todos.delete(a.id)
		await until(() => h.registry.list().length === 0)
		expect(h.events.filter((event) => event.type === 'store:overlay-diverged')).toEqual([])
		expect(h.raised).toEqual([])
		await expectDisplayedEqualsStored(h)
	})
})

// --- events, the pending count, onRollback ---

describe('events and the internal pending / onRollback surface', () => {
	test('a shown write emits write-pending, a patched delivery, then write-settled; the count follows', async () => {
		const adapter = new GatedAdapter(':memory:')
		const h = await make(adapter)
		adapter.gating = true
		expect(h.controller.pending).toBe(0)
		const write = h.store.collection('todos').insert({ title: 'e' })
		await until(() => adapter.gates.length === 1)
		expect(h.controller.pending).toBe(1)
		const order = labels(h.events)
		expect(order.indexOf('store:write-pending')).toBeGreaterThanOrEqual(0)
		const patched = h.events.find((event) => event.type === 'query:patched')
		expect(patched?.type === 'query:patched' ? patched.collection : null).toBe('todos')
		expect(patched?.type === 'query:patched' ? patched.resultCount : null).toBe(1)
		expect(order.indexOf('query:patched')).toBeGreaterThan(order.indexOf('store:write-pending'))
		expect(order).not.toContain('store:write-settled:committed')
		adapter.gates.shift()?.release()
		await write
		await until(() => h.registry.list().length === 0)
		expect(h.controller.pending).toBe(0)
		const settled = h.events.find((event) => event.type === 'store:write-settled')
		expect(settled?.type === 'store:write-settled' ? settled.outcome : null).toBe('committed')
		expect(settled?.type === 'store:write-settled' ? settled.operationIds : []).toHaveLength(1)
	})

	test('onRollback hears the error of a rolled-back write and unsubscribes', async () => {
		const adapter = new FaultAdapter(':memory:')
		const h = await make(adapter)
		const heard: unknown[] = []
		const off = h.controller.onRollback((info) => heard.push(info.error))
		const error = new Error('injected: statement')
		adapter.fault = { kind: 'statement', after: 1, error }
		await expect(h.store.collection('todos').insert({ title: 'x' })).rejects.toBe(error)
		await quiesce()
		expect(heard).toEqual([error])
		off()
		adapter.fault = { kind: 'statement', after: 1, error }
		await expect(h.store.collection('todos').insert({ title: 'y' })).rejects.toBe(error)
		await quiesce()
		expect(heard).toHaveLength(1)
	})

	test('a store without instantUpdates emits none of these events', async () => {
		const emitter = new SimpleEventEmitter()
		const seen: KoraEvent[] = []
		for (const type of OVERLAY_EVENTS) emitter.on(type, (event) => seen.push(event))
		const store = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'plain',
			emitter,
		})
		await store.open()
		store
			.collection('todos')
			.where({})
			.subscribe(() => {})
		await store.collection('todos').insert({ title: 'plain' })
		await quiesce()
		expect(seen).toEqual([])
		expect(store.getOverlayController()).toBeNull()
		await store.close()
	})
})
