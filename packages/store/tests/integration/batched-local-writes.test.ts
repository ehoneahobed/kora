/**
 * C3 (beta.15): batched local writes. The local write path buffers its statements
 * and sends them to the SQLite worker in batches (one message per batch), and
 * `insertMany` writes many records in one storage transaction. These tests pin
 * that every guarantee of the unbatched path still holds: one operation per
 * record with contiguous sequence numbers and increasing HLC timestamps, all or
 * nothing on failure, reads inside the write see its own statements, reactive
 * queries and other tabs see the committed result, and nothing is published for
 * a rolled-back write.
 */
import { HybridLogicalClock, type Operation, defineSchema, t } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { SqliteWasmAdapter } from '../../src/adapters/sqlite-wasm-adapter'
import type {
	WorkerBridge,
	WorkerRequest,
	WorkerResponse,
} from '../../src/adapters/sqlite-wasm-channel'
import { MockWorkerBridge } from '../../src/adapters/sqlite-wasm-mock-bridge'
import { Store } from '../../src/index'
import { FollowerBroadcastBridge, startLeaderRpcRelay } from '../../src/multi-tab/tab-storage'
import { WRITE_BEHIND_MAX_STATEMENTS } from '../../src/transaction/write-behind'
import type { CollectionRecord, StorageAdapter } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
				rank: t.number().optional(),
			},
		},
		projects: {
			fields: { name: t.string() },
		},
	},
})

/** A bridge that records the request types it forwards (and can refuse `batch`). */
class CountingBridge implements WorkerBridge {
	readonly types: string[] = []
	constructor(
		private readonly inner: WorkerBridge,
		readonly options: { refuseBatch?: boolean; failOnSql?: string } = {},
	) {}
	async send(request: WorkerRequest): Promise<WorkerResponse> {
		this.types.push(request.type)
		if (request.type === 'batch' && this.options.refuseBatch) {
			return {
				id: request.id,
				type: 'error',
				message: 'Unknown request type',
				code: 'UNKNOWN_REQUEST',
			}
		}
		const fail = this.options.failOnSql
		if (fail !== undefined) {
			const statements =
				request.type === 'batch'
					? request.statements
					: request.type === 'execute'
						? [{ sql: request.sql }]
						: []
			const index = statements.findIndex((s) => s.sql.includes(fail))
			if (index !== -1) {
				return {
					id: request.id,
					type: 'error',
					message: `injected failure on ${fail}`,
					code: 'EXEC_ERROR',
					context: { index },
				}
			}
		}
		return this.inner.send(request)
	}
	terminate(): void {
		this.inner.terminate()
	}
	count(type: string): number {
		return this.types.filter((t) => t === type).length
	}
}

async function readOps(adapter: StorageAdapter, collection = 'todos') {
	return adapter.query<{
		id: string
		record_id: string
		sequence_number: number
		timestamp: string
		causal_deps: string
		data: string
	}>(
		`SELECT id, record_id, sequence_number, timestamp, causal_deps, data FROM _kora_ops_${collection} ORDER BY sequence_number`,
	)
}

