/**
 * `Store.applyRemoteBatch` (C3) on the SQLite WASM worker protocol and across tabs: one
 * span (BEGIN ... COMMIT) per delivery batch, each step's writes sent in `batch` worker
 * requests, a failing step undone alone by its savepoint, and a follower tab's batch run
 * on the leader worker.
 */
import { type Operation, defineSchema, t } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SqliteWasmAdapter } from '../../src/adapters/sqlite-wasm-adapter'
import type {
	WorkerBridge,
	WorkerRequest,
	WorkerResponse,
} from '../../src/adapters/sqlite-wasm-channel'
import { MockWorkerBridge } from '../../src/adapters/sqlite-wasm-mock-bridge'
import { Store } from '../../src/index'
import { FollowerBroadcastBridge, startLeaderRpcRelay } from '../../src/multi-tab/tab-storage'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string() } },
		projects: { fields: { name: t.string() } },
	},
})

/** Records request types; statements mentioning `failOnSql` fail. */
class CountingBridge implements WorkerBridge {
	readonly types: string[] = []
	failOnSql: string | null = null
	constructor(private readonly inner: WorkerBridge) {}
	async send(request: WorkerRequest): Promise<WorkerResponse> {
		this.types.push(request.type)
		const fail = this.failOnSql
		if (fail !== null) {
			const statements =
				request.type === 'batch'
					? request.statements
					: request.type === 'execute'
						? [{ sql: request.sql }]
						: []
			const index = statements.findIndex((s) => s.sql.includes(fail))
			if (index !== -1) {
				// The statements before the failing one ran, as a real worker would.
				if (request.type === 'batch' && index > 0) {
					await this.inner.send({ ...request, statements: request.statements.slice(0, index) })
				}
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
		return this.types.filter((type_) => type_ === type).length
	}
}

let counter = 0
function insert(collection: 'todos' | 'projects', recordId: string): Operation {
	const seq = ++counter
	return {
		id: `remote-${seq}`,
		nodeId: 'author',
		type: 'insert',
		collection,
		recordId,
		data: collection === 'todos' ? { title: recordId } : { name: recordId },
		previousData: null,
		timestamp: { wallTime: 1_700_000_000_000 + seq, logical: 0, nodeId: 'author' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('remote batch on the worker protocol', () => {
	let store: Store
	let bridge: CountingBridge

	beforeEach(async () => {
		bridge = new CountingBridge(new MockWorkerBridge())
		store = new Store({ schema, adapter: new SqliteWasmAdapter({ bridge }), nodeId: 'device' })
		await store.open()
		// Created once (the quarantine table): later batches are pure DML.
		await store.applyRemoteBatch(async () => undefined)
		bridge.types.length = 0
	})

	afterEach(async () => {
		await store.close()
	})

	test('100 operations: one BEGIN, one COMMIT, writes sent in batch requests', async () => {
		const ops = Array.from({ length: 100 }, (_, i) => insert('todos', `t${i}`))
		await store.applyRemoteBatch(async (batch) => {
			for (const op of ops) await batch.applyRemoteOperation(op)
			await batch.saveDeliveryWatermark('', 201)
		})
		expect(bridge.count('begin')).toBe(1)
		expect(bridge.count('commit')).toBe(1)
		expect(bridge.count('batch')).toBeGreaterThan(0)
		expect(await store.collection('todos').where({}).exec()).toHaveLength(100)
		expect(await store.loadDeliveryWatermark('')).toBe(201)
	})

	test('a statement failing in a buffered batch undoes only its step', async () => {
		bridge.failOnSql = '"projects"'
		const outcome = await store.applyRemoteBatch(async (batch) => {
			await batch.applyRemoteOperation(insert('todos', 'before'))
			const failed = await batch.applyRemoteOperation(insert('projects', 'p')).then(
				() => false,
				() => true,
			)
			await batch.applyRemoteOperation(insert('todos', 'after'))
			return failed
		})
		bridge.failOnSql = null
		expect(outcome).toEqual({ value: true })
		const todos = (await store.collection('todos').where({}).exec()).map((r) => r.id).sort()
		expect(todos).toEqual(['after', 'before'])
		expect(await store.collection('projects').where({}).exec()).toEqual([])
		const logged = await store.getOperationRange('author', 1, counter)
		expect(logged.some((op) => op.collection === 'projects')).toBe(false)
	})
})

describe('remote batch across tabs', () => {
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

	test('a follower tab applies a delivery batch on the leader worker, in one span', async () => {
		const channelName = 'kora-remote-batch-tabs'
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
		await follower.applyRemoteBatch(async () => undefined)
		leaderBridge.types.length = 0

		const ops = Array.from({ length: 50 }, (_, i) => insert('todos', `f${i}`))
		await follower.applyRemoteBatch(async (batch) => {
			for (const op of ops) await batch.applyRemoteOperation(op)
			await batch.saveDeliveryWatermark('', 101)
		})
		expect(leaderBridge.count('begin')).toBe(1)
		expect(leaderBridge.count('commit')).toBe(1)
		expect(await leader.collection('todos').where({}).exec()).toHaveLength(50)
		expect(await leader.loadDeliveryWatermark('')).toBe(101)
	})
})
