/**
 * C3: a delivery batch is applied on the device in ONE storage transaction, with its
 * quarantine rows and its delivery watermark (docs/design/fast-first-sync.md).
 *
 * Every test runs a real Store (better-sqlite3 file), the korajs merge-aware sync store and
 * sync-state persistence, and a real SyncEngine, fed crafted delivery batches over a
 * memory transport. A "per-operation" device (the store declines to batch) is the
 * reference: batched apply must end in exactly the state, quarantine, watermark and
 * events the per-operation path produces.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Operation, defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import {
	type OperationBatchMessage,
	type ScopeRetraction,
	SyncEngine,
	type SyncMessage,
	type SyncStoreBatch,
} from '@korajs/sync'
import { type MemoryTransport, createMemoryTransportPair } from '@korajs/sync/internal'
import {
	ApplyPipeline,
	MergeAwareSyncStore,
	StoreQueueStorage,
	StoreSyncStatePersistence,
} from 'korajs/testing'
import { afterAll, afterEach, describe, expect, test } from 'vitest'

const schema = defineSchema({
	version: 1,
	collections: {
		lessons: { fields: { title: t.string(), school: t.string() } },
	},
})

const EPOCH = Date.UTC(2026, 0, 1)
const tmp = mkdtempSync(join(tmpdir(), 'kora-batched-apply-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** A store that declines to batch: the engine applies operation by operation. */
class PerOperationSyncStore extends MergeAwareSyncStore {
	override async applyDeliveryBatch<T>(): Promise<{ value: T } | null> {
		return null
	}
}

/** Operations whose apply fails retriably (a busy database), on both paths. */
class StallingSyncStore extends MergeAwareSyncStore {
	readonly stalling = new Set<string>()

	override async applyRemoteOperation(
		op: Operation,
	): ReturnType<MergeAwareSyncStore['applyRemoteOperation']> {
		if (this.stalling.has(op.id)) throw new Error('database is busy')
		return super.applyRemoteOperation(op)
	}

	override async applyDeliveryBatch<T>(
		fn: (batch: SyncStoreBatch) => Promise<T>,
	): Promise<{ value: T } | null> {
		return super.applyDeliveryBatch((batch) =>
			fn({
				...batch,
				applyRemoteOperation: async (op, position) => {
					if (this.stalling.has(op.id)) throw new Error('database is busy')
					return batch.applyRemoteOperation(op, position)
				},
			}),
		)
	}
}

type Mode = 'batched' | 'per-operation' | 'stalling'

interface Device {
	store: Store
	adapter: BetterSqlite3Adapter
	engine: SyncEngine
	server: MemoryTransport
	syncStore: MergeAwareSyncStore
	events: string[]
	acks: number[]
	transactions: () => number
	close(): Promise<void>
}

const devices: Device[] = []
afterEach(async () => {
	for (const device of devices.splice(0)) await device.close()
})

/** Counts storage transactions (the C3 claim is one per batch). */
class CountingAdapter extends BetterSqlite3Adapter {
	count = 0
	override async transaction(
		fn: Parameters<BetterSqlite3Adapter['transaction']>[0],
	): Promise<void> {
		this.count += 1
		return super.transaction(fn)
	}
}

let deviceCounter = 0
async function device(mode: Mode, file?: string): Promise<Device> {
	const path = file ?? join(tmp, `device-${++deviceCounter}.db`)
	const adapter = new CountingAdapter(path)
	const emitter = new SimpleEventEmitter()
	const store = new Store({ schema, adapter, emitter, nodeId: 'device-node' })
	await store.open()
	const merge = new MergeEngine()
	store.setLocalMutationHandler(new ApplyPipeline({ store, mergeEngine: merge, emitter }))
	const Kind =
		mode === 'batched'
			? MergeAwareSyncStore
			: mode === 'per-operation'
				? PerOperationSyncStore
				: StallingSyncStore
	const syncStore = new Kind(store, merge, emitter)
	const { client, server } = createMemoryTransportPair()
	const acks: number[] = []
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
		if (message.type === 'acknowledgment' && message.deliverySequence !== undefined) {
			acks.push(message.deliverySequence)
		}
	})
	const engine = new SyncEngine({
		transport: client,
		store: syncStore,
		queueStorage: new StoreQueueStorage(adapter),
		syncState: new StoreSyncStatePersistence(store),
		config: { url: 'ws://test', schemaVersion: schema.version },
		emitter,
	})
	const events: string[] = []
	emitter.on('operation:applied', (event) => events.push(`applied:${event.operation.id}`))
	emitter.on('sync:apply-failed', (event) => events.push(`failed:${event.operationId}`))
	emitter.on('sync:scope-retracted', (event) => events.push(`retracted:${event.recordId}`))
	await engine.start()
	await drain(engine)
	const created: Device = {
		store,
		adapter,
		engine,
		server,
		syncStore,
		events,
		acks,
		transactions: () => adapter.count,
		close: async () => {
			await engine.stop()
			await store.close()
		},
	}
	devices.push(created)
	return created
}