describe.each([
	[
		'SqliteWasmAdapter (worker protocol, batched)',
		() => new SqliteWasmAdapter({ bridge: new MockWorkerBridge() }),
	],
	['BetterSqlite3Adapter (no executeBatch)', () => new BetterSqlite3Adapter(':memory:')],
])('batched local writes on %s', (_name, makeAdapter) => {
	let store: Store
	let adapter: StorageAdapter
	let published: Operation[]

	beforeEach(async () => {
		adapter = makeAdapter()
		store = new Store({ schema, adapter, nodeId: 'node-a' })
		await store.open()
		published = []
		store.onRecordsChanged((change) => {
			if (change.operation) published.push(change.operation)
		})
	})

	afterEach(async () => {
		await store.close()
	})

	test('insertMany writes one insert operation per record, in input order', async () => {
		const rows = Array.from({ length: 600 }, (_, i) => ({ title: `t${i}`, rank: i }))
		const records = await store.collection('todos').insertMany(rows)

		expect(records.map((r) => r.title)).toEqual(rows.map((r) => r.title))
		const ops = await readOps(adapter)
		expect(ops).toHaveLength(600)
		// Contiguous sequence numbers, record order = input order.
		expect(ops.map((o) => o.sequence_number)).toEqual(rows.map((_, i) => i + 1))
		expect(ops.map((o) => o.record_id)).toEqual(records.map((r) => r.id))
		// Strictly increasing HLC timestamps.
		for (let i = 1; i < ops.length; i++) {
			const prev = HybridLogicalClock.deserialize(ops[i - 1]?.timestamp ?? '')
			const next = HybridLogicalClock.deserialize(ops[i]?.timestamp ?? '')
			expect(HybridLogicalClock.compare(next, prev)).toBeGreaterThan(0)
		}
		// Each operation causally follows the previous one.
		for (let i = 1; i < ops.length; i++) {
			expect(JSON.parse(ops[i]?.causal_deps ?? '[]')).toContain(ops[i - 1]?.id)
		}
		// One shared transaction id.
		const txIds = new Set(ops.map((o) => JSON.parse(o.data).__kora_tx_id__))
		expect(txIds.size).toBe(1)
		expect([...txIds][0]).toEqual(expect.any(String))

		const stored = await store.collection('todos').where({}).exec()
		expect(stored).toHaveLength(600)
		// Published after commit, in order, once per operation.
		expect(published.map((op) => op.id)).toEqual(ops.map((o) => o.id))
	})

	test('insertMany validates every row first: an invalid row writes nothing', async () => {
		const rows: Record<string, unknown>[] = [{ title: 'ok' }, { title: 42 }, { title: 'also ok' }]
		await expect(store.collection('todos').insertMany(rows)).rejects.toThrow()
		expect(await readOps(adapter)).toHaveLength(0)
		expect(await store.collection('todos').where({}).exec()).toHaveLength(0)
		expect(published).toHaveLength(0)
	})

	test('insertMany with no rows is a no-op', async () => {
		expect(await store.collection('todos').insertMany([])).toEqual([])
		expect(await readOps(adapter)).toHaveLength(0)
	})

	test('later writes continue the sequence after an insertMany', async () => {
		await store.collection('todos').insertMany([{ title: 'a' }, { title: 'b' }])
		const single = await store.collection('todos').insert({ title: 'c' })
		await store.collection('todos').update(single.id, { completed: true })
		const ops = await readOps(adapter)
		expect(ops.map((o) => o.sequence_number)).toEqual([1, 2, 3, 4])
	})

	test('a reactive query is notified once with every inserted row', async () => {
		const results: CollectionRecord[][] = []
		const unsubscribe = store
			.collection('todos')
			.where({})
			.subscribe((rows) => results.push(rows))
		await vi.waitFor(() => expect(results.length).toBe(1))
		await store
			.collection('todos')
			.insertMany(Array.from({ length: 300 }, (_, i) => ({ title: `r${i}` })))
		await vi.waitFor(() => expect(results.at(-1)).toHaveLength(300))
		// No intermediate partial result: the initial [] then the full result.
		expect(results.map((r) => r.length)).toEqual([0, 300])
		unsubscribe()
	})

	test('store.transaction still commits every buffered write, larger than one batch', async () => {
		const n = WRITE_BEHIND_MAX_STATEMENTS * 2 + 7
		await store.transaction(async (tx) => {
			const todos = tx.collection('todos')
			for (let i = 0; i < n; i++) await todos.insert({ title: `x${i}` })
		})
		expect(await store.collection('todos').where({}).exec()).toHaveLength(n)
		expect((await readOps(adapter)).map((o) => o.sequence_number)).toEqual(
			Array.from({ length: n }, (_, i) => i + 1),
		)
	})

	test('reads inside a write see its own buffered statements (update after insert in one transaction)', async () => {
		await store.transaction(async (tx) => {
			const todos = tx.collection('todos')
			const a = await todos.insert({ title: 'a', rank: 1 })
			await todos.update(a.id, { rank: 2 })
			await todos.update(a.id, { title: 'b' })
		})
		const [row] = await store.collection('todos').where({}).exec()
		expect(row).toMatchObject({ title: 'b', rank: 2 })
	})

	test('beforeLocalDelete keeps await-execute semantics: a caught statement error does not abort the delete', async () => {
		const todo = await store.collection('todos').insert({ title: 'doomed' })
		const caught: unknown[] = []
		store.setLocalMutationHandler({
			insert: async () => {
				throw new Error('not used')
			},
			update: async () => {
				throw new Error('not used')
			},
			delete: async () => {
				throw new Error('not used')
			},
			async beforeLocalDelete(_operation, tx) {
				// An extension that tolerates an expected failure and carries on.
				try {
					await tx.execute('INSERT INTO _no_such_audit_table (id) VALUES (?)', [todo.id])
				} catch (error) {
					caught.push(error)
				}
				await tx.execute('UPDATE todos SET rank = 99 WHERE id = ? AND _deleted = 0', [todo.id])
			},
		})
		await store.transaction(async (tx) => {
			await tx.collection('todos').delete(todo.id)
		})
		store.setLocalMutationHandler(null)
		expect(caught).toHaveLength(1)
		expect(await store.collection('todos').findById(todo.id)).toBeNull()
	})
})

