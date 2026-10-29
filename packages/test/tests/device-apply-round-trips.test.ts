/**
 * C3b: storage round trips per delivered operation on the device apply path
 * (docs/design/fast-first-sync.md, "C3b").
 *
 * In a browser every call that crosses the StorageAdapter boundary is a message to the
 * SQLite worker (a `query`, an `execute`, one `executeBatch` of any size, BEGIN and COMMIT),
 * and the C1.0(b) measurement found about 19 of them per delivered operation, which capped
 * a first sync at 36 to 47 operations per second. This test replays delivery batches of the
 * LMS fixture into a real device (Store, merge-aware sync store, sync-state persistence,
 * SyncEngine) over an adapter that counts those calls, and fails when the amortized count per
 * operation grows past a stated budget, so the apply path cannot regress to per-operation
 * reads without a test noticing.
 *
 * `KORA_ROUND_TRIPS_REPORT=1` prints the breakdown by statement kind (used for the design
 * document's table).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Operation } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import { Store, type Transaction, type TransactionStatement } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { type OperationBatchMessage, SyncEngine, type SyncMessage } from '@korajs/sync'
import { createMemoryTransportPair } from '@korajs/sync/internal'
import {
	ApplyPipeline,
	MergeAwareSyncStore,
	StoreQueueStorage,
	StoreSyncStatePersistence,
} from 'korajs/testing'
import { afterAll, describe, expect, test } from 'vitest'
import { generateLmsFixture, lmsFirstSyncSchema } from '../bench/lms-first-sync-fixture'

const tmp = mkdtempSync(join(tmpdir(), 'kora-round-trips-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** One bucket per kind of statement, so the report reads like the design document's table. */
function kindOf(sql: string): string {
	const text = sql.replace(/\s+/g, ' ').trim()
	const head = text.split(' ').slice(0, 2).join(' ').toUpperCase()
	const table = /(?:FROM|INTO|UPDATE|JOIN)\s+"?(_kora_[a-z_]+?)(?:_[a-z_]+)?"?[\s(]/i.exec(text)
	if (/^SELECT/i.test(text)) {
		const from = /FROM\s+"?([A-Za-z_0-9]+)"?/i.exec(text)
		const name = from?.[1] ?? '?'
		return `read ${name.startsWith('_kora_ops_') ? '_kora_ops_*' : name.startsWith('_kora_') ? name : 'rows'}`
	}
	return `${head}${table ? ` ${table[1]}` : ''}`
}

/** Counts what would cross the worker boundary. A buffered batch counts once. */
class CountingAdapter extends BetterSqlite3Adapter {
	trips = 0
	reads = 0
	writes = 0
	statementCount = 0
	readonly byKind = new Map<string, number>()
	counting = false

	private tally(kind: string, trips: number): void {
		if (!this.counting) return
		this.byKind.set(kind, (this.byKind.get(kind) ?? 0) + trips)
	}

	override async transaction(
		fn: Parameters<BetterSqlite3Adapter['transaction']>[0],
	): Promise<void> {
		if (this.counting) this.trips += 2 // BEGIN and COMMIT
		return super.transaction(async (raw) => {
			const counted: Transaction = {
				query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
					if (this.counting) {
						this.trips++
						this.reads++
						this.tally(kindOf(sql), 1)
					}
					return raw.query<T>(sql, params)
				},
				execute: async (sql: string, params?: unknown[]): Promise<void> => {
					if (this.counting) {
						this.trips++
						this.writes++
						this.statementCount++
						this.tally(`execute ${kindOf(sql)}`, 1)
					}
					return raw.execute(sql, params)
				},
				// What the SQLite WASM adapter offers: one worker message for many statements.
				executeBatch: async (statements: readonly TransactionStatement[]): Promise<void> => {
					if (this.counting) {
						this.trips++
						this.writes++
						this.statementCount += statements.length
						this.tally('executeBatch', 1)
					}
					for (const statement of statements) await raw.execute(statement.sql, statement.params)
				},
			}
			await fn(counted)
		})
	}
}

async function drain(engine: SyncEngine): Promise<void> {
	const chained = engine as unknown as { messageChain: Promise<void> }
	for (;;) {
		const current = chained.messageChain
		await current
		if (chained.messageChain === current) return
	}
}

