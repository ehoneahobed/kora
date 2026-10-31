/**
 * First-visit parity S3: a large initial delivery stream is applied into a scratch replica
 * and merged into the live database once (docs/design/first-visit-parity.md 5.7).
 *
 * A "direct" device (`bulkReplication: false`) applies the same batches the ordinary way and
 * is the reference: the staged device must end in exactly its state (rows, fold states, op
 * logs, version vector, provisional cascades, quarantine with payloads, watermark) for any
 * operation set. Crash tests kill the device between the phases; the live database must be
 * where it was and a restart must replicate again from its watermark.
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
import { createMemoryTransportPair } from '@korajs/sync/internal'
import type { MemoryTransport } from '@korajs/sync/internal'
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
			fields: {
				title: t.string(),
				school: t.string(),
				projectId: t.string().optional(),
				tags: t.array(t.string()).default([]),
			},
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
const tmp = mkdtempSync(join(tmpdir(), 'kora-staged-replication-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/**
 * A store that fails the operations in `stalling` (a busy database), in the live database and
 * in its scratch replica alike: the staged counterpart of the direct path's stall injection.
 */
class StallingSyncStore extends MergeAwareSyncStore {
	readonly stalling = new Set<string>()

	override async applyRemoteOperation(
		op: Operation,
	): ReturnType<MergeAwareSyncStore['applyRemoteOperation']> {
		if (this.stalling.has(op.id)) throw new Error('database is busy')
		return super.applyRemoteOperation(op)
	}

	private stallBatch<T>(
		fn: (batch: SyncStoreBatch) => Promise<T>,
	): (batch: SyncStoreBatch) => Promise<T> {
		return (batch) =>
			fn({
				...batch,
				applyRemoteOperation: async (op, position) => {
					if (this.stalling.has(op.id)) throw new Error('database is busy')
					return batch.applyRemoteOperation(op, position)
				},
			})
	}

	override async applyDeliveryBatch<T>(
		fn: (batch: SyncStoreBatch) => Promise<T>,
	): Promise<{ value: T } | null> {
		return super.applyDeliveryBatch(this.stallBatch(fn))
	}

	override async beginBulkReplication(): ReturnType<MergeAwareSyncStore['beginBulkReplication']> {
		const replica = await super.beginBulkReplication()
		if (replica === null) return null
		const inner = replica.store
		const stallBatch = this.stallBatch.bind(this)
		const store = Object.create(inner) as typeof inner
		store.applyDeliveryBatch = <T>(fn: (batch: SyncStoreBatch) => Promise<T>) =>
			(inner.applyDeliveryBatch as NonNullable<typeof inner.applyDeliveryBatch>).call(
				inner,
				stallBatch(fn),
			)
		return { ...replica, store }
	}
}

interface Device {
	store: Store
	adapter: BetterSqlite3Adapter
	engine: SyncEngine
	server: MemoryTransport
	events: string[]
	/** Every event but `sync:*` bookkeeping, as `type` (what a live listener of this database sees). */
	published: string[]
	syncStore: MergeAwareSyncStore
	acks: number[]
	close(): Promise<void>
}

const devices: Device[] = []
afterEach(async () => {
	for (const device of devices.splice(0)) await device.close()
})