describe('batched local writes: atomicity and the worker protocol', () => {
	let store: Store | null = null
	afterEach(async () => {
		await store?.close()
		store = null
	})

	async function open(
		bridge: CountingBridge,
	): Promise<{ store: Store; adapter: SqliteWasmAdapter }> {
		const adapter = new SqliteWasmAdapter({ bridge })
		store = new Store({ schema, adapter, nodeId: 'node-a' })
		await store.open()
		bridge.types.length = 0
		return { store, adapter }
	}

	test('insertMany of 1,000 records is one transaction with a handful of worker messages', async () => {
		const bridge = new CountingBridge(new MockWorkerBridge())
		const { store: s } = await open(bridge)
		await s
			.collection('todos')
			.insertMany(Array.from({ length: 1000 }, (_, i) => ({ title: `t${i}` })))
		expect(bridge.count('begin')).toBe(1)
		expect(bridge.count('commit')).toBe(1)
		// 3 statements per insert (op row, fold state, row) in batches of 256, plus the
		// sequence reservation (a read) and the block end.
		expect(bridge.count('batch')).toBeLessThanOrEqual(
			Math.ceil(3001 / WRITE_BEHIND_MAX_STATEMENTS) + 1,
		)
		expect(bridge.count('execute')).toBe(0)
	})

	test('a single insert sends its writes in one batch (begin, reserve, batch, commit)', async () => {
		const bridge = new CountingBridge(new MockWorkerBridge())
		const { store: s } = await open(bridge)
		await s.collection('todos').insert({ title: 'one' })
		expect(bridge.types).toEqual(['begin', 'query', 'batch', 'commit'])
	})

	test('a statement failing in a later batch rolls the whole insertMany back and publishes nothing', async () => {
		// Fails the fold-state write of a record past the first batch.
		const bridge = new CountingBridge(new MockWorkerBridge())
		const { store: s, adapter } = await open(bridge)
		const published: Operation[] = []
		s.onRecordsChanged((change) => {
			if (change.operation) published.push(change.operation)
		})
		const rows = Array.from({ length: 500 }, (_, i) => ({ title: i === 400 ? 'poison' : `t${i}` }))
		// The row write of record 400 (past the first batch of 256 statements) fails.
		await adapter.execute(
			`CREATE TRIGGER poison BEFORE INSERT ON todos WHEN NEW.title = 'poison' BEGIN SELECT RAISE(ABORT, 'poisoned row'); END`,
		)
		await expect(s.collection('todos').insertMany(rows)).rejects.toThrow(/poisoned row/)
		expect(bridge.count('rollback')).toBe(1)
		expect(bridge.count('commit')).toBe(0)
		expect(await adapter.query('SELECT id FROM todos')).toHaveLength(0)
		expect(await adapter.query('SELECT id FROM _kora_ops_todos')).toHaveLength(0)
		expect(await adapter.query('SELECT * FROM _kora_fold_state')).toHaveLength(0)
		expect(published).toHaveLength(0)
		// The sequence block was rolled back with it: the next write starts at 1.
		await adapter.execute('DROP TRIGGER poison')
		await s.collection('todos').insert({ title: 'after' })
		expect(
			(
				await adapter.query<{ sequence_number: number }>(
					'SELECT sequence_number FROM _kora_ops_todos',
				)
			).map((r) => r.sequence_number),
		).toEqual([1])
	})

	test('a failing single insert rolls back and reports the failing statement', async () => {
		const bridge = new CountingBridge(new MockWorkerBridge())
		const { store: s, adapter } = await open(bridge)
		bridge.options.failOnSql = '_kora_fold_state'
		const error = await s
			.collection('todos')
			.insert({ title: 'x' })
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(Error)
		expect((error as { context?: { sql?: string } }).context?.sql).toContain('_kora_fold_state')
		expect(bridge.count('rollback')).toBe(1)
		bridge.options.failOnSql = undefined
		expect(await adapter.query('SELECT id FROM _kora_ops_todos')).toHaveLength(0)
	})

	test('a leader worker that does not know `batch` (older build) gets the statements one by one', async () => {
		// The older worker does not announce `batch` at open, so it is never sent one.
		const bridge = new CountingBridge(new MockWorkerBridge({ batch: false }))
		const { store: s } = await open(bridge)
		await s.collection('todos').insertMany([{ title: 'a' }, { title: 'b' }])
		await s.collection('todos').insert({ title: 'c' })
		expect(await s.collection('todos').where({}).exec()).toHaveLength(3)
		expect(bridge.count('batch')).toBe(0)
		expect(bridge.count('execute')).toBeGreaterThan(0)
	})

	test('a batch refused mid-transaction fails the write retriably and rolls it back', async () => {
		// The worker announced `batch` at open, then the leader became an older build.
		const bridge = new CountingBridge(new MockWorkerBridge())
		const { store: s, adapter } = await open(bridge)
		bridge.options.refuseBatch = true
		const error = await s
			.collection('todos')
			.insert({ title: 'x' })
			.catch((e: unknown) => e)
		expect((error as { code?: string }).code).toBe('BRIDGE_TERMINATED')
		expect(bridge.count('rollback')).toBe(1)
		bridge.options.refuseBatch = false
		expect(await adapter.query('SELECT id FROM _kora_ops_todos')).toHaveLength(0)
		// The retry goes statement by statement and succeeds.
		await s.collection('todos').insert({ title: 'x' })
		expect(await s.collection('todos').where({}).exec()).toHaveLength(1)
	})
})