/** Chained delivery batches of `size` operations, as the server's `streamDelivery` cuts them. */
function deliveryBatches(operations: Operation[], size: number): OperationBatchMessage[] {
	const messages: OperationBatchMessage[] = []
	for (let start = 0; start < operations.length; start += size) {
		const slice = operations.slice(start, start + size)
		const base = start
		messages.push({
			type: 'operation-batch',
			messageId: `batch-${start}`,
			operations: slice.map((operation) => JSON.parse(JSON.stringify(operation))),
			isFinal: start + size >= operations.length,
			batchIndex: start / size,
			baseDeliverySequence: base,
			maxDeliverySequence: base + slice.length,
			operationSequences: slice.map((_, index) => base + index + 1),
		})
	}
	return messages
}

interface Counts {
	operations: number
	trips: number
	reads: number
	writes: number
	statements: number
	transactions: number
	byKind: Array<[string, number]>
	rows: number
}

async function applyFixture(operationsCount: number, batchSize: number): Promise<Counts> {
	const fixture = await generateLmsFixture({
		visibleOps: operationsCount,
		tenants: 1,
		moveRate: 0,
	})
	const emitter = new SimpleEventEmitter()
	const adapter = new CountingAdapter(join(tmp, `device-${operationsCount}-${batchSize}.db`))
	const store = new Store({ schema: lmsFirstSyncSchema, adapter, emitter, nodeId: 'device-node' })
	await store.open()
	const merge = new MergeEngine()
	store.setLocalMutationHandler(new ApplyPipeline({ store, mergeEngine: merge, emitter }))
	const syncStore = new MergeAwareSyncStore(store, merge, emitter)
	const { client, server } = createMemoryTransportPair()
	server.onMessage((message: SyncMessage) => {
		if (message.type === 'handshake') {
			server.send({
				type: 'handshake-response',
				messageId: `resp-${message.messageId}`,
				nodeId: 'server-node',
				versionVector: {},
				schemaVersion: message.schemaVersion,
				accepted: true,
			})
		}
	})
	const engine = new SyncEngine({
		transport: client,
		store: syncStore,
		queueStorage: new StoreQueueStorage(adapter),
		syncState: new StoreSyncStatePersistence(store),
		config: { url: 'ws://test', schemaVersion: lmsFirstSyncSchema.version },
		emitter,
	})
	await engine.start()
	await drain(engine)

	let transactions = 0
	const countTransactions = adapter.transaction.bind(adapter)
	adapter.transaction = (fn) => {
		if (adapter.counting) transactions++
		return countTransactions(fn)
	}
	adapter.counting = true
	for (const message of deliveryBatches(fixture.operations, batchSize)) {
		server.send(JSON.parse(JSON.stringify(message)) as SyncMessage)
		await drain(engine)
	}
	adapter.counting = false
	let rows = 0
	for (const collection of Object.keys(lmsFirstSyncSchema.collections)) {
		rows += (await store.collection(collection).where({}).exec()).length
	}
	await engine.stop()
	await store.close()
	return {
		operations: fixture.operations.length,
		trips: adapter.trips,
		reads: adapter.reads,
		writes: adapter.writes,
		statements: adapter.statementCount,
		transactions,
		byKind: [...adapter.byKind].sort((a, b) => b[1] - a[1]),
		rows,
	}
}

describe('C3b: worker round trips per delivered operation', () => {
	test('a 100-operation delivery batch costs few storage round trips per operation', async () => {
		const counts = await applyFixture(2_000, 100)
		const perOperation = (value: number): number => value / counts.operations
		if (process.env.KORA_ROUND_TRIPS_REPORT === '1') {
			console.log(
				JSON.stringify(
					{
						operations: counts.operations,
						tripsPerOperation: perOperation(counts.trips),
						readsPerOperation: perOperation(counts.reads),
						writeTripsPerOperation: perOperation(counts.writes),
						statementsPerOperation: perOperation(counts.statements),
						transactions: counts.transactions,
						byKindPerOperation: counts.byKind.map(([kind, n]) => [
							kind,
							+perOperation(n).toFixed(3),
						]),
					},
					null,
					2,
				),
			)
		}
		expect(counts.rows).toBeGreaterThan(0)
		// One storage transaction per delivery batch (C3).
		expect(counts.transactions).toBeLessThanOrEqual(counts.operations / 100 + 1)
		// The budget (C3b), amortized per operation. The pre-C3b path took 12.9 reads and 5.4
		// write round trips (18.3 in all). Now each operation's step is one request (its
		// savepoint, writes and release travel together) and the reads are the batch's
		// prefetch and its merge traces' prior operations, a few per batch.
		expect(perOperation(counts.reads)).toBeLessThanOrEqual(0.25)
		expect(perOperation(counts.writes)).toBeLessThanOrEqual(1.25)
		expect(perOperation(counts.trips)).toBeLessThanOrEqual(1.5)
	}, 120_000)
})