let deviceCounter = 0
async function device(staged: boolean, file?: string, stalling = false): Promise<Device> {
	const path = file ?? join(tmp, `device-${++deviceCounter}.db`)
	const adapter = new BetterSqlite3Adapter(path)
	const emitter = new SimpleEventEmitter()
	const store = new Store({ schema, adapter, emitter, nodeId: 'device-node' })
	await store.open()
	const merge = new MergeEngine()
	store.setLocalMutationHandler(new ApplyPipeline({ store, mergeEngine: merge, emitter }))
	const syncStore = stalling
		? new StallingSyncStore(store, merge, emitter)
		: new MergeAwareSyncStore(store, merge, emitter)
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
		config: {
			url: 'ws://test',
			schemaVersion: schema.version,
			bulkReplication: staged ? { minOperations: 0 } : false,
		},
		emitter,
	})
	emitter.on('operation:created', (event) => {
		void engine.pushOperation(event.operation)
	})
	const events: string[] = []
	const published: string[] = []
	const realEmit = emitter.emit.bind(emitter)
	emitter.emit = ((event: { type: string }) => {
		if (!event.type.startsWith('sync:') && !event.type.startsWith('offline:')) {
			published.push(event.type)
		}
		return (realEmit as (e: unknown) => void)(event)
	}) as typeof emitter.emit
	for (const type of [
		'sync:staging-started',
		'sync:staging-merged',
		'sync:staging-discarded',
	] as const) {
		emitter.on(type, (event) =>
			events.push(
				type === 'sync:staging-discarded'
					? `${type}: ${(event as { reason: string }).reason}`
					: type,
			),
		)
	}
	emitter.on('sync:apply-failed', (event) => events.push(`apply-failed ${JSON.stringify(event)}`))
	emitter.on('sync:apply-blocked', (event) => events.push(`apply-blocked ${JSON.stringify(event)}`))
	emitter.on('store:persistence-error', (event) =>
		events.push(`error ${event.code}: ${event.message}`),
	)
	await engine.start()
	await drain(engine)
	const created: Device = {
		store,
		adapter,
		engine,
		server,
		events,
		published,
		syncStore,
		acks,
		close: async () => {
			await engine.stop()
			await store.close()
		},
	}
	devices.push(created)
	return created
}

async function drain(engine: SyncEngine): Promise<void> {
	const chained = engine as unknown as { messageChain: Promise<void> }
	for (;;) {
		const current = chained.messageChain
		await current
		if (chained.messageChain === current) return
	}
}