describe('batched local writes across tabs', () => {
	type ChannelHandler = (event: { data: unknown }) => void
	class MockBroadcastChannel {
		static channels = new Map<string, Set<MockBroadcastChannel>>()
		private readonly handlers = new Set<ChannelHandler>()
		constructor(public readonly name: string) {
			const set = MockBroadcastChannel.channels.get(name) ?? new Set()
			set.add(this)
			MockBroadcastChannel.channels.set(name, set)
		}
		postMessage(data: unknown): void {
			for (const peer of MockBroadcastChannel.channels.get(this.name) ?? []) {
				if (peer === this) continue
				for (const handler of peer.handlers) handler({ data: structuredClone(data) })
			}
		}
		addEventListener(_type: 'message', handler: ChannelHandler): void {
			this.handlers.add(handler)
		}
		removeEventListener(_type: 'message', handler: ChannelHandler): void {
			this.handlers.delete(handler)
		}
		close(): void {
			MockBroadcastChannel.channels.get(this.name)?.delete(this)
		}
	}

	let stopRelay: (() => void) | null = null
	const stores: Store[] = []
	beforeEach(() => {
		MockBroadcastChannel.channels.clear()
		vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
	})
	afterEach(async () => {
		for (const s of stores.splice(0).reverse()) await s.close()
		stopRelay?.()
		stopRelay = null
		vi.unstubAllGlobals()
	})

	test('a follower tab insertMany goes through the leader worker in batches and is visible to the leader', async () => {
		const channelName = 'kora-batched-writes-tabs'
		const leaderBridge = new CountingBridge(new MockWorkerBridge())
		stopRelay = startLeaderRpcRelay(channelName, leaderBridge)
		const leader = new Store({
			schema,
			adapter: new SqliteWasmAdapter({ bridge: leaderBridge, dbName: 'tabs' }),
			nodeId: 'leader-node',
		})
		const follower = new Store({
			schema,
			adapter: new SqliteWasmAdapter({
				bridge: new FollowerBroadcastBridge(channelName),
				dbName: 'tabs',
			}),
			nodeId: 'follower-node',
		})
		stores.push(leader, follower)
		await leader.open()
		await follower.open()
		leaderBridge.types.length = 0

		await follower
			.collection('todos')
			.insertMany(Array.from({ length: 400 }, (_, i) => ({ title: `f${i}` })))
		expect(leaderBridge.count('batch')).toBeGreaterThan(0)
		expect(leaderBridge.count('execute')).toBe(0)
		expect(await leader.collection('todos').where({}).exec()).toHaveLength(400)

		// The leader's own write interleaves correctly after the follower's transaction.
		await leader.collection('projects').insertMany([{ name: 'p' }])
		expect(await follower.collection('projects').where({}).exec()).toHaveLength(1)
	})
})
