/**
 * C3: a delivery batch is applied on the device in ONE storage transaction, with its
 * quarantine rows and its delivery watermark (docs/design/fast-first-sync.md).
 *
 * Every test runs a real Store (better-sqlite3 file), the korajs merge-aware sync store and
 * sync-state persistence, and a real SyncEngine, fed crafted delivery batches over a
 * memory transport. A "per-operation" device (the store declines to batch) is the
 * reference: batched apply must end in exactly the state (rows, fold states, provisional
 * cascades, op logs, retraction markers, version vector, quarantine with payloads,
 * watermark), events (every type but `query:*`, in order) and acknowledgements the
 * per-operation path produces.
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
import {
	MAX_DELIVERY_TRANSACTION_OPERATIONS,
	type MemoryTransport,
	createMemoryTransportPair,
} from '@korajs/sync/internal'
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
		lessons: {
			fields: { title: t.string(), school: t.string(), projectId: t.string().optional() },
			// Checked optimistically on the device (reported, never enforced): each report must
			// describe the operation it names, with the state right after it.
			constraints: [{ type: 'unique', fields: ['title'], onConflict: 'last-write-wins' }],
		},
		projects: { fields: { name: t.string() } },
	},
	relations: {
		lessonProject: {
			from: 'lessons',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
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

/** Stalls like {@link StallingSyncStore}, applying operation by operation (the reference). */
class StallingPerOperationSyncStore extends StallingSyncStore {
	override async applyDeliveryBatch<T>(): Promise<{ value: T } | null> {
		return null
	}
}

type Mode = 'batched' | 'per-operation' | 'stalling' | 'stalling-per-operation'

/** Fields that carry wall-clock measurements, not outcomes. */
const TIMING_FIELDS = new Set(['duration', 'quarantinedAt', 'firstSeenAt', 'rejectedAt'])

/** Records every event (but `query:*`) in order, without its timing fields. */
class RecordingEmitter extends SimpleEventEmitter {
	readonly recorded: string[] = []
	override emit(event: Parameters<SimpleEventEmitter['emit']>[0]): void {
		if (!event.type.startsWith('query:')) {
			this.recorded.push(
				JSON.stringify(event, (key, value) => (TIMING_FIELDS.has(key) ? undefined : value)),
			)
		}
		super.emit(event)
	}
}