/** Wait for a restart the engine scheduled (a dropped replica reconnects) to finish. */
async function settle(target: Device): Promise<void> {
	const engine = target.engine as unknown as { reconnectPromise: Promise<void> | null }
	await new Promise((resolve) => setTimeout(resolve, 0))
	await engine.reconnectPromise
	await drain(target.engine)
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
	options: {
		collection?: string
		nodeId?: string
		at?: number
		previousData?: Record<string, unknown>
	} = {},
): Operation {
	const seq = ++opCounter
	const nodeId = options.nodeId ?? 'author-node'
	return {
		id: `op-${seq}-${type}-${recordId}`,
		nodeId,
		type,
		collection: options.collection ?? 'lessons',
		recordId,
		data,
		previousData: type === 'update' ? (options.previousData ?? {}) : null,
		timestamp: { wallTime: EPOCH + (options.at ?? seq), logical: 0, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

/** A chained delivery batch: operation `i` has delivery sequence `base + i + 1`. */
function batch(
	id: string,
	base: number,
	operations: Operation[],
	isFinal = false,
): OperationBatchMessage {
	return {
		type: 'operation-batch',
		messageId: id,
		operations: operations.map((operation) => JSON.parse(JSON.stringify(operation))),
		isFinal,
		batchIndex: 0,
		baseDeliverySequence: base,
		maxDeliverySequence: base + operations.length,
		operationSequences: operations.map((_, index) => base + index + 1),
		retractions: [],
	}
}

/** Splits `ops` into chained batches of `size`, the last one final. */
function stream(ops: Operation[], size: number): OperationBatchMessage[] {
	const batches: OperationBatchMessage[] = []
	for (let start = 0; start < ops.length; start += size) {
		batches.push(
			batch(`m${start}`, start, ops.slice(start, start + size), start + size >= ops.length),
		)
	}
	return batches
}

interface DeviceState {
	lessons: unknown[]
	projects: unknown[]
	foldStates: unknown[]
	foldBase: unknown[]
	provisional: unknown[]
	logLessons: string[]
	logProjects: string[]
	versionVector: unknown[]
	memoryVersionVector: Array<[string, number]>
	quarantine: unknown[]
	retractions: unknown[]
	watermark: number
}

async function state(target: Device): Promise<DeviceState> {
	const ids = async (sql: string): Promise<string[]> =>
		(await target.adapter.query<{ id: string }>(sql)).map((row) => row.id)
	return {
		lessons: await target.adapter.query(
			'SELECT id, title, school, projectId, tags, _deleted FROM lessons ORDER BY id',
		),
		projects: await target.adapter.query('SELECT id, name, _deleted FROM projects ORDER BY id'),
		foldStates: await target.adapter.query(
			'SELECT * FROM _kora_fold_state ORDER BY collection, record_id',
		),
		foldBase: await target.adapter.query(
			'SELECT * FROM _kora_fold_base ORDER BY collection, record_id',
		),
		provisional: await target.adapter.query('SELECT * FROM _kora_provisional_ops ORDER BY 1, 2'),
		logLessons: await ids('SELECT id FROM _kora_ops_lessons ORDER BY id'),
		logProjects: await ids('SELECT id FROM _kora_ops_projects ORDER BY id'),
		versionVector: await target.adapter.query(
			'SELECT node_id, sequence_number FROM _kora_version_vector ORDER BY node_id',
		),
		memoryVersionVector: [...target.store.getVersionVector()].sort((a, b) =>
			a[0].localeCompare(b[0]),
		),
		quarantine: await target.adapter.query<Record<string, unknown>>(
			'SELECT op_id, collection, delivery_seq, position, code, payload FROM _kora_unapplied_ops ORDER BY op_id',
		),
		retractions: await target.adapter.query(
			'SELECT collection, record_id, position FROM _kora_scope_retractions ORDER BY record_id',
		),
		watermark: await target.store.loadDeliveryWatermark(''),
	}
}

/** Both devices receive the same stream; the staged one must end exactly as the direct one. */
async function expectEquivalent(messages: OperationBatchMessage[]): Promise<DeviceState> {
	const direct = await device(false)
	const staged = await device(true)
	for (const message of messages) {
		await deliver(direct, message)
		try {
			await deliver(staged, message)
		} catch (error) {
			throw new Error(`${String(error)}; staged events: ${JSON.stringify(staged.events)}`)
		}
	}
	const reference = await state(direct)
	const result = await state(staged)
	expect({ ...result, events: staged.events }).toEqual({ ...reference, events: staged.events })
	expect(staged.acks).toEqual(direct.acks)
	// The stream really went through the replica (a fallback would also end equal).
	if (messages.length > 1) {
		expect(staged.events.filter((event) => event.startsWith('sync:staging'))).toEqual([
			'sync:staging-started',
			'sync:staging-merged',
		])
	}
	return result
}

describe('a staged initial stream ends as the direct one', () => {
	test('inserts, updates, deletes and a cascade over three batches', async () => {
		const ops = [
			op('insert', 'p1', { name: 'project' }, { collection: 'projects' }),
			op('insert', 'a', { title: 'a', school: 's', projectId: 'p1' }),
			op('insert', 'b', { title: 'b', school: 's' }),
			op('update', 'a', { title: 'a2' }),
			op('insert', 'c', { title: 'c', school: 's', projectId: 'p1' }),
			op('delete', 'b', null),
			op('update', 'c', { school: 't' }),
			op('delete', 'p1', null, { collection: 'projects' }),
		]
		const result = await expectEquivalent(stream(ops, 3))
		expect(result.watermark).toBe(ops.length)
		expect(result.logLessons.length).toBeGreaterThan(0)
	})

	test('concurrent writes by two authors fold the same way', async () => {
		const ops = [
			op('insert', 'a', { title: 'a', school: 's' }, { at: 10 }),
			op('update', 'a', { title: 'from-x' }, { nodeId: 'x', at: 50 }),
			op('update', 'a', { title: 'from-y' }, { nodeId: 'y', at: 40 }),
			op('update', 'a', { tags: ['one'] }, { nodeId: 'x', at: 60 }),
			op('update', 'a', { tags: ['two'] }, { nodeId: 'y', at: 61 }),
			op('insert', 'b', { title: 'b', school: 's' }, { at: 20 }),
		]
		await expectEquivalent(stream(ops, 2))
	})

	test('operations the device cannot apply are quarantined with the same payloads', async () => {
		const ops = [
			op('insert', 'a', { title: 'a', school: 's' }),
			op('insert', 'g1', { title: 'ghost' }, { collection: 'ghosts' }),
			op('insert', 'b', { title: 'b', school: 's' }),
			op('insert', 'g2', { title: 'ghost' }, { collection: 'ghosts' }),
			op('update', 'b', { title: 'b2' }),
		]
		const result = await expectEquivalent(stream(ops, 2))
		expect(result.quarantine).toHaveLength(2)
	})

	test('a single-batch stream is applied directly (nothing to stage)', async () => {
		const staged = await device(true)
		await deliver(staged, batch('only', 0, [op('insert', 'a', { title: 'a', school: 's' })], true))
		expect(staged.events).toEqual([])
		expect((await state(staged)).watermark).toBe(1)
	})

	test('the staged device reports started then merged, once', async () => {
		const staged = await device(true)
		for (const message of stream(
			[
				op('insert', 'a', { title: 'a', school: 's' }),
				op('insert', 'b', { title: 'b', school: 's' }),
				op('insert', 'c', { title: 'c', school: 's' }),
			],
			1,
		)) {
			await deliver(staged, message)
		}
		expect(staged.events).toEqual(['sync:staging-started', 'sync:staging-merged'])
	})
})

/** A small deterministic generator (mulberry32): the same seed always gives the same stream. */
function random(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let x = a
		x = Math.imul(x ^ (x >>> 15), x | 1)
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296
	}
}

/** Operations over a few records and authors, with ties, deletes and unknown collections. */
function randomOperations(seed: number, count: number): Operation[] {
	const next = random(seed)
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
	// Every project exists before a lesson names it: a dangling foreign key stalls the
	// stream on either path, which is not what this property is about.
	const ops: Operation[] = [
		op('insert', 'p1', { name: 'one' }, { collection: 'projects', nodeId: 'x', at: 1 }),
		op('insert', 'p2', { name: 'two' }, { collection: 'projects', nodeId: 'x', at: 2 }),
	]
	for (let index = 0; index < count; index++) {
		const roll = next()
		const nodeId = pick(['x', 'y', 'z'])
		const at = 1_000 + Math.floor(next() * 40)
		if (roll < 0.06) {
			ops.push(op('insert', `g${index}`, { title: 'ghost' }, { collection: 'ghosts', nodeId, at }))
		} else if (roll < 0.2) {
			const id = pick(['p1', 'p2'])
			ops.push(
				roll < 0.17
					? op('insert', id, { name: `n${index}` }, { collection: 'projects', nodeId, at })
					: op('delete', id, null, { collection: 'projects', nodeId, at }),
			)
		} else {
			const id = pick(['a', 'b', 'c', 'd', 'e'])
			const kind = next()
			if (kind < 0.25) {
				ops.push(
					op(
						'insert',
						id,
						{
							title: `t${index}`,
							school: pick(['s', 't']),
							projectId: pick(['p1', 'p2', undefined]),
						},
						{ nodeId, at },
					),
				)
			} else if (kind < 0.8) {
				const field = pick(['title', 'school', 'tags'] as const)
				ops.push(
					op(
						'update',
						id,
						{ [field]: field === 'tags' ? [`v${index % 3}`] : `v${index}` },
						{ nodeId, at },
					),
				)
			} else {
				ops.push(op('delete', id, null, { nodeId, at }))
			}
		}
	}
	return ops
}

describe('staged replication equals direct apply for random operation sets', () => {
	for (let seed = 1; seed <= 30; seed++) {
		test(`seed ${seed}`, async () => {
			const next = random(seed * 7919)
			const ops = randomOperations(seed, 12 + Math.floor(next() * 30))
			await expectEquivalent(stream(ops, 1 + Math.floor(next() * 7)))
		})
	}
})

describe('a device that stops mid-replication loses nothing and keeps nothing half done', () => {
	test('before the merge the live database is untouched, and a restart replicates again', async () => {
		const ops = Array.from({ length: 9 }, (_, index) =>
			op('insert', `r${index}`, { title: `t${index}`, school: 's' }),
		)
		const messages = stream(ops, 3)
		const file = join(tmp, 'crash-before-merge.db')
		const first = await device(true, file)
		await deliver(first, messages[0] as OperationBatchMessage)
		await deliver(first, messages[1] as OperationBatchMessage)
		expect(first.events).toEqual(['sync:staging-started'])
		// Two batches are staged and acknowledged; none of it is in the live database.
		const during = await state(first)
		expect(during.lessons).toEqual([])
		expect(during.logLessons).toEqual([])
		expect(during.versionVector).toEqual([])
		expect(during.watermark).toBe(0)

		// The process dies.
		await first.close()
		devices.splice(devices.indexOf(first), 1)

		const second = await device(true, file)
		expect((await state(second)).watermark).toBe(0)
		for (const message of messages) await deliver(second, message)
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		expect(await state(second)).toEqual(await state(reference))
		expect(second.events).toEqual(['sync:staging-started', 'sync:staging-merged'])
	})

	test('a stop discards the replica and puts the watermark back', async () => {
		const staged = await device(true)
		const messages = stream(
			[
				op('insert', 'a', { title: 'a', school: 's' }),
				op('insert', 'b', { title: 'b', school: 's' }),
				op('insert', 'c', { title: 'c', school: 's' }),
			],
			1,
		)
		await deliver(staged, messages[0] as OperationBatchMessage)
		await staged.engine.stop()
		expect(staged.events).toEqual([
			'sync:staging-started',
			'sync:staging-discarded: the sync engine stopped',
		])
		expect((await state(staged)).watermark).toBe(0)
	})

	test('a crash inside the merge leaves whole records, the old watermark and a correct retry', async () => {
		const ops = Array.from({ length: 240 }, (_, index) =>
			op('insert', `r${String(index).padStart(3, '0')}`, { title: `t${index}`, school: 's' }),
		)
		const messages = stream(ops, 40)
		const staged = await device(true)
		let transactions = 0
		const realTransaction = staged.adapter.transaction.bind(staged.adapter)
		staged.adapter.transaction = async (fn) => {
			// The merge's second chunk dies: the first one has committed.
			transactions += 1
			if (transactions === 2) throw new Error('SQLITE_IOERR: disk I/O error')
			return realTransaction(fn)
		}
		for (const message of messages.slice(0, -1)) await deliver(staged, message)
		await deliver(staged, messages[messages.length - 1] as OperationBatchMessage)
		const crashed = await state(staged)
		// Whatever chunks committed hold whole records: every row has its log entry and its
		// fold state, and the watermark has not moved.
		expect(crashed.watermark).toBe(0)
		expect(crashed.lessons.length).toBe(crashed.logLessons.length)
		expect(crashed.foldStates.length).toBe(crashed.lessons.length)
		expect(staged.events.some((event) => event.startsWith('error STAGING_MERGE_FAILED'))).toBe(true)

		// The engine replicates again, directly; the end state is the reference's.
		staged.adapter.transaction = realTransaction
		await settle(staged)
		for (const message of messages) await deliver(staged, message)
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		const finalState = await state(staged)
		expect(finalState).toEqual(await state(reference))
		expect(finalState.lessons).toHaveLength(240)
	})
})

describe('writes made during replication', () => {
	test('are visible at once, survive the merge and sync with the stream', async () => {
		const ops = [
			op('insert', 'a', { title: 'a', school: 's' }),
			op('insert', 'b', { title: 'b', school: 's' }),
			op('insert', 'c', { title: 'c', school: 's' }),
			op('insert', 'd', { title: 'd', school: 's' }),
		]
		const staged = await device(true)
		const messages = stream(ops, 2)
		await deliver(staged, messages[0] as OperationBatchMessage)
		expect(staged.events).toEqual(['sync:staging-started'])

		const lessons = staged.store.collection('lessons')
		const mine = (await lessons.insert({ title: 'mine', school: 's' })) as { id: string }
		const visibleDuring = (await lessons.where({}).exec()) as Array<{ id: string }>
		expect(visibleDuring.map((row) => row.id)).toEqual([mine.id])

		// The server's stream includes a write by another device to the same record.
		// A second in the future: later than the local insert, inside the accepted clock skew.
		const remoteUpdate = op(
			'update',
			mine.id,
			{ school: 'remote' },
			{ nodeId: 'x', at: Date.now() - EPOCH + 1_000 },
		)
		await deliver(staged, batch('m2', 2, [ops[2] as Operation, remoteUpdate], false))
		await lessons.update(mine.id, { title: 'mine2' })
		await deliver(staged, batch('m3', 4, [ops[3] as Operation], true))

		expect(staged.events).toEqual(['sync:staging-started', 'sync:staging-merged'])
		const rows = (await lessons.where({}).exec()) as Array<{
			id: string
			title: string
			school: string
		}>
		const byId = new Map(rows.map((row) => [row.id, row]))
		expect([...byId.keys()].sort()).toEqual(['a', 'b', 'c', 'd', mine.id].sort())
		expect(byId.get(mine.id)).toMatchObject({ title: 'mine2', school: 'remote' })
		// Both local writes are in the log and still waiting to upload.
		const log = await staged.adapter.query<{ id: string; node_id: string }>(
			'SELECT id, node_id FROM _kora_ops_lessons WHERE record_id = ? ORDER BY sequence_number',
			[mine.id],
		)
		expect(log.filter((row) => row.node_id === 'device-node')).toHaveLength(2)
		expect(log).toHaveLength(3)
		expect((await state(staged)).watermark).toBe(5)
	})

	test('the server echoing a local write back during the stream is a no-op duplicate', async () => {
		const staged = await device(true)
		const lessons = staged.store.collection('lessons')
		const mine = (await lessons.insert({ title: 'mine', school: 's' })) as { id: string }
		const own = (await staged.store.getOperationRange('device-node', 1, 1))[0] as Operation
		const ops = [
			op('insert', 'a', { title: 'a', school: 's' }),
			own,
			op('insert', 'b', { title: 'b', school: 's' }),
		]
		for (const message of stream(ops, 1)) await deliver(staged, message)
		const rows = (await lessons.where({}).exec()) as Array<{ id: string }>
		expect(rows.map((row) => row.id).sort()).toEqual(['a', 'b', mine.id].sort())
		const log = await staged.adapter.query<{ id: string }>(
			'SELECT id FROM _kora_ops_lessons WHERE record_id = ?',
			[mine.id],
		)
		expect(log).toHaveLength(1)
	})
})

describe('a stream staging cannot carry continues directly from the merged prefix', () => {
	test('a batch that narrows the view merges what is staged and is applied directly on top', async () => {
		const ops = [
			op('insert', 'a', { title: 'a', school: 's' }),
			op('insert', 'b', { title: 'b', school: 't' }),
			op('insert', 'c', { title: 'c', school: 's' }),
		]
		const messages = stream(ops, 1)
		const narrowing = {
			...(messages[1] as OperationBatchMessage),
			accessNarrowing: { lessons: { school: 's' } },
		}
		const sent = [
			messages[0] as OperationBatchMessage,
			narrowing,
			messages[2] as OperationBatchMessage,
		]
		const staged = await device(true)
		await deliver(staged, sent[0] as OperationBatchMessage)
		expect(staged.events).toEqual(['sync:staging-started'])
		await deliver(staged, sent[1] as OperationBatchMessage)
		// The staged prefix (batch 1) is in the database with its watermark; the narrowing
		// batch was applied directly on top of it; no restart.
		expect(staged.events).toEqual(['sync:staging-started', 'sync:staging-merged'])
		await deliver(staged, sent[2] as OperationBatchMessage)
		const reference = await device(false)
		for (const message of sent) await deliver(reference, message)
		expect(await state(staged)).toEqual(await state(reference))
		expect(staged.acks).toEqual(reference.acks)
	})
})

/** A chained batch with scope retractions (retraction `i` leaves a record after `after` operations). */
function batchWithRetractions(
	id: string,
	base: number,
	operations: Operation[],
	retractions: Array<{ recordId: string; after: number }>,
	isFinal = false,
): OperationBatchMessage {
	return {
		...batch(id, base, operations, isFinal),
		maxDeliverySequence: base + operations.length + retractions.length,
		operationSequences: operations.map((_, index) => base + index + 1),
		retractions: retractions.map(
			(retraction): ScopeRetraction => ({
				collection: 'lessons',
				recordId: retraction.recordId,
				afterOperations: retraction.after,
				deliverySequence: base + retraction.after + 1,
			}),
		),
	}
}

describe('the staged path keeps the delivery invariants', () => {
	const three = (): Operation[] => [
		op('insert', 'a', { title: 'a', school: 's' }),
		op('insert', 'b', { title: 'b', school: 's' }),
		op('insert', 'c', { title: 'c', school: 's' }),
	]

	test('nothing is announced or notified about staged operations until they are in the database', async () => {
		const staged = await device(true)
		const seen: number[] = []
		const unsubscribe = staged.store
			.collection('lessons')
			.where({})
			.subscribe((rows) => seen.push(rows.length))
		await drain(staged.engine)
		const baseline = staged.published.length
		const messages = stream(three(), 1)
		await deliver(staged, messages[0] as OperationBatchMessage)
		await deliver(staged, messages[1] as OperationBatchMessage)
		// Two batches are staged: no apply event, merge trace or query notification reached the
		// database's listeners, and the subscriber still sees no rows.
		expect(staged.published.slice(baseline)).toEqual([])
		expect(seen.at(-1)).toBe(0)
		await deliver(staged, messages[2] as OperationBatchMessage)
		// After the merge committed the subscriber sees all three rows.
		await drain(staged.engine)
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(seen.at(-1)).toBe(3)
		unsubscribe()
	})

	test('a failed apply leaves the watermark at the batch base: the merged prefix is the watermark, the batch is unacknowledged and retried', async () => {
		const staged = await device(true, undefined, true)
		const ops = three()
		const messages = stream(ops, 1)
		;(staged.syncStore as StallingSyncStore).stalling.add(ops[1]?.id ?? '')
		await deliver(staged, messages[0] as OperationBatchMessage)
		await deliver(staged, messages[1] as OperationBatchMessage)
		// Batch 2 failed in the replica (its rollback left the replica at batch 1); the staged
		// prefix was merged and the batch was applied directly, where it stalled too.
		expect(staged.acks).toEqual([1])
		const mid = await state(staged)
		expect(mid.watermark).toBe(1)
		expect(mid.logLessons).toHaveLength(1)

		// The database recovers; the server re-sends from the acknowledged position.
		;(staged.syncStore as StallingSyncStore).stalling.clear()
		for (const message of messages.slice(1)) await deliver(staged, message)
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		expect(await state(staged)).toEqual(await state(reference))
		expect(staged.acks).toEqual([1, 2, 3])
	})

	test('a stall in the final batch completes nothing: watermark at the batch base, then it recovers', async () => {
		const staged = await device(true, undefined, true)
		const ops = three()
		const messages = stream(ops, 1)
		;(staged.syncStore as StallingSyncStore).stalling.add(ops[2]?.id ?? '')
		for (const message of messages) await deliver(staged, message)
		const after = await state(staged)
		expect(after.watermark).toBe(2)
		expect(after.lessons).toHaveLength(2)
		expect(staged.acks).toEqual([1, 2])
		;(staged.syncStore as StallingSyncStore).stalling.clear()
		await deliver(staged, messages[2] as OperationBatchMessage)
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		expect(await state(staged)).toEqual(await state(reference))
	})

	test('retractions are honoured: the staged prefix is merged and the retracting batch is applied directly, as the reference', async () => {
		const ops = [
			op('insert', 'moved', { title: 'm', school: 's' }),
			op('insert', 'back', { title: 'b', school: 's' }),
			op('update', 'back', { title: 'b2' }),
			op('insert', 'stays', { title: 's', school: 's' }),
		]
		const messages = [
			batch('r1', 0, [ops[0] as Operation], false),
			batchWithRetractions(
				'r2',
				1,
				[ops[1] as Operation, ops[2] as Operation, ops[3] as Operation],
				[
					{ recordId: 'moved', after: 0 },
					{ recordId: 'back', after: 1 },
				],
				true,
			),
		]
		const staged = await device(true)
		for (const message of messages) await deliver(staged, message)
		expect(staged.events).toEqual(['sync:staging-started', 'sync:staging-merged'])
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		const result = await state(staged)
		expect(result).toEqual(await state(reference))
		expect(result.retractions.length).toBeGreaterThan(0)
	})

	test("the replica's apply events are replayed to the live listeners only after the merge committed", async () => {
		const staged = await device(true)
		const messages = stream(three(), 1)
		await deliver(staged, messages[0] as OperationBatchMessage)
		await deliver(staged, messages[1] as OperationBatchMessage)
		expect(staged.published.filter((type) => type === 'operation:applied')).toHaveLength(0)
		await deliver(staged, messages[2] as OperationBatchMessage)
		expect(staged.published.filter((type) => type === 'operation:applied')).toHaveLength(3)
	})
})

/** The number of storage transactions the live database sees while the final batch merges. */
async function mergeTransactionCount(messages: OperationBatchMessage[]): Promise<number> {
	const probe = await device(true)
	let count = 0
	for (const message of messages.slice(0, -1)) await deliver(probe, message)
	const real = probe.adapter.transaction.bind(probe.adapter)
	probe.adapter.transaction = async (fn) => {
		count += 1
		return real(fn)
	}
	await deliver(probe, messages[messages.length - 1] as OperationBatchMessage)
	probe.adapter.transaction = real
	return count
}

describe('crash injection at every phase boundary', () => {
	const ops = Array.from({ length: 150 }, (_, index) =>
		op('insert', `r${String(index).padStart(3, '0')}`, { title: `t${index}`, school: 's' }),
	)
	const messages = stream(ops, 30)

	test('killed after each staged batch: the database is untouched, a restart equals direct apply', async () => {
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		const expected = await state(reference)
		for (let killedAfter = 1; killedAfter < messages.length; killedAfter++) {
			const file = join(tmp, `kill-after-${killedAfter}.db`)
			const first = await device(true, file)
			for (const message of messages.slice(0, killedAfter)) await deliver(first, message)
			const during = await state(first)
			expect(during.lessons).toEqual([])
			expect(during.logLessons).toEqual([])
			expect(during.foldStates).toEqual([])
			expect(during.versionVector).toEqual([])
			expect(during.quarantine).toEqual([])
			expect(during.watermark).toBe(0)
			await first.close()
			devices.splice(devices.indexOf(first), 1)
			const second = await device(true, file)
			for (const message of messages) await deliver(second, message)
			expect(await state(second)).toEqual(expected)
		}
	})

	test('the live database fails at each transaction of the merge, including the last: whole records, old watermark, correct retry', async () => {
		const total = await mergeTransactionCount(messages)
		expect(total).toBeGreaterThanOrEqual(2)
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		const expected = await state(reference)
		let crashedInMerge = 0
		let mergedBeforeFailure = 0
		for (let failAt = 1; failAt <= total; failAt++) {
			const staged = await device(true)
			for (const message of messages.slice(0, -1)) await deliver(staged, message)
			let transactions = 0
			const real = staged.adapter.transaction.bind(staged.adapter)
			staged.adapter.transaction = async (fn) => {
				transactions += 1
				if (transactions === failAt) throw new Error('SQLITE_IOERR: disk I/O error')
				return real(fn)
			}
			await deliver(staged, messages[messages.length - 1] as OperationBatchMessage)
			staged.adapter.transaction = real
			const crashed = await state(staged)
			if (staged.events.includes('sync:staging-merged')) {
				// The failing transaction came after the merge's last one (bookkeeping after the
				// commit): the stream is complete and the watermark is the stream's.
				mergedBeforeFailure += 1
				expect(crashed.watermark).toBe(ops.length)
				expect(crashed.lessons).toHaveLength(ops.length)
				continue
			}
			// Every row that reached the database has its log entries and fold state (never a
			// state without its log) and the delivery watermark did not pass any of it.
			expect(crashed.watermark).toBe(0)
			expect(crashed.lessons).toHaveLength(crashed.logLessons.length)
			expect(crashed.foldStates).toHaveLength(crashed.lessons.length)
			crashedInMerge += 1
			await settle(staged)
			for (const message of messages) await deliver(staged, message)
			expect(await state(staged)).toEqual(expected)
		}
		// Both kinds of boundary were exercised: inside the merge (including its last, progress
		// transaction) and after it.
		expect(crashedInMerge).toBeGreaterThanOrEqual(2)
		expect(crashedInMerge + mergedBeforeFailure).toBe(total)
	})
})