/** Wait until every message the engine received has been handled. */
async function drain(engine: SyncEngine): Promise<void> {
	const chained = engine as unknown as { messageChain: Promise<void> }
	for (;;) {
		const current = chained.messageChain
		await current
		if (chained.messageChain === current) return
	}
}

async function deliver(target: Device, message: OperationBatchMessage): Promise<void> {
	target.server.send(JSON.parse(JSON.stringify(message)) as SyncMessage)
	await drain(target.engine)
}

let opCounter = 0
function op(
	type: Operation['type'],
	recordId: string,
	data: Record<string, unknown> | null,
	collection = 'lessons',
): Operation {
	const seq = ++opCounter
	return {
		id: `op-${seq}-${type}-${recordId}`,
		nodeId: 'author-node',
		type,
		collection,
		recordId,
		data,
		previousData: type === 'update' ? {} : null,
		timestamp: { wallTime: EPOCH + seq, logical: 0, nodeId: 'author-node' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

/**
 * A chained delivery batch: operation `i` has delivery sequence `base + 2i + 2`; a
 * retraction placed after `n` operations has `base + 2n + 1` (between its neighbours).
 */
function batch(
	id: string,
	base: number,
	operations: Operation[],
	retractions: Array<{ recordId: string; after: number }> = [],
	isFinal = false,
): OperationBatchMessage {
	const sequences = operations.map((_, index) => base + 2 * index + 2)
	return {
		type: 'operation-batch',
		messageId: id,
		operations: operations.map((operation) => JSON.parse(JSON.stringify(operation))),
		isFinal,
		batchIndex: 0,
		baseDeliverySequence: base,
		maxDeliverySequence: base + 2 * operations.length + 1,
		operationSequences: sequences,
		retractions: retractions.map(
			(retraction): ScopeRetraction => ({
				collection: 'lessons',
				recordId: retraction.recordId,
				afterOperations: retraction.after,
				deliverySequence: base + 2 * retraction.after + 1,
			}),
		),
	}
}

interface DeviceState {
	rows: unknown[]
	retractions: unknown[]
	log: string[]
	quarantine: string[]
	watermark: number
}

async function state(target: Device): Promise<DeviceState> {
	const rows = await target.adapter.query(
		'SELECT id, title, school, _deleted FROM lessons ORDER BY id',
	)
	const retractions = await target.adapter.query(
		'SELECT collection, record_id, position FROM _kora_scope_retractions ORDER BY record_id',
	)
	const log = (
		await target.adapter.query<{ id: string }>('SELECT id FROM _kora_ops_lessons ORDER BY id')
	).map((row) => row.id)
	const quarantine = (await target.store.loadInboundQuarantine()).map((e) => e.operation.id).sort()
	return {
		rows,
		retractions,
		log,
		quarantine,
		watermark: await target.store.loadDeliveryWatermark(''),
	}
}

describe('a delivery batch applies in one storage transaction', () => {
	test('one transaction for the batch, its watermark and its quarantine', async () => {
		const device1 = await device('batched')
		const ops = [
			op('insert', 'a', { title: 'a', school: 's' }),
			op('insert', 'g', { title: 'ghost' }, 'ghosts'), // unknown collection: quarantined
			op('insert', 'b', { title: 'b', school: 's' }),
			op('update', 'a', { title: 'a2' }),
		]
		const message = batch('b1', 0, ops)
		const before = device1.transactions()
		await deliver(device1, message)
		// One storage transaction for the whole batch (the quarantine table already exists).
		expect(device1.transactions() - before).toBe(1)
		const after = await state(device1)
		expect(after.watermark).toBe(message.maxDeliverySequence)
		expect(after.quarantine).toEqual([ops[1]?.id])
		expect(after.rows).toEqual([
			{ id: 'a', title: 'a2', school: 's', _deleted: 0 },
			{ id: 'b', title: 'b', school: 's', _deleted: 0 },
		])
		expect(device1.acks).toEqual([message.maxDeliverySequence])
	})

	test('a retraction and its record operations in one batch end as on the per-operation path', async () => {
		const ops = [
			op('insert', 'moved', { title: 'm', school: 's' }),
			op('insert', 'back', { title: 'b', school: 's' }),
			op('update', 'back', { title: 'b2' }),
			op('insert', 'stays', { title: 's', school: 's' }),
		]
		// `moved` leaves after its insert; `back` leaves after its insert and is written
		// again after the retraction (delivered after it: shown again).
		const retractions = [
			{ recordId: 'moved', after: 1 },
			{ recordId: 'back', after: 2 },
		]
		const batched = await device('batched')
		const reference = await device('per-operation')
		for (const target of [batched, reference]) {
			await deliver(target, batch('b1', 0, ops, retractions))
		}
		const result = await state(batched)
		expect(result).toEqual(await state(reference))
		expect(batched.events).toEqual(reference.events)
		const visible = (result.rows as Array<{ id: string; _deleted: number }>)
			.filter((row) => row._deleted === 0)
			.map((row) => row.id)
		expect(visible).toEqual(['back', 'stays'])
	})

	test('a stall mid-batch rolls the attempt back: watermark unchanged, nothing acknowledged, nothing published twice', async () => {
		const stalling = await device('stalling')
		const reference = await device('per-operation')
		const ops = [
			op('insert', 'a', { title: 'a', school: 's' }),
			op('insert', 'b', { title: 'b', school: 's' }),
			op('insert', 'c', { title: 'c', school: 's' }),
		]
		;(stalling.syncStore as StallingSyncStore).stalling.add(ops[1]?.id ?? '')
		const message = batch('b1', 0, ops)
		await deliver(stalling, message)
		const stalled = await state(stalling)
		// The watermark does not pass the stalled operation and the batch is not acked, so
		// the server re-sends it.
		expect(stalled.watermark).toBe(0)
		expect(stalling.acks).toEqual([])
		expect(stalled.log).not.toContain(ops[1]?.id)
		// The rolled-back attempt published nothing: each operation applied is announced
		// once (by the per-operation fallback, exactly as before C3).
		const applied = stalling.events.filter((event) => event.startsWith('applied:'))
		expect(applied).toEqual([`applied:${ops[0]?.id}`, `applied:${ops[2]?.id}`])

		// The database recovers; the server's re-send (same batch) completes it.
		;(stalling.syncStore as StallingSyncStore).stalling.clear()
		await deliver(stalling, { ...message, messageId: 'b1-resend' })
		await deliver(reference, message)
		const done = await state(stalling)
		expect(done.watermark).toBe(message.maxDeliverySequence)
		expect(done.rows).toEqual((await state(reference)).rows)
		expect(stalling.acks).toEqual([message.maxDeliverySequence])
	})

	test('a crash during the batch transaction leaves no partial batch and the watermark unchanged', async () => {
		const file = join(tmp, 'crash.db')
		const first = await device('batched', file)
		await deliver(first, batch('b0', 0, [op('insert', 'pre', { title: 'p', school: 's' })]))
		const committed = await state(first)
		expect(committed.watermark).toBe(3)

		// The process dies mid-batch: from the third operation on, every storage write
		// fails (the batch transaction and the per-operation retries alike).
		const ops = [
			op('insert', 'a', { title: 'a', school: 's' }),
			op('insert', 'b', { title: 'b', school: 's' }),
			op('insert', 'c', { title: 'c', school: 's' }),
			op('insert', 'd', { title: 'd', school: 's' }),
		]
		let writes = 0
		let dead = false
		const realTransaction = first.adapter.transaction.bind(first.adapter)
		first.adapter.transaction = async (fn) =>
			realTransaction(async (tx) => {
				await fn({
					execute: async (sql, params) => {
						if (sql.startsWith('INSERT INTO "_kora_ops_lessons"') && ++writes >= 3) dead = true
						if (dead) throw new Error('SQLITE_IOERR: disk I/O error')
						await tx.execute(sql, params)
					},
					query: (sql, params) => tx.query(sql, params),
				})
			})
		await deliver(first, batch('b1', 3, ops))
		// The attempt wrote two operations before the third failed; it was rolled back as a
		// whole and announced nothing, and the per-operation retries could not write.
		expect(writes).toBeGreaterThanOrEqual(3)
		expect(first.events.filter((event) => event.startsWith('applied:'))).toEqual([
			`applied:${committed.log[0]}`,
		])
		expect(first.acks).toEqual([3])
		await first.close()
		devices.splice(devices.indexOf(first), 1)

		// Restart on the same file: no operation of the batch is there and the watermark
		// is where it was, so the server re-sends the batch from it.
		const restarted = await device('batched', file)
		const after = await state(restarted)
		expect(after.log.filter((id) => ops.some((o) => o.id === id))).toEqual([])
		expect(after.watermark).toBe(committed.watermark)
		await deliver(restarted, batch('b1', 3, ops))
		const final = await state(restarted)
		expect(final.watermark).toBe(3 + 2 * ops.length + 1)
		expect((final.rows as Array<{ id: string }>).map((row) => row.id)).toEqual([
			'a',
			'b',
			'c',
			'd',
			'pre',
		])
	})
})

/** A small seeded PRNG (mulberry32): the property runs are reproducible. */
function prng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let r = Math.imul(a ^ (a >>> 15), 1 | a)
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
		return ((r ^ (r >>> 14)) >>> 0) / 4_294_967_296
	}
}

describe('batched apply equals per-operation apply (property)', () => {
	const RUNS = 25
	for (let seed = 1; seed <= RUNS; seed++) {
		test(`random delivery stream, seed ${seed}`, async () => {
			const random = prng(seed)
			const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
			const records = ['r0', 'r1', 'r2', 'r3', 'r4']
			const all: Operation[] = []
			const messages: OperationBatchMessage[] = []
			let base = 0
			const batches = 1 + Math.floor(random() * 3)
			for (let b = 0; b < batches; b++) {
				const size = 1 + Math.floor(random() * 12)
				const ops: Operation[] = []
				for (let i = 0; i < size; i++) {
					const roll = random()
					const recordId = pick(records)
					if (roll < 0.08 && all.length > 0) {
						ops.push(pick(all)) // a re-delivered duplicate
					} else if (roll < 0.14) {
						ops.push(op('insert', recordId, { title: 'x' }, 'ghosts')) // quarantined
					} else if (roll < 0.5) {
						ops.push(op('insert', recordId, { title: `t${i}`, school: pick(['s', 'u']) }))
					} else if (roll < 0.88) {
						ops.push(op('update', recordId, { title: `u${b}.${i}` }))
					} else {
						ops.push(op('delete', recordId, null))
					}
				}
				all.push(...ops)
				const retractions = Array.from({ length: Math.floor(random() * 3) }, () => ({
					recordId: pick(records),
					after: Math.floor(random() * (ops.length + 1)),
				}))
				const message = batch(`m${seed}-${b}`, base, ops, retractions, b === batches - 1)
				messages.push(message)
				base = message.maxDeliverySequence ?? base
			}
			const batched = await device('batched')
			const reference = await device('per-operation')
			for (const message of messages) {
				await deliver(batched, message)
				await deliver(reference, message)
			}
			// A re-sent stream (a retransmission crossing acks) changes nothing either way.
			await deliver(batched, { ...(messages[0] as OperationBatchMessage), messageId: 'again' })
			await deliver(reference, { ...(messages[0] as OperationBatchMessage), messageId: 'again' })
			expect(await state(batched)).toEqual(await state(reference))
			expect(batched.events).toEqual(reference.events)
			expect(batched.acks).toEqual(reference.acks)
			// And the batched device really batched: one transaction per message where the
			// reference used one per operation (equal only when every batch held one).
			const operationCount = messages.reduce((n, m) => n + m.operations.length, 0)
			if (operationCount > messages.length) {
				expect(batched.transactions()).toBeLessThan(reference.transactions())
			} else {
				expect(batched.transactions()).toBeLessThanOrEqual(reference.transactions())
			}
		})
	}
})