interface Device {
	store: Store
	adapter: BetterSqlite3Adapter
	engine: SyncEngine
	server: MemoryTransport
	syncStore: MergeAwareSyncStore
	events: string[]
	/** Every event but `query:*`, in order (see {@link RecordingEmitter}). */
	allEvents: string[]
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
	const emitter = new RecordingEmitter()
	const store = new Store({ schema, adapter, emitter, nodeId: 'device-node' })
	await store.open()
	const merge = new MergeEngine()
	store.setLocalMutationHandler(new ApplyPipeline({ store, mergeEngine: merge, emitter }))
	const Kind = {
		batched: MergeAwareSyncStore,
		'per-operation': PerOperationSyncStore,
		stalling: StallingSyncStore,
		'stalling-per-operation': StallingPerOperationSyncStore,
	}[mode]
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
	// Local writes reach the outbound queue as createApp wires them.
	emitter.on('operation:created', (event) => {
		void engine.pushOperation(event.operation)
	})
	const events: string[] = []
	emitter.on('operation:applied', (event) => events.push(`applied:${event.operation.id}`))
	emitter.on('sync:apply-failed', (event) => events.push(`failed:${event.operationId}`))
	emitter.on('sync:scope-retracted', (event) => events.push(`retracted:${event.recordId}`))
	await engine.start()
	await drain(engine)
	// Only what the delivery batches cause is compared.
	emitter.recorded.length = 0
	const created: Device = {
		store,
		adapter,
		engine,
		server,
		syncStore,
		events,
		allEvents: emitter.recorded,
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
	projects: unknown[]
	foldStates: unknown[]
	provisional: unknown[]
	retractions: unknown[]
	log: string[]
	projectLog: string[]
	versionVector: unknown[]
	memoryVersionVector: Array<[string, number]>
	quarantine: string[]
	quarantinePayloads: unknown[]
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
	const ids = async (sql: string): Promise<string[]> =>
		(await target.adapter.query<{ id: string }>(sql)).map((row) => row.id)
	return {
		rows,
		projects: await target.adapter.query('SELECT id, name, _deleted FROM projects ORDER BY id'),
		foldStates: await target.adapter.query(
			'SELECT * FROM _kora_fold_state ORDER BY collection, record_id',
		),
		provisional: await target.adapter.query('SELECT * FROM _kora_provisional_ops ORDER BY 1, 2'),
		retractions,
		log,
		projectLog: await ids('SELECT id FROM _kora_ops_projects ORDER BY id'),
		versionVector: await target.adapter.query(
			'SELECT node_id, sequence_number FROM _kora_version_vector ORDER BY node_id',
		),
		memoryVersionVector: [...target.store.getVersionVector()].sort((a, b) =>
			a[0].localeCompare(b[0]),
		),
		quarantine,
		quarantinePayloads: await target.adapter.query(
			'SELECT op_id, collection, delivery_seq, position, code, message, payload FROM _kora_unapplied_ops ORDER BY op_id',
		),
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

	test('a retraction of a record with unsent local writes keeps the per-operation path', async () => {
		const outcomes: Array<{ visible: boolean; events: string[]; transactions: number }> = []
		for (const mode of ['batched', 'per-operation'] as const) {
			const target = await device(mode)
			const local = await target.store.collection('lessons').insert({ title: 'mine', school: 's' })
			const recordId = String(local.id)
			await drain(target.engine)
			const ops = [
				op('update', recordId, { title: 'theirs' }),
				op('insert', `other-${mode}`, { title: 'o', school: 's' }),
			]
			const before = target.transactions()
			// The record leaves the view after the first operation.
			await deliver(target, batch('b1', 0, ops, [{ recordId, after: 1 }]))
			outcomes.push({
				visible: (await target.store.collection('lessons').findById(recordId)) !== null,
				events: target.events
					.filter((event) => event.startsWith('retracted:'))
					.map((event) => event.replace(recordId, 'RECORD')),
				transactions: target.transactions() - before,
			})
			expect((await state(target)).watermark).toBe(5)
		}
		const [batched, reference] = outcomes
		expect(batched?.visible).toBe(false)
		expect(batched?.visible).toBe(reference?.visible)
		expect(batched?.events).toEqual(reference?.events)
		// The attempt rolled back and the batch was applied operation by operation.
		expect(batched?.transactions).toBeGreaterThan(1)
	})
})

describe('cascades, chunks and re-sends', () => {
	test('a project delete in a batch cascades to its lessons as on the per-operation path', async () => {
		const ops = [
			op('insert', 'p', { name: 'p' }, 'projects'),
			op('insert', 'l1', { title: 'l1', school: 's', projectId: 'p' }),
			op('insert', 'l2', { title: 'l2', school: 's', projectId: 'p' }),
			op('delete', 'p', null, 'projects'),
			op('insert', 'l3', { title: 'l3', school: 's' }),
		]
		const batched = await device('batched')
		const reference = await device('per-operation')
		for (const target of [batched, reference]) await deliver(target, batch('b1', 0, ops))
		await sameOutcome(batched, reference)
		const after = await state(batched)
		expect(after.provisional.length).toBeGreaterThan(0)
		const live = (after.rows as Array<{ id: string; _deleted: number }>)
			.filter((row) => row._deleted === 0)
			.map((row) => row.id)
		expect(live).toEqual(['l3'])
	})

	test('constraint reports describe each operation of a batch, not the batch end state', async () => {
		const ops = [
			op('insert', 'a', { title: 'T', school: 's' }),
			op('insert', 'b', { title: 'U', school: 's' }),
			// b takes a's title (a violation), then leaves it (resolved): reported once, for
			// this operation, although the batch ends without a violation.
			op('update', 'b', { title: 'T' }),
			op('update', 'b', { title: 'V' }),
			// b moves to W (valid when written), then a moves to W (a violation): only the
			// second operation is reported, although both records end in violation.
			op('update', 'b', { title: 'W' }),
			op('update', 'a', { title: 'W' }),
		]
		const batched = await device('batched')
		const reference = await device('per-operation')
		for (const target of [batched, reference]) await deliver(target, batch('c1', 0, ops))
		await sameOutcome(batched, reference)
		const reported = batched.allEvents
			.map((event) => JSON.parse(event) as { type: string; trace?: { operationA: { id: string } } })
			.filter((event) => event.type === 'constraint:violated')
			.map((event) => event.trace?.operationA.id)
		expect(reported).toEqual([ops[2]?.id, ops[5]?.id])
	})

	const bigBatch = (prefix: string, count: number): Operation[] =>
		Array.from({ length: count }, (_, i) =>
			op('insert', `${prefix}${String(i).padStart(4, '0')}`, { title: `${i}`, school: 's' }),
		)

	test(`a batch above ${MAX_DELIVERY_TRANSACTION_OPERATIONS} operations applies in bounded chunks, the watermark with the last`, async () => {
		const count = MAX_DELIVERY_TRANSACTION_OPERATIONS * 2 + 200
		const ops = bigBatch('big', count)
		const batched = await device('batched')
		const reference = await device('per-operation')
		const before = batched.transactions()
		for (const target of [batched, reference]) await deliver(target, batch('big', 0, ops))
		// Three chunk transactions (plus none per operation).
		expect(batched.transactions() - before).toBe(3)
		await sameOutcome(batched, reference)
		expect((await state(batched)).watermark).toBe(2 * count + 1)
		expect(batched.acks).toEqual([2 * count + 1])
	})

	test('a crash between chunks leaves the committed chunk under the old watermark; the re-send completes the batch', async () => {
		const file = join(tmp, 'chunk-crash.db')
		const count = MAX_DELIVERY_TRANSACTION_OPERATIONS + 100
		const ops = bigBatch('crash', count)
		const first = await device('batched', file)
		// Storage dies once the first chunk's transaction committed.
		let committed = 0
		const realTransaction = first.adapter.transaction.bind(first.adapter)
		first.adapter.transaction = async (fn) => {
			if (committed >= 1) throw new Error('SQLITE_IOERR: disk I/O error')
			await realTransaction(fn)
			committed += 1
		}
		await deliver(first, batch('c1', 0, ops))
		expect(first.acks).toEqual([])
		await first.close()
		devices.splice(devices.indexOf(first), 1)

		const restarted = await device('batched', file)
		const after = await state(restarted)
		expect(after.watermark).toBe(0)
		expect(after.log).toHaveLength(MAX_DELIVERY_TRANSACTION_OPERATIONS)
		await deliver(restarted, batch('c1', 0, ops))
		const final = await state(restarted)
		expect(final.log).toHaveLength(count)
		expect(final.watermark).toBe(2 * count + 1)
	})

	test('a stall in a later chunk: earlier chunks stay without a watermark, the batch falls back, the re-send completes it', async () => {
		const count = MAX_DELIVERY_TRANSACTION_OPERATIONS * 2 + 50
		const ops = bigBatch('stall', count)
		const stalled = ops[MAX_DELIVERY_TRANSACTION_OPERATIONS + 10]?.id ?? ''
		const batched = await device('stalling')
		const reference = await device('stalling-per-operation')
		const message = batch('s1', 0, ops)
		for (const target of [batched, reference]) {
			;(target.syncStore as StallingSyncStore).stalling.add(stalled)
			await deliver(target, message)
		}
		const stalledState = await state(batched)
		expect(stalledState.watermark).toBe(0)
		expect(batched.acks).toEqual([])
		expect(stalledState.log).not.toContain(stalled)
		await sameOutcome(batched, reference)

		// The re-send of the same batch goes straight to the per-operation path (it holds
		// the operation that blocks the stream): no second batched attempt.
		for (const target of [batched, reference]) {
			;(target.syncStore as StallingSyncStore).stalling.clear()
		}
		const batchedBefore = batched.transactions()
		const referenceBefore = reference.transactions()
		for (const target of [batched, reference]) {
			await deliver(target, { ...message, messageId: 's1-resend' })
		}
		expect(batched.transactions() - batchedBefore).toBe(reference.transactions() - referenceBefore)
		await sameOutcome(batched, reference)
		expect((await state(batched)).watermark).toBe(2 * count + 1)
	})

	test('a batch whose batched attempt fell back is not attempted again when re-sent', async () => {
		const ops = [
			op('insert', 'a', { title: 'a', school: 's' }),
			op('insert', 'b', { title: 'b', school: 's' }),
		]
		const target = await device('stalling')
		const store = target.syncStore as StallingSyncStore
		store.stalling.add(ops[1]?.id ?? '')
		const message = batch('f1', 0, ops)
		await deliver(target, message)
		// The blocking operation is cleared by an unrelated recovery; the batch key alone
		// still sends the re-send to the per-operation path.
		;(target.engine as unknown as { blockedFailure: unknown }).blockedFailure = null
		store.stalling.clear()
		let attempts = 0
		const apply = store.applyDeliveryBatch.bind(store)
		store.applyDeliveryBatch = async (fn) => {
			attempts += 1
			return apply(fn)
		}
		await deliver(target, { ...message, messageId: 'f1-resend' })
		expect(attempts).toBe(0)
		expect((await state(target)).watermark).toBe(message.maxDeliverySequence)
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

/**
 * A random delivery stream over two related collections: inserts, updates (some moving a
 * lesson to another project), deletes (a project's delete cascades to its lessons through
 * provisional effects), re-delivered duplicates, operations of an unknown collection
 * (quarantined), retractions at random positions; and, for the stalling pair, a random
 * batch whose random operations stall the first time it is delivered (then it is re-sent).
 */
function randomStream(seed: number): {
	messages: OperationBatchMessage[]
	stalls: Map<string, string[]>
} {
	const random = prng(seed)
	const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
	const lessons = ['r0', 'r1', 'r2', 'r3', 'r4']
	const projects = ['p0', 'p1']
	const all: Operation[] = []
	const messages: OperationBatchMessage[] = []
	const stalls = new Map<string, string[]>()
	let base = 0
	const batches = 1 + Math.floor(random() * 3)
	for (let b = 0; b < batches; b++) {
		const size = 1 + Math.floor(random() * 12)
		// The projects exist before any lesson references them: the server delivers a
		// reference only after its target (SQLite enforces the relation as a foreign key).
		const ops: Operation[] =
			b === 0 ? projects.map((id) => op('insert', id, { name: id }, 'projects')) : []
		for (let i = 0; i < size; i++) {
			const roll = random()
			const lesson = pick(lessons)
			if (roll < 0.07 && all.length > 0) {
				ops.push(pick(all)) // a re-delivered duplicate
			} else if (roll < 0.12) {
				ops.push(op('insert', lesson, { title: 'x' }, 'ghosts')) // quarantined
			} else if (roll < 0.2) {
				ops.push(op('insert', pick(projects), { name: `n${b}.${i}` }, 'projects'))
			} else if (roll < 0.25) {
				ops.push(op('delete', pick(projects), null, 'projects')) // cascades
			} else if (roll < 0.52) {
				ops.push(
					op('insert', lesson, {
						title: `t${i}`,
						school: pick(['s', 'u']),
						projectId: pick(projects),
					}),
				)
			} else if (roll < 0.68) {
				ops.push(op('update', lesson, { projectId: pick(projects) }))
			} else if (roll < 0.9) {
				ops.push(op('update', lesson, { title: `u${b}.${i}` }))
			} else {
				ops.push(op('delete', lesson, null))
			}
		}
		all.push(...ops)
		const retractions = Array.from({ length: Math.floor(random() * 3) }, () => ({
			recordId: pick(lessons),
			after: Math.floor(random() * (ops.length + 1)),
		}))
		const message = batch(`m${seed}-${b}`, base, ops, retractions, b === batches - 1)
		messages.push(message)
		if (random() < 0.5) {
			stalls.set(
				message.messageId,
				ops.filter(() => random() < 0.3).map((operation) => operation.id),
			)
		}
		base = message.maxDeliverySequence ?? base
	}
	return { messages, stalls }
}

async function sameOutcome(batched: Device, reference: Device): Promise<void> {
	expect(await state(batched)).toEqual(await state(reference))
	expect(batched.allEvents).toEqual(reference.allEvents)
	expect(batched.acks).toEqual(reference.acks)
	const query = async (target: Device): Promise<unknown[]> =>
		target.store.collection('lessons').where({ school: 's' }).orderBy('id').exec()
	expect(await query(batched)).toEqual(await query(reference))
}

const PROPERTY_SEEDS = Number(process.env.KORA_C3_PROPERTY_SEEDS ?? 40)

describe('batched apply equals per-operation apply (property)', () => {
	for (let seed = 1; seed <= PROPERTY_SEEDS; seed++) {
		test(`random delivery stream, seed ${seed}`, async () => {
			const { messages } = randomStream(seed)
			const batched = await device('batched')
			const reference = await device('per-operation')
			for (const message of messages) {
				await deliver(batched, message)
				await deliver(reference, message)
			}
			// A re-sent stream (a retransmission crossing acks) changes nothing either way.
			await deliver(batched, { ...(messages[0] as OperationBatchMessage), messageId: 'again' })
			await deliver(reference, { ...(messages[0] as OperationBatchMessage), messageId: 'again' })
			await sameOutcome(batched, reference)
			// And the batched device really batched: one transaction per message where the
			// reference used one per operation (equal only when every batch held one).
			const operationCount = messages.reduce((n, m) => n + m.operations.length, 0)
			if (operationCount > messages.length) {
				expect(batched.transactions()).toBeLessThan(reference.transactions())
			} else {
				expect(batched.transactions()).toBeLessThanOrEqual(reference.transactions())
			}
		})

		test(`random delivery stream with mid-batch stalls and re-sends, seed ${seed}`, async () => {
			const { messages, stalls } = randomStream(seed)
			const batched = await device('stalling')
			const reference = await device('stalling-per-operation')
			for (const message of messages) {
				const stalling = stalls.get(message.messageId) ?? []
				for (const target of [batched, reference]) {
					const set = (target.syncStore as StallingSyncStore).stalling
					for (const id of stalling) set.add(id)
					await deliver(target, message)
					set.clear()
					if (stalling.length > 0) {
						// The server re-sends the unacknowledged batch.
						await deliver(target, { ...message, messageId: `${message.messageId}-resend` })
					}
				}
			}
			await sameOutcome(batched, reference)
			expect((await state(batched)).watermark).toBe(messages.at(-1)?.maxDeliverySequence)
		})
	}
})
