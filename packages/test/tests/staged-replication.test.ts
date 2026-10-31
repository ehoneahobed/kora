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
	/** Delivery events (`sync:received`, `sync:acknowledged`, `sync:apply-failed`, `sync:apply-blocked`) in order. */
	delivery: string[]
	syncStore: MergeAwareSyncStore
	acks: number[]
	close(): Promise<void>
}

const devices: Device[] = []
afterEach(async () => {
	for (const device of devices.splice(0)) await device.close()
})

let deviceCounter = 0
interface DeviceOptions {
	/** Overrides `bulkReplication` (default: `{ minOperations: 0 }` when staged, `false` otherwise). */
	bulk?: boolean | { minOperations?: number; maxOperations?: number; maxBytes?: number }
	/** `serverMaxDeliverySequence` of the handshake response. */
	frontier?: number
	/** `acceptedDownlinkScopes` of the handshake response (read at each response). */
	acceptedScope?: Record<string, Record<string, unknown>>
	/** The signed-in user, when the engine tracks one. */
	principal?: () => Promise<string | null>
}

async function device(
	staged: boolean,
	file?: string,
	stalling = false,
	options: DeviceOptions = {},
): Promise<Device> {
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
				...(options.frontier !== undefined ? { serverMaxDeliverySequence: options.frontier } : {}),
				...(options.acceptedScope ? { acceptedDownlinkScopes: options.acceptedScope } : {}),
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
			bulkReplication: 'bulk' in options ? options.bulk : staged ? { minOperations: 0 } : false,
			...(options.principal ? { principal: options.principal } : {}),
		},
		emitter,
	})
	emitter.on('operation:created', (event) => {
		void engine.pushOperation(event.operation)
	})
	const events: string[] = []
	const published: string[] = []
	const delivery: string[] = []
	for (const type of [
		'sync:received',
		'sync:acknowledged',
		'sync:apply-failed',
		'sync:apply-blocked',
	] as const) {
		emitter.on(type, () => delivery.push(type))
	}
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
		delivery,
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
		let sawThreeRows: () => void = () => undefined
		const sawThree = new Promise<void>((resolve) => {
			sawThreeRows = resolve
		})
		const unsubscribe = staged.store
			.collection('lessons')
			.where({})
			.subscribe((rows) => {
				seen.push(rows.length)
				if (rows.length === 3) sawThreeRows()
			})
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
		// Subscribers are re-run in a microtask batch: wait for the notification itself.
		await sawThree
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

// ---------------------------------------------------------------------------------------------
// Cold review of PR 137: clock, events, quarantine replay, stop, principal, memory, replica phase.
// ---------------------------------------------------------------------------------------------

function numberedOps(count: number, options: { at?: number; prefix?: string } = {}): Operation[] {
	return Array.from({ length: count }, (_, index) =>
		op(
			'insert',
			`${options.prefix ?? 'r'}${String(index).padStart(3, '0')}`,
			{ title: `t${index}`, school: 's' },
			options.at === undefined ? {} : { at: options.at + index },
		),
	)
}

/** Fails (or watches) the live database's transactions by call number. */
function interceptLiveTransactions(
	target: Device,
	hook: (n: number, run: () => Promise<void>) => Promise<void> | undefined,
): () => void {
	let n = 0
	const real = target.adapter.transaction.bind(target.adapter)
	target.adapter.transaction = async (fn) => {
		n += 1
		const held = hook(n, async () => undefined)
		if (held) await held
		return real(fn)
	}
	return () => {
		target.adapter.transaction = real
	}
}

describe('clock adoption: a local edit made while the merge runs is stamped after what it overwrites', () => {
	// A remote clock 60 s ahead: inside the 5 minute tolerance, so the stamps are accepted.
	const ahead = (): number => Date.now() - EPOCH + 60_000

	test('direct reference: a local edit after the stream wins', async () => {
		const direct = await device(false)
		for (const message of stream(numberedOps(240, { at: ahead() }), 40))
			await deliver(direct, message)
		await direct.store.collection('lessons').update('r000', { title: 'LOCAL' })
		const row = (await direct.store.collection('lessons').findById('r000')) as { title: string }
		expect(row.title).toBe('LOCAL')
	})

	test('staged: an edit between merge chunks (the row is already readable) is not lost', async () => {
		const staged = await device(true)
		const messages = stream(numberedOps(240, { at: ahead() }), 40)
		for (const message of messages.slice(0, -1)) await deliver(staged, message)
		let editing = false
		const restore = interceptLiveTransactions(staged, (n) => {
			if (n !== 2 || editing) return undefined
			editing = true
			return (async () => {
				// Chunk 1 is committed: its rows are visible and the user edits one of them.
				expect(await staged.store.collection('lessons').findById('r000')).not.toBeNull()
				await staged.store.collection('lessons').update('r000', { title: 'LOCAL' })
			})()
		})
		await deliver(staged, messages[messages.length - 1] as OperationBatchMessage)
		restore()
		const row = (await staged.store.collection('lessons').findById('r000')) as { title: string }
		expect(row.title).toBe('LOCAL')
		expect(staged.events.filter((event) => event.startsWith('sync:staging'))).toEqual([
			'sync:staging-started',
			'sync:staging-merged',
		])
	})

	test('staged: field versions of a scope entry count as well as its own timestamp', async () => {
		const wall = ahead()
		const make = (): Operation[] =>
			numberedOps(240).map((operation) => ({
				...operation,
				// The operation's own stamp is old; its title was last written 60 s ahead.
				fieldVersions: {
					title: { wallTime: EPOCH + wall + 1, logical: 0, nodeId: 'author-node' },
					school: { wallTime: EPOCH + wall + 1, logical: 0, nodeId: 'author-node' },
				},
			}))
		const run = async (staged: boolean): Promise<string> => {
			const target = await device(staged)
			const messages = stream(make(), 40)
			for (const message of messages.slice(0, -1)) await deliver(target, message)
			let editing = false
			const restore = interceptLiveTransactions(target, (n) => {
				if (n !== 2 || editing || !staged) return undefined
				editing = true
				return target.store
					.collection('lessons')
					.update('r000', { title: 'LOCAL' })
					.then(() => undefined)
			})
			await deliver(target, messages[messages.length - 1] as OperationBatchMessage)
			restore()
			if (!staged) await target.store.collection('lessons').update('r000', { title: 'LOCAL' })
			return ((await target.store.collection('lessons').findById('r000')) as { title: string })
				.title
		}
		expect(await run(false)).toBe('LOCAL')
		expect(await run(true)).toBe('LOCAL')
	})
})

describe('delivery events of a staged stream are published after the live commit', () => {
	test('received, acknowledged and apply-failed are held until the merge committed; an acknowledgement on the wire is flow control', async () => {
		const staged = await device(true)
		const ops = [
			op('insert', 'a', { title: 'a', school: 's' }),
			op('insert', 'g1', { title: 'ghost' }, { collection: 'ghosts' }),
			op('insert', 'b', { title: 'b', school: 's' }),
			op('insert', 'c', { title: 'c', school: 's' }),
		]
		const messages = stream(ops, 2)
		await deliver(staged, messages[0] as OperationBatchMessage)
		// The replica holds the batch and the server was told it arrived (session flow control),
		// but no listener was told anything about data the live database does not have.
		expect(staged.acks).toEqual([2])
		expect(staged.delivery).toEqual([])
		const before = await state(staged)
		expect(before.lessons).toEqual([])
		expect(before.quarantine).toEqual([])
		expect(before.watermark).toBe(0)
		await deliver(staged, messages[1] as OperationBatchMessage)
		const after = await state(staged)
		expect(after.lessons).toHaveLength(3)
		expect(after.quarantine).toHaveLength(1)
		expect(after.watermark).toBe(4)
		// Now they are published, in stream order: batch 1 first.
		expect(staged.delivery).toEqual([
			'sync:apply-failed',
			'sync:received',
			'sync:acknowledged',
			'sync:received',
			'sync:acknowledged',
		])
		// The direct path reports the same things.
		const direct = await device(false)
		for (const message of messages) await deliver(direct, message)
		expect(staged.delivery.slice().sort()).toEqual(direct.delivery.slice().sort())
	})

	test('a stop before the merge publishes nothing, and the restart reports it again', async () => {
		const file = join(tmp, 'events-stop.db')
		const staged = await device(true, file)
		const ops = [
			op('insert', 'a', { title: 'a', school: 's' }),
			op('insert', 'g1', { title: 'ghost' }, { collection: 'ghosts' }),
			op('insert', 'b', { title: 'b', school: 's' }),
			op('insert', 'c', { title: 'c', school: 's' }),
		]
		const messages = stream(ops, 2)
		await deliver(staged, messages[0] as OperationBatchMessage)
		await staged.engine.stop()
		expect(staged.delivery).toEqual([])
		const after = await state(staged)
		expect(after.lessons).toEqual([])
		expect(after.quarantine).toEqual([])
		await staged.close()
		devices.splice(devices.indexOf(staged), 1)
		const again = await device(true, file)
		for (const message of messages) await deliver(again, message)
		expect(again.delivery).toContain('sync:apply-failed')
		expect(again.delivery.filter((type) => type === 'sync:received')).toHaveLength(2)
	})
})

describe('the quarantine is replayed once after a merge that brought quarantined operations', () => {
	test('replayQuarantine runs after the merge when the replica quarantined something, and not otherwise', async () => {
		for (const withGhost of [false, true]) {
			const staged = await device(true)
			let replays = 0
			const engine = staged.engine as unknown as { replayQuarantine(): Promise<number> }
			const real = engine.replayQuarantine.bind(engine)
			engine.replayQuarantine = async () => {
				replays += 1
				return real()
			}
			const ops = [
				op('insert', 'a', { title: 'a', school: 's' }),
				op(
					'insert',
					withGhost ? 'g1' : 'b',
					withGhost ? { title: 'ghost' } : { title: 'b', school: 's' },
					withGhost ? { collection: 'ghosts' } : {},
				),
				op('insert', 'c', { title: 'c', school: 's' }),
			]
			const messages = stream(ops, 1)
			for (const message of messages.slice(0, -1)) await deliver(staged, message)
			expect(replays).toBe(0)
			await deliver(staged, messages[messages.length - 1] as OperationBatchMessage)
			expect(replays).toBe(withGhost ? 1 : 0)
			expect((await state(staged)).quarantine).toHaveLength(withGhost ? 1 : 0)
		}
	})
})

describe('stop() cancels a merge in flight and waits for it', () => {
	test('a chunk gated inside the merge cannot commit after stop() has returned', async () => {
		const staged = await device(true, join(tmp, 'stop-merge.db'))
		const messages = stream(numberedOps(1500), 300)
		for (const message of messages.slice(0, -1)) await deliver(staged, message)
		let release: () => void = () => undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let reached: () => void = () => undefined
		const hit = new Promise<void>((resolve) => {
			reached = resolve
		})
		const restore = interceptLiveTransactions(staged, (n) => {
			if (n !== 2) return undefined
			reached()
			return gate
		})
		const finalDelivery = deliver(staged, messages[messages.length - 1] as OperationBatchMessage)
		await hit
		let stopped = false
		const stopping = staged.engine.stop().then(() => {
			stopped = true
		})
		await new Promise((resolve) => setTimeout(resolve, 30))
		// stop() waits for the chunk in flight; it does not return while the merge could commit.
		expect(stopped).toBe(false)
		release()
		await stopping
		await finalDelivery.catch(() => undefined)
		restore()
		const atStop = await state(staged)
		await new Promise((resolve) => setTimeout(resolve, 100))
		const later = await state(staged)
		// Nothing was written after stop() returned, and what is there is whole records only.
		expect(later).toEqual(atStop)
		expect(later.lessons.length).toBeLessThan(1500)
		expect(later.logLessons).toHaveLength(later.lessons.length)
		expect(later.foldStates).toHaveLength(later.lessons.length)
		expect(later.watermark).toBe(0)
		// A restart replicates the whole stream again and ends as the direct path does.
		await staged.close()
		devices.splice(devices.indexOf(staged), 1)
		const again = await device(true, join(tmp, 'stop-merge.db'))
		for (const message of messages) await deliver(again, message)
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		expect(await state(again)).toEqual(await state(reference))
	})
})

describe('events of a merge that did not finish', () => {
	test('records an earlier chunk made live still report operation:applied once the stream is replicated directly', async () => {
		const messages = stream(numberedOps(240), 40)
		const direct = await device(false)
		for (const message of messages) await deliver(direct, message)
		const staged = await device(true)
		for (const message of messages.slice(0, -1)) await deliver(staged, message)
		const restore = interceptLiveTransactions(staged, (n) => {
			if (n === 2) throw new Error('SQLITE_IOERR: disk I/O error')
			return undefined
		})
		await deliver(staged, messages[messages.length - 1] as OperationBatchMessage)
		restore()
		await settle(staged)
		for (const message of messages) await deliver(staged, message)
		const applied = (target: Device): number =>
			target.published.filter((type) => type === 'operation:applied').length
		expect(applied(staged)).toBe(applied(direct))
		expect(await state(staged)).toEqual(await state(direct))
	})
})

describe('a replica never merges for another user, and credentials that end the session end the replica', () => {
	const ops = numberedOps(90)
	const messages = stream(ops, 30)

	test('the server rejecting the credentials drops the replica', async () => {
		const staged = await device(true)
		await deliver(staged, messages[0] as OperationBatchMessage)
		staged.server.send({
			type: 'error',
			messageId: 'e1',
			code: 'AUTH_FAILED',
			message: 'bad token',
			retriable: false,
		} as unknown as SyncMessage)
		await drain(staged.engine)
		expect(staged.events).toContain('sync:staging-discarded: the server rejected the credentials')
		expect((await state(staged)).lessons).toEqual([])
	})

	test('an expired or revoked credential drops the replica', async () => {
		const staged = await device(true)
		await deliver(staged, messages[0] as OperationBatchMessage)
		staged.server.send({
			type: 'error',
			messageId: 'e2',
			code: 'AUTH_REVOKED',
			message: 'revoked',
			retriable: true,
		} as unknown as SyncMessage)
		await drain(staged.engine)
		expect(staged.events).toContain('sync:staging-discarded: the credential expired or was revoked')
	})

	test('a different signed-in user while the engine is disconnected drops the replica', async () => {
		let user: string | null = 'user-a'
		const staged = await device(true, undefined, false, { principal: async () => user })
		await deliver(staged, messages[0] as OperationBatchMessage)
		;(
			staged.engine as unknown as { handleTransportClose(reason: string): void }
		).handleTransportClose('network lost')
		user = 'user-b'
		await staged.engine.bindSignedInUser()
		expect(staged.events).toContain('sync:staging-discarded: the signed-in user changed')
		// Nothing of user A's stream reached the database.
		expect((await state(staged)).lessons).toEqual([])
	})
})

describe('the replica is bounded in memory and in the real defaults', () => {
	const ops = numberedOps(120)
	const messages = stream(ops, 30)

	test('a replica above maxBytes is merged as it is and the rest of the stream continues directly, ending as the direct path', async () => {
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		const staged = await device(true, undefined, false, { bulk: { minOperations: 0, maxBytes: 1 } })
		await deliver(staged, messages[0] as OperationBatchMessage)
		// The first batch already exceeded the cap: it is live now, under its watermark.
		const afterFirst = await state(staged)
		expect(afterFirst.lessons).toHaveLength(30)
		expect(afterFirst.watermark).toBe(30)
		for (const message of messages.slice(1)) await deliver(staged, message)
		await settle(staged)
		expect(await state(staged)).toEqual(await state(reference))
		// Merged, then everything else direct.
		expect(staged.events.filter((event) => event.startsWith('sync:staging'))).toEqual([
			'sync:staging-started',
			'sync:staging-merged',
		])
	})

	test('a server frontier above maxOperations is never staged', async () => {
		const staged = await device(true, undefined, false, {
			bulk: { minOperations: 0, maxOperations: 50 },
			frontier: 120,
		})
		for (const message of messages) await deliver(staged, message)
		expect(staged.events.filter((event) => event.startsWith('sync:staging'))).toEqual([])
		expect((await state(staged)).lessons).toHaveLength(120)
	})

	test('the real default threshold: 1999 operations apply directly, 2000 are staged', async () => {
		for (const [frontier, expected] of [
			[1999, []],
			[2000, ['sync:staging-started', 'sync:staging-merged']],
		] as const) {
			const staged = await device(true, undefined, false, { bulk: true, frontier })
			for (const message of messages) await deliver(staged, message)
			expect(staged.events.filter((event) => event.startsWith('sync:staging'))).toEqual(expected)
			expect((await state(staged)).lessons).toHaveLength(120)
		}
	})

	test('native SQLite stages only when asked to (it has no journaled commit to avoid)', async () => {
		const byDefault = await device(true, undefined, false, { bulk: undefined, frontier: 5000 })
		const explicit = await device(true, undefined, false, { bulk: true, frontier: 5000 })
		for (const message of messages) {
			await deliver(byDefault, message)
			await deliver(explicit, message)
		}
		expect(byDefault.events.filter((event) => event.startsWith('sync:staging'))).toEqual([])
		expect(explicit.events.filter((event) => event.startsWith('sync:staging'))).toEqual([
			'sync:staging-started',
			'sync:staging-merged',
		])
		expect(await state(byDefault)).toEqual(await state(explicit))
	})
})

describe('the replica phase: atomic batches and crashes inside the replica', () => {
	interface ReplicaProbe {
		transactions: number
		failAt: number
		/** `fn` ran, then the transaction was rolled back (the process died before the commit). */
		failed: boolean
		adapters: BetterSqlite3Adapter[]
	}

	function probeReplica(target: Device, failAt = 0): ReplicaProbe {
		const probe: ReplicaProbe = { transactions: 0, failAt, failed: false, adapters: [] }
		const real = target.adapter.createStagingAdapter?.bind(target.adapter)
		target.adapter.createStagingAdapter = async () => {
			const created = real ? await real() : null
			if (created === null) return null
			const adapter = created as BetterSqlite3Adapter
			probe.adapters.push(adapter)
			const tx = adapter.transaction.bind(adapter)
			adapter.transaction = async (fn) => {
				probe.transactions += 1
				if (probe.transactions === probe.failAt) {
					probe.failed = true
					await tx(async (inner) => {
						await fn(inner)
						throw new Error('SQLITE_IOERR: the process died before the commit')
					})
					return
				}
				return tx(fn)
			}
			return adapter
		}
		return probe
	}

	const ops = [
		op('insert', 'a', { title: 'a', school: 's' }),
		op('insert', 'g1', { title: 'ghost' }, { collection: 'ghosts' }),
		op('insert', 'b', { title: 'b', school: 's' }),
		op('insert', 'c', { title: 'c', school: 's' }),
		op('insert', 'd', { title: 'd', school: 's' }),
		op('insert', 'e', { title: 'e', school: 's' }),
	]
	const messages = stream(ops, 2)

	test('a batch is one replica transaction: its rows, quarantine row and watermark together', async () => {
		const staged = await device(true)
		const probe = probeReplica(staged)
		await deliver(staged, messages[0] as OperationBatchMessage)
		const afterOpen = probe.transactions
		await deliver(staged, messages[1] as OperationBatchMessage)
		expect(probe.transactions - afterOpen).toBe(1)
		const replica = probe.adapters[0]
		const rows = await replica?.query<{ n: number }>('SELECT COUNT(*) AS n FROM lessons')
		expect(rows?.[0]?.n).toBe(3)
	})

	test('a crash before the commit of a replica batch leaves the replica at the previous batch (rows, quarantine and watermark all rolled back)', async () => {
		const staged = await device(true)
		const probe = probeReplica(staged)
		await deliver(staged, messages[0] as OperationBatchMessage)
		probe.failAt = probe.transactions + 1
		const replica = probe.adapters[0] as BetterSqlite3Adapter
		const marks = async (): Promise<{
			lessons: number
			quarantine: number
			watermark: string[]
		}> => ({
			lessons: (await replica.query<{ n: number }>('SELECT COUNT(*) AS n FROM lessons'))[0]?.n ?? 0,
			quarantine:
				(await replica.query<{ n: number }>('SELECT COUNT(*) AS n FROM _kora_unapplied_ops'))[0]
					?.n ?? 0,
			watermark: (
				await replica.query<{ value: string }>(
					"SELECT value FROM _kora_meta WHERE key LIKE '%watermark%'",
				)
			).map((row) => row.value),
		})
		const before = await marks()
		// The second batch dies in the replica; the engine falls back (prefix merge, direct apply).
		await deliver(staged, messages[1] as OperationBatchMessage)
		expect(probe.failed).toBe(true)
		const live = await state(staged)
		// Batch 1 (one record, one quarantined ghost) is live under watermark 2; batch 2 was
		// applied directly on top, so its operations are live and the watermark chains on.
		expect(before.lessons).toBe(1)
		expect(live.watermark).toBe(4)
		expect(live.lessons).toHaveLength(3)
	})

	test('a crash at each replica transaction: the stream always ends as the direct apply does', async () => {
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		const expected = await state(reference)
		const counter = await device(true)
		const baseline = probeReplica(counter)
		for (const message of messages) await deliver(counter, message)
		const total = baseline.transactions
		expect(total).toBeGreaterThan(messages.length)
		for (let failAt = 1; failAt <= total; failAt++) {
			const staged = await device(true)
			const probe = probeReplica(staged, failAt)
			for (const message of messages) await deliver(staged, message)
			await settle(staged)
			// The server re-sends what was not acknowledged; deliver the whole stream again.
			for (const message of messages) await deliver(staged, message)
			await settle(staged)
			for (const message of messages) await deliver(staged, message)
			expect(probe.failed || failAt > probe.transactions).toBe(true)
			expect(await state(staged)).toEqual(expected)
		}
	})

	test('a batch above 500 operations that stalls in a later chunk of the replica falls back and recovers', async () => {
		const many = Array.from({ length: 1300 }, (_, index) =>
			op('insert', `q${String(index).padStart(4, '0')}`, { title: `t${index}`, school: 's' }),
		)
		const first = batch('b1', 0, many.slice(0, 1250), false)
		const second = batch('b2', 1250, many.slice(1250), true)
		const reference = await device(false)
		await deliver(reference, first)
		await deliver(reference, second)
		const staged = await device(true, undefined, true)
		;(staged.syncStore as StallingSyncStore).stalling.add(many[700]?.id ?? '')
		await deliver(staged, first)
		// The batch did not complete anywhere: the watermark is still at its base.
		expect((await state(staged)).watermark).toBe(0)
		;(staged.syncStore as StallingSyncStore).stalling.clear()
		await deliver(staged, first)
		await deliver(staged, second)
		expect(await state(staged)).toEqual(await state(reference))
	})
})

describe('chunks are bounded by operations, not only by records', () => {
	test('a few records with long histories merge in several chunks and end as the direct path does', async () => {
		const ops: Operation[] = []
		for (let record = 0; record < 6; record++) {
			const id = `h${record}`
			ops.push(op('insert', id, { title: 'v0', school: 's' }))
			for (let version = 1; version <= 1500; version++) {
				ops.push(
					op(
						'update',
						id,
						{ title: `v${version}` },
						{ previousData: { title: `v${version - 1}` } },
					),
				)
			}
		}
		const messages = stream(ops, 3000)
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		// 6 records, 1501 operations each: a record count alone would put all 6 in one chunk.
		expect(await mergeTransactionCount(messages)).toBeGreaterThanOrEqual(4)
		const staged = await device(true)
		for (const message of messages) await deliver(staged, message)
		expect(await state(staged)).toEqual(await state(reference))
	}, 120_000)
})

describe('a local write made while a stream is staged meets a staged delete of the thing it references', () => {
	test('a lesson created under a project the live database cannot see yet is refused loudly; the stream is unaffected', async () => {
		const project = op('insert', 'p1', { name: 'P' }, { collection: 'projects' })
		const lesson = op('insert', 'a', { title: 'a', school: 's', projectId: 'p1' })
		const removal = op('delete', 'p1', null, { collection: 'projects', at: 5000 })
		const messages = stream([project, lesson, removal], 1)
		const outcome = async (
			staged: boolean,
		): Promise<{ lessons: unknown[]; error: string | null }> => {
			const target = await device(staged)
			for (const message of messages.slice(0, -1)) await deliver(target, message)
			let error: string | null = null
			try {
				await target.store
					.collection('lessons')
					.insert({ title: 'local', school: 's', projectId: 'p1' })
			} catch (caught) {
				error = (caught as Error).name
			}
			await deliver(target, messages[messages.length - 1] as OperationBatchMessage)
			await settle(target)
			return { lessons: (await state(target)).lessons, error }
		}
		const direct = await outcome(false)
		const staged = await outcome(true)
		type Row = { id: string; projectId: string | null; _deleted: number }
		const visible = (rows: unknown[]): Row[] => (rows as Row[]).filter((row) => row._deleted === 0)
		// The project is not visible in the live database during staging, so the local insert is
		// judged against an empty database; the stream's delete of the project then cascades. The
		// final state holds no visible lesson under the deleted project, exactly as the direct path.
		// While staged, the project is not in the live database, so the foreign key refuses the
		// local insert, loudly (the caller gets the error; nothing is lost silently). The user
		// could not have picked a project they cannot see; the direct path accepts it only
		// because the project is already live there.
		expect(direct.error).toBeNull()
		expect(staged.error).not.toBeNull()
		// The stream itself ends the same on both paths: the staged lesson `a` equals the direct one.
		const lessonA = (rows: unknown[]): Row[] => visible(rows).filter((row) => row.id === 'a')
		expect(lessonA(staged.lessons)).toEqual(lessonA(direct.lessons))
	})
})

describe('whatever changes the delivery view drops the replica and restores the live position', () => {
	const messages = stream(numberedOps(90), 30)
	const stagedAfterTwo = async (options: DeviceOptions = {}): Promise<Device> => {
		const target = await device(true, undefined, false, options)
		await deliver(target, messages[0] as OperationBatchMessage)
		await deliver(target, messages[1] as OperationBatchMessage)
		expect(position(target)).toBe(60)
		expect((await state(target)).lessons).toEqual([])
		return target
	}
	const position = (target: Device): number =>
		(target.engine as unknown as { deliveryWatermark: number }).deliveryWatermark
	const discards = (target: Device): string[] =>
		target.events.filter((event) => event.startsWith('sync:staging-discarded'))

	test('a query subset registered while staging', async () => {
		const target = await stagedAfterTwo()
		target.engine.registerQuerySubset({ collection: 'lessons', where: { school: 's' } })
		expect(discards(target)).toEqual(['sync:staging-discarded: the query subsets changed'])
		expect(position(target)).toBe(0)
		expect((await state(target)).watermark).toBe(0)
	})

	test('the server accepting another scope than the one requested', async () => {
		const options: DeviceOptions = {}
		const target = await stagedAfterTwo(options)
		;(
			target.engine as unknown as { handleTransportClose(reason: string): void }
		).handleTransportClose('network lost')
		options.acceptedScope = { lessons: { school: 'other' } }
		await target.engine.start()
		await drain(target.engine)
		expect(discards(target)).toEqual(['sync:staging-discarded: the delivery view changed'])
		expect(position(target)).toBe(0)
	})

	test('a server whose delivery log was rolled back', async () => {
		const options: DeviceOptions = {}
		const target = await stagedAfterTwo(options)
		;(
			target.engine as unknown as { handleTransportClose(reason: string): void }
		).handleTransportClose('network lost')
		options.frontier = 10
		await target.engine.start()
		await drain(target.engine)
		expect(discards(target)).toEqual([
			"sync:staging-discarded: the server's delivery log was rolled back",
		])
		expect(position(target)).toBe(0)
	})

	test('a full resync requested by the app', async () => {
		const target = await stagedAfterTwo()
		await (
			target.engine as unknown as { resetDeliveryForFullResync(): Promise<void> }
		).resetDeliveryForFullResync()
		expect(discards(target)).toEqual(['sync:staging-discarded: a full resync was requested'])
		expect(position(target)).toBe(0)
	})

	test('delivery events held for the dropped replica are forgotten: the replicated stream reports each operation once', async () => {
		const target = await stagedAfterTwo()
		target.engine.registerQuerySubset({ collection: 'lessons', where: { school: 's' } })
		await settle(target)
		for (const message of messages) await deliver(target, message)
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		const received = (d: Device): number =>
			d.delivery.filter((type) => type === 'sync:received').length
		expect(received(target)).toBe(received(reference))
	})
})

describe('a view change during the merge supersedes it without touching the position', () => {
	const gatedMerge = async (
		finish: (target: Device) => Promise<void>,
		prefix: boolean,
	): Promise<{
		target: Device
		engine: { deliveryWatermark: number; stagingDisabled: boolean }
	}> => {
		const first = numberedOps(1500)
		const batches: OperationBatchMessage[] = prefix
			? [
					batch('b1', 0, first.slice(0, 1000)),
					batch('b2', 1000, first.slice(1000)),
					batchWithRetractions(
						'b3',
						1500,
						[op('insert', 'z', { title: 'z', school: 's' })],
						[{ recordId: 'r000', after: 0 }],
					),
				]
			: stream(first, 300)
		const target = await device(true)
		for (const message of batches.slice(0, -1)) await deliver(target, message)
		let release: () => void = () => undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let reached: () => void = () => undefined
		const hit = new Promise<void>((resolve) => {
			reached = resolve
		})
		const restore = interceptLiveTransactions(target, (n) => {
			if (n !== 2) return undefined
			reached()
			return gate
		})
		const last = deliver(target, batches[batches.length - 1] as OperationBatchMessage)
		await hit
		await finish(target)
		release()
		await last.catch(() => undefined)
		restore()
		await settle(target)
		return {
			target,
			engine: target.engine as unknown as { deliveryWatermark: number; stagingDisabled: boolean },
		}
	}

	for (const prefix of [false, true]) {
		test(`${prefix ? 'merging the staged prefix before a narrowing batch' : 'merging the final batch'}`, async () => {
			const { target, engine } = await gatedMerge(async (t) => {
				t.engine.registerQuerySubset({ collection: 'lessons', where: { school: 's' } })
			}, prefix)
			// The new view starts from its own position (0), not the superseded stream's.
			expect(engine.deliveryWatermark).toBe(0)
			expect((await state(target)).watermark).toBe(0)
			// Superseded is not "failed": staging stays available for the new view.
			expect(engine.stagingDisabled).toBe(false)
			expect(target.events.filter((event) => event.startsWith('sync:staging-discarded'))).toEqual([
				'sync:staging-discarded: the query subsets changed',
			])
		})
	}
})

describe('what a merge that stopped early already made live still reports', () => {
	test('a cancelled merge reports operation:applied for the records its finished chunks made live', async () => {
		const staged = await device(true)
		const messages = stream(numberedOps(1500), 300)
		for (const message of messages.slice(0, -1)) await deliver(staged, message)
		let release: () => void = () => undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let reached: () => void = () => undefined
		const hit = new Promise<void>((resolve) => {
			reached = resolve
		})
		const restore = interceptLiveTransactions(staged, (n) => {
			if (n !== 2) return undefined
			reached()
			return gate
		})
		const last = deliver(staged, messages[messages.length - 1] as OperationBatchMessage)
		await hit
		const stopping = staged.engine.stop()
		release()
		await stopping
		await last.catch(() => undefined)
		restore()
		const live = (await state(staged)).lessons.length
		expect(live).toBeGreaterThan(0)
		expect(live).toBeLessThan(1500)
		expect(staged.published.filter((type) => type === 'operation:applied')).toHaveLength(live)
	})
})

describe('the progress of a staged stream carries what the direct stream carries', () => {
	test('an empty batch in the middle of the stream, and the access-rules key announced by a non-final batch', async () => {
		const messages = [
			batch('b1', 0, numberedOps(30), false),
			{ ...batch('b2', 30, [], false), maxDeliverySequence: 45, accessRulesKey: 'rules-k1' },
			batch('b3', 45, numberedOps(15, { prefix: 'z' }), true),
		]
		const direct = await device(false)
		const staged = await device(true)
		for (const message of messages) {
			await deliver(direct, message)
			await deliver(staged, message)
		}
		expect(await state(staged)).toEqual(await state(direct))
		expect((await state(staged)).watermark).toBe(60)
		expect(await staged.store.loadAccessRulesKey()).toBe('rules-k1')
		expect(await direct.store.loadAccessRulesKey()).toBe('rules-k1')
	})

	test('the quarantine is replayed and the delivery events published when a narrowing batch merges the prefix', async () => {
		const staged = await device(true)
		let replays = 0
		const engine = staged.engine as unknown as { replayQuarantine(): Promise<number> }
		const real = engine.replayQuarantine.bind(engine)
		engine.replayQuarantine = async () => {
			replays += 1
			return real()
		}
		const first = [
			op('insert', 'a', { title: 'a', school: 's' }),
			op('insert', 'g1', { title: 'ghost' }, { collection: 'ghosts' }),
			op('insert', 'b', { title: 'b', school: 's' }),
		]
		await deliver(staged, batch('b1', 0, first, false))
		expect(staged.delivery).toEqual([])
		expect(replays).toBe(0)
		await deliver(
			staged,
			batchWithRetractions(
				'b2',
				3,
				[op('insert', 'c', { title: 'c', school: 's' })],
				[{ recordId: 'a', after: 0 }],
			),
		)
		expect(replays).toBe(1)
		expect(staged.delivery).toContain('sync:apply-failed')
		expect(
			staged.delivery.filter((type) => type === 'sync:received').length,
		).toBeGreaterThanOrEqual(1)
	})

	test('a replica never merges when the signed-in user is no longer the one it was staged for', async () => {
		const target = await device(true)
		const messages = stream(numberedOps(60), 30)
		await deliver(target, messages[0] as OperationBatchMessage)
		;(target.engine as unknown as { sessionPrincipal: string }).sessionPrincipal = 'someone-else'
		await deliver(target, messages[1] as OperationBatchMessage)
		await settle(target)
		const live = await state(target)
		expect(live.lessons).toEqual([])
		expect(live.watermark).toBe(0)
		expect(target.events.some((event) => event.includes('STAGING_MERGE_FAILED'))).toBe(true)
	})
})

// ---------------------------------------------------------------------------------------
// Review round 3: the replica is dropped while a batch is between its replica commit and
// the bookkeeping that counts it.
// ---------------------------------------------------------------------------------------

interface Engine3 {
	staging: { replica: Record<string, unknown> & { store: Record<string, unknown> } } | null
	deliveryWatermark: number
	deliverySignatureWatermarks: Map<string, number>
	state: string
	clockSkewMs: number | null
	holdingEmitter: { heldCount: number } | null
	stagingDisabled: boolean
	stagingFailures: number
	sessionPrincipal: string | null | undefined
}

function internals(target: Device): Engine3 {
	return target.engine as unknown as Engine3
}

function gate(): {
	wait: Promise<void>
	open: () => void
	reached: Promise<void>
	hit: () => void
} {
	let open: () => void = () => undefined
	let hit: () => void = () => undefined
	const wait = new Promise<void>((resolve) => {
		open = resolve
	})
	const reached = new Promise<void>((resolve) => {
		hit = resolve
	})
	return { wait, open, reached, hit }
}

describe('a replica dropped between its commit and the bookkeeping counts nothing', () => {
	const messages = stream(numberedOps(90), 30)
	const points = [
		'after the replica commit (size check)',
		'right after the replica transaction committed',
	] as const
	const drops = ['stop', 'query subset'] as const

	for (const point of points) {
		for (const how of drops) {
			test(`${how} ${point}: the watermark, the view cache and the ack stay where the live database is`, async () => {
				const target = await device(true)
				await deliver(target, messages[0] as OperationBatchMessage)
				const replica = internals(target).staging?.replica
				expect(replica).toBeTruthy()
				if (!replica) return
				const g = gate()
				if (point === points[0]) {
					replica.sizeBytes = async () => {
						g.hit()
						await g.wait
						return 0
					}
				} else {
					const original = (
						replica.store.applyDeliveryBatch as (fn: unknown) => Promise<unknown>
					).bind(replica.store)
					let calls = 0
					replica.store.applyDeliveryBatch = async (fn: unknown) => {
						calls += 1
						const applied = await original(fn)
						if (calls === 1) {
							// The batch is in the replica; the replica is dropped before the engine
							// counts it, and the batch's own late events must not reach the listeners.
							g.hit()
							await g.wait
							;(
								target.engine as unknown as { emitter: { emit(event: unknown): void } }
							).emitter.emit({
								type: 'sync:apply-failed',
								failure: { operationId: 'late', message: 'late' },
							})
						}
						return applied
					}
				}
				const acksBefore = target.acks.length
				const handshakes: number[] = []
				target.server.onMessage((message: SyncMessage) => {
					if (message.type === 'handshake') {
						handshakes.push(
							(message as unknown as { lastDeliverySequence?: number }).lastDeliverySequence ?? 0,
						)
					}
				})
				const second = deliver(target, messages[1] as OperationBatchMessage)
				await g.reached
				if (how === 'stop') await target.engine.stop()
				else target.engine.registerQuerySubset({ collection: 'lessons', where: { school: 's' } })
				g.open()
				await second.catch(() => undefined)
				const e = internals(target)
				// Nothing of the dropped batch was counted.
				expect(e.deliveryWatermark).toBe(0)
				expect([...e.deliverySignatureWatermarks.values()].every((value) => value === 0)).toBe(true)
				expect(target.acks.slice(acksBefore)).toEqual([])
				expect(target.delivery).toEqual([])
				expect(e.holdingEmitter?.heldCount).toBe(0)
				expect((await state(target)).lessons).toEqual([])
				// A restart asks for the stream from the live position, not from the lost one.
				if (how === 'stop') {
					await target.engine.start()
					await drain(target.engine)
				} else {
					await settle(target)
				}
				if (how === 'stop') expect(handshakes.length).toBeGreaterThan(0)
				expect(handshakes.every((value) => value === 0)).toBe(true)
				// And the stream delivered again ends exactly as the direct path.
				for (const message of messages) await deliver(target, message)
				const reference = await device(false)
				for (const message of messages) await deliver(reference, message)
				// (A registered subset changes the view's signature, so only the rows are comparable.)
				if (how === 'stop') expect(await state(target)).toEqual(await state(reference))
				else expect((await state(target)).lessons).toEqual((await state(reference)).lessons)
			})
		}
	}

	test('the empty batch that only moves the watermark is dropped the same way', async () => {
		const target = await device(true)
		await deliver(target, messages[0] as OperationBatchMessage)
		const replica = internals(target).staging?.replica as unknown as {
			store: { syncState?: unknown }
			syncState: { saveDeliveryWatermark?: (signature: string, value: number) => Promise<void> }
		}
		const original = replica.syncState.saveDeliveryWatermark?.bind(replica.syncState)
		const g = gate()
		replica.syncState.saveDeliveryWatermark = async (signature, value) => {
			g.hit()
			await g.wait
			await original?.(signature, value)
		}
		const delivered = deliver(target, batch('empty', 30, []))
		await g.reached
		await target.engine.stop()
		g.open()
		await delivered.catch(() => undefined)
		expect(internals(target).deliveryWatermark).toBe(0)
		expect(target.acks.filter((value) => value > 30)).toEqual([])
	})

	test('a batch from a replica dropped under it publishes none of its events', async () => {
		const target = await device(true)
		await deliver(target, messages[0] as OperationBatchMessage)
		const replica = internals(target).staging?.replica
		if (!replica) throw new Error('no replica')
		const g = gate()
		replica.sizeBytes = async () => {
			g.hit()
			await g.wait
			return 0
		}
		const second = deliver(target, messages[1] as OperationBatchMessage)
		await g.reached
		await target.engine.stop()
		g.open()
		await second.catch(() => undefined)
		expect(internals(target).holdingEmitter?.heldCount).toBe(0)
		expect(target.delivery).toEqual([])
	})
})

describe('stop() while the replica is still opening', () => {
	test('the replica that opened after stop() is closed, not left running', async () => {
		const messages = stream(numberedOps(90), 30)
		const target = await device(true)
		const real = target.syncStore.beginBulkReplication.bind(target.syncStore)
		const g = gate()
		let opened: Awaited<ReturnType<typeof real>> = null
		let discarded = 0
		target.syncStore.beginBulkReplication = async (options) => {
			opened = await real(options)
			if (opened) {
				const discard = opened.discard.bind(opened)
				opened.discard = async () => {
					discarded += 1
					await discard()
				}
			}
			g.hit()
			await g.wait
			return opened
		}
		const first = deliver(target, messages[0] as OperationBatchMessage)
		await g.reached
		await target.engine.stop()
		g.open()
		await first.catch(() => undefined)
		expect(opened).not.toBeNull()
		expect(discarded).toBe(1)
		expect(internals(target).staging).toBeNull()
		expect(target.events).not.toContain('sync:staging-started')
		expect(internals(target).deliveryWatermark).toBe(0)
		expect((await state(target)).lessons).toEqual([])
	})
})

describe('the replica validates timestamps as the live clock does', () => {
	test('a device whose clock is 20 minutes slow stages the stream with no false drift', async () => {
		const skew = 20 * 60_000
		const ahead = Date.now() - EPOCH + skew
		const messages = stream(numberedOps(60, { at: ahead }), 20)
		const run = async (staged: boolean): Promise<{ state: DeviceState; failures: string[] }> => {
			const d = await device(staged)
			d.store.setClockReferenceOffset(skew)
			internals(d).clockSkewMs = skew
			for (const message of messages) await deliver(d, message)
			await drain(d.engine)
			return {
				state: await state(d),
				failures: d.events.filter((event) => event.startsWith('apply-failed')),
			}
		}
		const direct = await run(false)
		const staged = await run(true)
		expect(direct.failures).toEqual([])
		expect(staged.failures).toEqual([])
		expect(staged.state.lessons).toHaveLength(60)
		expect(staged.state.quarantine).toEqual([])
		expect(staged.state).toEqual(direct.state)
	})

	for (const where of ['timestamp', 'fieldVersions'] as const) {
		test(`a far-future ${where} on the first receive is refused by a warm live clock and so by the replica`, async () => {
			const farFuture = Date.now() - EPOCH + 30 * 60_000
			const ops = numberedOps(60)
			const first = ops[0] as Operation
			const poisoned: Operation =
				where === 'timestamp'
					? { ...first, timestamp: { ...first.timestamp, wallTime: EPOCH + farFuture } }
					: {
							...first,
							fieldVersions: {
								title: { wallTime: EPOCH + farFuture, logical: 0, nodeId: first.nodeId },
							},
						}
			const messages = stream([poisoned, ...ops.slice(1)], 20)
			const run = async (staged: boolean): Promise<DeviceState> => {
				const d = await device(staged)
				// A warm clock without a reference offset (a server that sends no time).
				await d.store.collection('projects').insert({ name: 'local' })
				for (const message of messages) await deliver(d, message)
				await drain(d.engine)
				return state(d)
			}
			const direct = await run(false)
			const staged = await run(true)
			expect(staged.quarantine).toEqual(direct.quarantine)
			expect(staged.lessons).toEqual(direct.lessons)
		})
	}
})

describe('a transient merge failure retries staging once, a repeated one applies directly', () => {
	const ops = numberedOps(90)
	const messages = stream(ops, 30)

	async function failOneMerge(target: Device): Promise<void> {
		const real = target.adapter.transaction.bind(target.adapter)
		target.adapter.transaction = async (fn) => {
			target.adapter.transaction = real
			throw new Error('SQLITE_BUSY: database is locked')
		}
		for (const message of messages) await deliver(target, message)
		await settle(target)
	}

	test('after one transient failure the next session stages again; after two it applies directly', async () => {
		const target = await device(true)
		await failOneMerge(target)
		expect(internals(target).stagingDisabled).toBe(false)
		expect(internals(target).stagingFailures).toBe(1)
		for (const message of messages) await deliver(target, message)
		// The retry staged and merged: the failures are forgotten.
		expect(target.events.filter((event) => event === 'sync:staging-started')).toHaveLength(2)
		expect(target.events).toContain('sync:staging-merged')
		expect(internals(target).stagingFailures).toBe(0)
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		expect(await state(target)).toEqual(await state(reference))

		const twice = await device(true)
		await failOneMerge(twice)
		await failOneMerge(twice)
		expect(internals(twice).stagingDisabled).toBe(true)
		const started = twice.events.filter((event) => event === 'sync:staging-started').length
		for (const message of messages) await deliver(twice, message)
		expect(twice.events.filter((event) => event === 'sync:staging-started')).toHaveLength(started)
		expect((await state(twice)).lessons).toHaveLength(90)
	})

	test("a structural failure (the server's authoritative node ids changed) disables staging at once", async () => {
		const target = await device(true)
		await deliver(target, messages[0] as OperationBatchMessage)
		await target.store.setAuthoritativeNodeIds(['another-server'])
		await deliver(target, messages[1] as OperationBatchMessage)
		await deliver(target, messages[2] as OperationBatchMessage)
		await settle(target)
		expect(target.events.some((event) => event.startsWith('sync:staging-discarded:'))).toBe(true)
		expect(internals(target).stagingDisabled).toBe(true)
		expect(target.events).not.toContain('sync:staging-merged')
		// Applied directly from then on, and complete.
		for (const message of messages) await deliver(target, message)
		expect(target.events.filter((event) => event === 'sync:staging-started')).toHaveLength(1)
		expect((await state(target)).lessons).toHaveLength(90)
	})
})

describe('a server that does not announce its frontier still obeys maxOperations', () => {
	test('the replica is merged as it is once it holds more operations than the cap, and the rest is direct', async () => {
		const messages = stream(numberedOps(120), 30)
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		const staged = await device(true, undefined, false, {
			bulk: { minOperations: 0, maxOperations: 50 },
		})
		await deliver(staged, messages[0] as OperationBatchMessage)
		await deliver(staged, messages[1] as OperationBatchMessage)
		// 60 operations > 50: merged as a prefix, live under its watermark.
		expect(staged.events).toContain('sync:staging-merged')
		expect((await state(staged)).watermark).toBe(60)
		for (const message of messages.slice(2)) await deliver(staged, message)
		expect(await state(staged)).toEqual(await state(reference))
	})
})

describe('a replica never merges a prefix for another user', () => {
	test('mergeStagedPrefix refuses when the session principal is no longer the replica owner', async () => {
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
		const staged = await device(true, undefined, false, { principal: async () => 'user-a' })
		await deliver(staged, messages[0] as OperationBatchMessage)
		expect(internals(staged).staging).not.toBeNull()
		// The principal moved without the replica being dropped (the second guard).
		internals(staged).sessionPrincipal = 'user-b'
		await deliver(staged, narrowing)
		expect(staged.events).not.toContain('sync:staging-merged')
		expect(staged.events.some((event) => event.startsWith('error STAGING_MERGE_FAILED'))).toBe(true)
		// Nothing of user A's stream reached the database.
		expect(
			(await state(staged)).lessons.filter((row) => (row as { id: string }).id === 'a'),
		).toEqual([])
	})
})

describe('parents are merged before children, across chunks', () => {
	test('250 parents land in later chunks than the first 100 and the children that reference them merge', async () => {
		const ops: Operation[] = []
		for (let index = 0; index < 250; index++) {
			ops.push(
				op(
					'insert',
					`p${String(index).padStart(3, '0')}`,
					{ name: `p${index}` },
					{
						collection: 'projects',
					},
				),
			)
		}
		for (let index = 0; index < 250; index++) {
			ops.push(
				op('insert', `l${String(index).padStart(3, '0')}`, {
					title: `t${index}`,
					school: 's',
					projectId: `p${String(249 - index).padStart(3, '0')}`,
				}),
			)
		}
		const messages = stream(ops, 100)
		const reference = await device(false)
		for (const message of messages) await deliver(reference, message)
		const staged = await device(true)
		for (const message of messages) await deliver(staged, message)
		expect(staged.events).toContain('sync:staging-merged')
		expect(await state(staged)).toEqual(await state(reference))
		expect((await state(staged)).lessons).toHaveLength(250)
		expect(await mergeTransactionCount(messages)).toBeGreaterThanOrEqual(3)
	})
})

// ---------------------------------------------------------------------------------------
// Review round 4: whatever drops the position while a batch awaits, in any phase of
// handleOperationBatch, the batch must count for nothing. The droppers below run outside the
// engine's message chain; they are the real racers.
// ---------------------------------------------------------------------------------------

describe('a batch whose position is dropped at any await counts for nothing', () => {
	type Dropper = 'stop' | 'query subset' | 'principal change' | 'updateScope' | 'full resync'
	const droppers: Dropper[] = [
		'stop',
		'query subset',
		'principal change',
		'updateScope',
		'full resync',
	]
	type Point = 'prepare' | 'replica commit' | 'size check' | 'hop' | 'begin'
	const points: Point[] = ['prepare', 'replica commit', 'size check', 'hop', 'begin']
	const messages = stream(numberedOps(90), 30)

	async function drop(target: Device, how: Dropper, user: { id: string }): Promise<void> {
		const engine = target.engine
		switch (how) {
			case 'stop':
				await engine.stop()
				return
			case 'query subset':
				engine.registerQuerySubset({ collection: 'lessons', where: { school: 's' } })
				return
			case 'principal change':
				user.id = 'user-b'
				await engine.bindSignedInUser()
				return
			case 'updateScope':
				engine.updateScope({ lessons: { school: 's' } })
				return
			case 'full resync':
				await (
					engine as unknown as { resetDeliveryForFullResync(): Promise<void> }
				).resetDeliveryForFullResync()
				return
		}
	}

	/** Gate the batch at `point`; returns the gate (hit when the batch is there). */
	function arm(target: Device, point: Point): ReturnType<typeof gate> {
		const g = gate()
		const e = target.engine as unknown as {
			prepareInboundBatch(ops: unknown[]): Promise<void>
			applyBatchIntoStaging(...args: unknown[]): Promise<unknown>
		}
		if (point === 'prepare') {
			const original = e.prepareInboundBatch.bind(e)
			e.prepareInboundBatch = async (ops) => {
				g.hit()
				await g.wait
				return original(ops)
			}
		} else if (point === 'hop') {
			const original = e.applyBatchIntoStaging.bind(e)
			e.applyBatchIntoStaging = async (...args) => {
				const result = await original(...args)
				g.hit()
				await g.wait
				return result
			}
		} else if (point === 'begin') {
			const store = target.syncStore
			const original = store.beginBulkReplication.bind(store)
			store.beginBulkReplication = async (options) => {
				const replica = await original(options)
				g.hit()
				await g.wait
				return replica
			}
		} else {
			const replica = internals(target).staging?.replica
			if (!replica) throw new Error('no replica to gate')
			if (point === 'size check') {
				replica.sizeBytes = async () => {
					g.hit()
					await g.wait
					return 0
				}
			} else {
				const original = (
					replica.store.applyDeliveryBatch as (fn: unknown) => Promise<unknown>
				).bind(replica.store)
				replica.store.applyDeliveryBatch = async (fn: unknown) => {
					const applied = await original(fn)
					g.hit()
					await g.wait
					return applied
				}
			}
		}
		return g
	}

	/** No recorded position (in memory, on disk, acknowledged) passes what the live database holds. */
	async function expectNoPositionPastTheData(target: Device, acksFrom = 0): Promise<void> {
		const lessons = (await state(target)).lessons.length
		const e = internals(target) as Engine3 & { deliverySignature(): string }
		const marks = [
			e.deliveryWatermark,
			...e.deliverySignatureWatermarks.values(),
			await target.store.loadDeliveryWatermark(''),
			await target.store.loadDeliveryWatermark(e.deliverySignature()),
		]
		for (const mark of marks) expect(mark).toBeLessThanOrEqual(lessons)
		for (const ack of target.acks.slice(acksFrom)) expect(ack).toBeLessThanOrEqual(lessons)
	}

	for (const how of droppers) {
		for (const point of points) {
			test(`${how} at "${point}"`, async () => {
				const user = { id: 'user-a' }
				const target = await device(true, undefined, false, { principal: async () => user.id })
				// 'begin' races the first batch (no replica yet); the others race the second.
				if (point !== 'begin') await deliver(target, messages[0] as OperationBatchMessage)
				const g = arm(target, point)
				// (The ack of an earlier replica-committed batch is flow control and stands.)
				const acksFrom = target.acks.length
				const delivering = deliver(
					target,
					messages[point === 'begin' ? 0 : 1] as OperationBatchMessage,
				)
				await g.reached
				await drop(target, how, user)
				g.open()
				await delivering.catch(() => undefined)
				await expectNoPositionPastTheData(target, acksFrom)
				if (how === 'stop') {
					await target.engine.start()
					await drain(target.engine)
				} else {
					await settle(target)
				}
				await expectNoPositionPastTheData(target, acksFrom)
				// What the server sends next (from the position the device asked for) still ends
				// with every row: nothing was skipped.
				if (how === 'stop') {
					for (const message of messages) await deliver(target, message)
					expect((await state(target)).lessons).toHaveLength(90)
				}
			})
		}
	}

	test('the direct path: a view change while a batch is verified applies nothing under the new view', async () => {
		const target = await device(false)
		const g = arm(target, 'prepare')
		const first = deliver(target, messages[0] as OperationBatchMessage)
		await g.reached
		target.engine.registerQuerySubset({ collection: 'lessons', where: { school: 'other' } })
		g.open()
		await first.catch(() => undefined)
		await expectNoPositionPastTheData(target)
		expect((await state(target)).lessons).toHaveLength(0)
		expect(target.acks).toEqual([])
	})

	test('a view change while the replica opens does not stage the old view under the new signature', async () => {
		const target = await device(true)
		const g = arm(target, 'begin')
		const first = deliver(target, messages[0] as OperationBatchMessage)
		await g.reached
		target.engine.registerQuerySubset({ collection: 'lessons', where: { school: 'other' } })
		g.open()
		await first.catch(() => undefined)
		expect(internals(target).staging).toBeNull()
		expect(target.events).not.toContain('sync:staging-started')
		await expectNoPositionPastTheData(target)
	})
})

describe('a skew measured after the replica opened reaches the replica clock', () => {
	test('sync:clock-skew handled while staging sets the replica clock offset', async () => {
		const messages = stream(numberedOps(90), 30)
		const target = await device(true)
		await deliver(target, messages[0] as OperationBatchMessage)
		const replica = internals(target).staging?.replica as unknown as {
			setClockReferenceOffset(offsetMs: number): void
		}
		const seen: number[] = []
		const original = replica.setClockReferenceOffset.bind(replica)
		replica.setClockReferenceOffset = (offsetMs: number) => {
			seen.push(offsetMs)
			original(offsetMs)
		}
		;(
			target.engine as unknown as { evaluateClockSkew(serverTime: number): void }
		).evaluateClockSkew(Date.now() + 123_000)
		expect(seen).toHaveLength(1)
		expect(seen[0]).toBeGreaterThan(100_000)
	})
})

describe('a store that is closing is not a stream that cannot be merged', () => {
	test('a cancelled merge neither disables staging nor reconnects', async () => {
		const messages = stream(numberedOps(90), 30)
		const target = await device(true)
		for (const message of messages.slice(0, -1)) await deliver(target, message)
		const replica = internals(target).staging?.replica as unknown as {
			merge(): Promise<unknown>
		}
		replica.merge = async () => ({
			kind: 'unmergeable',
			reason: 'the merge was cancelled',
			cancelled: true,
		})
		let reconnects = 0
		const engine = target.engine as unknown as { reconnect(): Promise<void> }
		const realReconnect = engine.reconnect.bind(engine)
		engine.reconnect = async () => {
			reconnects += 1
			await realReconnect()
		}
		await deliver(target, messages[messages.length - 1] as OperationBatchMessage)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(target.events).toContain('sync:staging-discarded: the merge was cancelled')
		expect(internals(target).stagingDisabled).toBe(false)
		expect(internals(target).stagingFailures).toBe(0)
		expect(reconnects).toBe(0)
		expect(internals(target).deliveryWatermark).toBe(0)
	})
})

describe('the position a batch was received at', () => {
	type Probe = {
		deliveryContext(): unknown
		deliveryContextChanged(context: unknown): boolean
		sessionEpoch: number
		connectionGeneration: number
		accessRulesKey: string | null
		principal: string | null | undefined
		staging: unknown
		deliveryWatermark: number
		deliveryGeneration: number
		deliverySignature: () => string
	}

	const changes: Array<[string, (e: Probe) => void]> = [
		[
			'the session',
			(e) => {
				e.sessionEpoch += 1
			},
		],
		[
			'the connection',
			(e) => {
				e.connectionGeneration += 1
			},
		],
		[
			'the access rules',
			(e) => {
				e.accessRulesKey = 'other-rules'
			},
		],
		[
			'the view',
			(e) => {
				e.deliverySignature = () => 'another-view'
			},
		],
		[
			'the signed-in user',
			(e) => {
				e.principal = 'someone-else'
			},
		],
		[
			'the replica',
			(e) => {
				e.staging = {}
			},
		],
		[
			'the watermark',
			(e) => {
				e.deliveryWatermark += 1
			},
		],
		[
			'the drop counter',
			(e) => {
				e.deliveryGeneration += 1
			},
		],
	]

	for (const [name, change] of changes) {
		test(`a change of ${name} is noticed, and nothing else is`, async () => {
			const target = await device(true)
			const e = target.engine as unknown as Probe
			const context = e.deliveryContext()
			expect(e.deliveryContextChanged(context)).toBe(false)
			change(e)
			try {
				expect(e.deliveryContextChanged(context)).toBe(true)
			} finally {
				e.staging = null
			}
		})
	}
})

describe('a cancelled merge of a staged prefix ends the replica without disabling staging', () => {
	test('a narrowing batch whose prefix merge was cancelled by a closing store', async () => {
		const ops = [
			op('insert', 'a', { title: 'a', school: 's' }),
			op('insert', 'b', { title: 'b', school: 't' }),
		]
		const messages = stream(ops, 1)
		const narrowing = {
			...(messages[1] as OperationBatchMessage),
			accessNarrowing: { lessons: { school: 's' } },
		}
		const target = await device(true)
		await deliver(target, messages[0] as OperationBatchMessage)
		const replica = internals(target).staging?.replica as unknown as { merge(): Promise<unknown> }
		replica.merge = async () => ({
			kind: 'unmergeable',
			reason: 'the merge was cancelled',
			cancelled: true,
		})
		let reconnects = 0
		const engine = target.engine as unknown as { reconnect(): Promise<void> }
		const realReconnect = engine.reconnect.bind(engine)
		engine.reconnect = async () => {
			reconnects += 1
			await realReconnect()
		}
		await deliver(target, narrowing)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(internals(target).stagingDisabled).toBe(false)
		expect(reconnects).toBe(0)
		expect(internals(target).deliveryWatermark).toBe(0)
	})
})

// ===========================================================================================
// The delivery position has one writer (`commitDeliveryProgress`). Whatever drops the position
// a batch was received at, at whichever await, the batch counts for nothing: this matrix puts
// every dropper that changes the position (not only ends the session) at every await where
// four review rounds found a hole, for the staged and the direct path, and checks the
// invariants of the position.
// ===========================================================================================
const MATRIX_FIXTURE = stream(numberedOps(90, { prefix: 'm' }), 30)
const MATRIX_NARROW: OperationBatchMessage = {
	...(MATRIX_FIXTURE[2] as OperationBatchMessage),
	accessNarrowing: { lessons: { school: 's' } },
	isFinal: true,
}

/** The parts of the engine the matrix reads and pauses (white-box, like `internals`). */
type MatrixEngine = Record<string, unknown> & {
	deliverySignature(): string
	resetDeliveryForFullResync(): Promise<void>
	deliveryWatermark: number
	accessRulesKey: string | null
	deliverySignatureWatermarks: Map<string, number>
	staging: { replica: Record<string, unknown> } | null
	holdingEmitter: Record<string, unknown> & { heldCount: number }
	syncState: { loadAccessRulesKey(): Promise<string | null> }
}

type MatrixScenario = 'final' | 'narrow' | 'tooLarge' | 'direct' | 'directFinal'
type MatrixDropper = 'updateScope' | 'unsubscribe' | 'fullResync' | 'principal'
interface MatrixGate {
	on: 'engine' | 'holdingEmitter'
	method: string
	nth?: number
}

const MATRIX_SCENARIOS: Record<
	MatrixScenario,
	{ staged: boolean; before: number[]; message: () => OperationBatchMessage; gates: MatrixGate[] }
> = {
	// The final staged batch: the merge committed, then the awaits that follow it.
	final: {
		staged: true,
		before: [0, 1],
		message: () => MATRIX_FIXTURE[2] as OperationBatchMessage,
		gates: [
			{ on: 'holdingEmitter', method: 'release' },
			{ on: 'engine', method: 'replayQuarantineAfterMerge' },
		],
	},
	// A batch that narrows the view after a staged prefix: the prefix merge, then the same awaits.
	narrow: {
		staged: true,
		before: [0, 1],
		message: () => MATRIX_NARROW,
		gates: [
			{ on: 'holdingEmitter', method: 'release' },
			{ on: 'engine', method: 'replayQuarantineAfterMerge' },
		],
	},
	// A replica past its bound merges its prefix (this batch included) and continues directly.
	tooLarge: {
		staged: true,
		before: [0],
		message: () => MATRIX_FIXTURE[1] as OperationBatchMessage,
		gates: [
			{ on: 'holdingEmitter', method: 'release' },
			{ on: 'engine', method: 'replayQuarantineAfterMerge' },
		],
	},
	direct: {
		staged: false,
		before: [],
		message: () => MATRIX_FIXTURE[0] as OperationBatchMessage,
		gates: [
			{ on: 'engine', method: 'prepareInboundBatch' },
			{ on: 'engine', method: 'applyBatchIntoStaging' },
			{ on: 'engine', method: 'applyInbound', nth: 5 },
		],
	},
	directFinal: {
		staged: false,
		before: [0, 1],
		message: () => MATRIX_FIXTURE[2] as OperationBatchMessage,
		gates: [
			{ on: 'engine', method: 'prepareInboundBatch' },
			{ on: 'engine', method: 'applyBatchIntoStaging' },
			{ on: 'engine', method: 'applyInbound', nth: 5 },
		],
	},
}
const MATRIX_DROPPERS: MatrixDropper[] = ['updateScope', 'unsubscribe', 'fullResync', 'principal']

/** Pauses `method` of `owner` after its `nth` call returned, until the gate opens. */
function pauseAfter(
	owner: Record<string, unknown>,
	method: string,
	opened: ReturnType<typeof gate>,
	nth = 1,
): void {
	const original = (owner[method] as (...args: unknown[]) => Promise<unknown>).bind(owner)
	let calls = 0
	owner[method] = async (...args: unknown[]): Promise<unknown> => {
		const result = await original(...args)
		calls += 1
		if (calls === nth) {
			opened.hit()
			await opened.wait
		}
		return result
	}
}

function recordHandshakes(target: Device): number[] {
	const handshakes: number[] = []
	target.server.onMessage((message: SyncMessage) => {
		if (message.type === 'handshake') {
			handshakes.push(
				(message as unknown as { lastDeliverySequence?: number }).lastDeliverySequence ?? 0,
			)
		}
	})
	return handshakes
}

/** The contiguous prefix m000.. of the matrix stream that is in the live database. */
async function committedPrefix(target: Device): Promise<number> {
	const ids = new Set(((await state(target)).lessons as Array<{ id: string }>).map((row) => row.id))
	let prefix = 0
	while (ids.has(`m${String(prefix).padStart(3, '0')}`)) prefix++
	return prefix
}

async function runMatrixCell(
	scenario: MatrixScenario,
	dropper: MatrixDropper,
	at: MatrixGate,
): Promise<string[]> {
	const spec = MATRIX_SCENARIOS[scenario]
	const user = { id: 'user-a' }
	const options: DeviceOptions = { principal: async () => user.id }
	if (scenario === 'tooLarge') options.bulk = { minOperations: 0, maxOperations: 45 }
	const target = await device(spec.staged, undefined, false, options)
	const e = target.engine as unknown as MatrixEngine
	const handshakes = recordHandshakes(target)
	let unsubscribe: (() => void) | null = null
	if (dropper === 'unsubscribe') {
		unsubscribe = target.engine.registerQuerySubset({
			collection: 'lessons',
			where: { school: 's' },
		})
		await settle(target)
	}
	const streamSignature = e.deliverySignature() as string
	for (const index of spec.before)
		await deliver(target, MATRIX_FIXTURE[index] as OperationBatchMessage)
	const opened = gate()
	let reached = false
	void opened.reached.then(() => {
		reached = true
	})
	pauseAfter(
		at.on === 'engine' ? e : (e.holdingEmitter as Record<string, unknown>),
		at.method,
		opened,
		at.nth,
	)
	const ackFrom = target.acks.length
	const delivering = deliver(target, spec.message()).catch(() => undefined)
	await Promise.race([opened.reached, delivering])
	const problems: string[] = []
	if (!reached) return [`the gate ${at.method} was never reached`]
	// The dropper starts while the batch is paused. It may have to wait for the transaction the
	// pause holds open (a write of the position queues behind it), so it is awaited only
	// after the batch resumed.
	const dropped = (async (): Promise<void> => {
		switch (dropper) {
			case 'updateScope':
				target.engine.updateScope({ lessons: { school: 't' } })
				break
			case 'unsubscribe':
				unsubscribe?.()
				break
			case 'fullResync':
				await e.resetDeliveryForFullResync()
				break
			case 'principal':
				user.id = 'user-b'
				await target.engine.bindSignedInUser()
				break
		}
	})()
	await new Promise((resolve) => setTimeout(resolve, 0))
	opened.open()
	await Promise.all([dropped, delivering])
	await settle(target)
	await settle(target)

	const prefix = await committedPrefix(target)
	const sigNow = e.deliverySignature() as string
	const bound = (signature: string): number => (signature === streamSignature ? prefix : 0)
	const signatures = new Set<string>([
		streamSignature,
		sigNow,
		...(e.deliverySignatureWatermarks as Map<string, number>).keys(),
	])
	for (const signature of signatures) {
		const persisted = await target.store.loadDeliveryWatermark(signature)
		if (persisted > bound(signature)) {
			problems.push(
				`persisted watermark ${persisted} of view ${JSON.stringify(signature).slice(0, 30)} exceeds the committed prefix ${bound(signature)}`,
			)
		}
	}
	for (const [signature, watermark] of e.deliverySignatureWatermarks as Map<string, number>) {
		if (watermark > bound(signature)) {
			problems.push(
				`view cache ${watermark} of ${JSON.stringify(signature).slice(0, 30)} exceeds ${bound(signature)}`,
			)
		}
	}
	for (const ack of target.acks.slice(ackFrom)) {
		if (ack > prefix) problems.push(`ack ${ack} beyond the committed prefix ${prefix}`)
	}
	if ((e.holdingEmitter?.heldCount ?? 0) > 0 && e.staging === null) {
		problems.push(`${e.holdingEmitter.heldCount} held events remain with no replica`)
	}
	// The next handshake asks for exactly the recorded position of the view it is for.
	handshakes.length = 0
	await target.engine.reconnect().catch(() => undefined)
	await settle(target)
	const asked = handshakes[handshakes.length - 1]
	const recorded = await target.store.loadDeliveryWatermark(sigNow)
	if (asked !== undefined && asked > bound(sigNow)) {
		problems.push(`the handshake asks for ${asked}, beyond the committed prefix ${bound(sigNow)}`)
	}
	if (asked !== undefined && sigNow === streamSignature && asked !== recorded) {
		problems.push(`the handshake asks for ${asked} but the recorded position is ${recorded}`)
	}
	// Redelivery from the recorded position: nothing missing, nothing twice.
	if (sigNow === streamSignature && dropper !== 'principal') {
		const from = e.deliveryWatermark as number
		for (const message of MATRIX_FIXTURE) {
			if ((message.baseDeliverySequence ?? 0) >= from) await deliver(target, message)
		}
		await settle(target)
		const after = await state(target)
		if (after.lessons.length !== 90) {
			problems.push(`after redelivery from ${from}: ${after.lessons.length} of 90 rows`)
		}
		if (new Set(after.logLessons).size !== after.logLessons.length) {
			problems.push('duplicate operation log rows')
		}
	}
	return problems
}

describe('the delivery position survives every dropper at every await (fault-injection matrix)', () => {
	for (const [scenario, spec] of Object.entries(MATRIX_SCENARIOS) as Array<
		[MatrixScenario, (typeof MATRIX_SCENARIOS)[MatrixScenario]]
	>) {
		for (const at of spec.gates) {
			for (const dropper of MATRIX_DROPPERS) {
				test(`${scenario}: ${dropper} after ${at.method}${at.nth ? `#${at.nth}` : ''}`, async () => {
					expect(await runMatrixCell(scenario, dropper, at)).toEqual([])
				}, 10_000)
			}
		}
	}
})

describe('the holes the fourth review found, each as its own proof', () => {
	test('a scope change while the merge of the final batch releases its events leaves the new view at 0', async () => {
		const target = await device(true)
		const e = target.engine as unknown as MatrixEngine
		const handshakes = recordHandshakes(target)
		await deliver(target, MATRIX_FIXTURE[0] as OperationBatchMessage)
		await deliver(target, MATRIX_FIXTURE[1] as OperationBatchMessage)
		const opened = gate()
		pauseAfter(e.holdingEmitter, 'release', opened)
		const last = deliver(target, {
			...(MATRIX_FIXTURE[2] as OperationBatchMessage),
			accessRulesKey: 'rules-1',
		})
		await opened.reached
		target.engine.updateScope({ lessons: { school: 't' } })
		opened.open()
		await last
		await settle(target)
		const signature = e.deliverySignature() as string
		expect(e.deliveryWatermark).toBe(0)
		expect(await target.store.loadDeliveryWatermark(signature)).toBe(0)
		// The old view's merge is true of the old view, and only of it.
		expect(await target.store.loadDeliveryWatermark('')).toBe(90)
		// The key of the rules the dropped stream was scoped under is not this view's.
		expect(e.accessRulesKey ?? null).toBeNull()
		expect(await e.syncState.loadAccessRulesKey()).toBeNull()
		await target.engine.reconnect()
		await settle(target)
		expect(handshakes[handshakes.length - 1]).toBe(0)
	})

	test('a narrowing batch after a staged prefix: a scope change after the prefix merge leaves the new view at 0', async () => {
		const target = await device(true)
		const e = target.engine as unknown as MatrixEngine
		const handshakes = recordHandshakes(target)
		await deliver(target, MATRIX_FIXTURE[0] as OperationBatchMessage)
		await deliver(target, MATRIX_FIXTURE[1] as OperationBatchMessage)
		const opened = gate()
		pauseAfter(e.holdingEmitter, 'release', opened)
		const last = deliver(target, MATRIX_NARROW)
		await opened.reached
		target.engine.updateScope({ lessons: { school: 't' } })
		opened.open()
		await last
		await settle(target)
		expect(await target.store.loadDeliveryWatermark(e.deliverySignature() as string)).toBe(0)
		await target.engine.reconnect()
		await settle(target)
		expect(handshakes[handshakes.length - 1]).toBe(0)
	})

	test('direct apply: a scope change between the first operation and the commit stores nothing under the new scope', async () => {
		const target = await device(false)
		const e = target.engine as unknown as MatrixEngine
		const handshakes = recordHandshakes(target)
		const opened = gate()
		pauseAfter(e, 'applyInbound', opened, 5)
		const first = deliver(target, MATRIX_FIXTURE[0] as OperationBatchMessage)
		await opened.reached
		target.engine.updateScope({ lessons: { school: 't' } })
		opened.open()
		await first
		await settle(target)
		expect(await target.store.loadDeliveryWatermark(e.deliverySignature() as string)).toBe(0)
		expect(await target.store.loadDeliveryWatermark('')).toBe(0)
		// The transaction rolled back: the batch is in no database, and the stream starts again.
		expect((await state(target)).lessons).toHaveLength(0)
		await target.engine.reconnect()
		await settle(target)
		expect(handshakes[handshakes.length - 1]).toBe(0)
	})

	test('direct apply: dropping the last query subset mid-batch does not advance the unfiltered view', async () => {
		const target = await device(false)
		const e = target.engine as unknown as MatrixEngine
		const unsubscribe = target.engine.registerQuerySubset({
			collection: 'lessons',
			where: { school: 's' },
		})
		await settle(target)
		const opened = gate()
		pauseAfter(e, 'applyBatchIntoStaging', opened)
		const first = deliver(target, MATRIX_FIXTURE[0] as OperationBatchMessage)
		await opened.reached
		unsubscribe()
		opened.open()
		await first
		await settle(target)
		expect(await target.store.loadDeliveryWatermark('')).toBe(0)
		expect(e.deliveryWatermark).toBe(0)
	})

	test('direct apply: a full resync requested after the context check is not undone by the batch commit', async () => {
		const target = await device(false)
		const e = target.engine as unknown as MatrixEngine
		const opened = gate()
		pauseAfter(e, 'applyBatchIntoStaging', opened)
		const first = deliver(target, MATRIX_FIXTURE[0] as OperationBatchMessage)
		await opened.reached
		await e.resetDeliveryForFullResync()
		opened.open()
		await first
		await settle(target)
		expect(await target.store.loadDeliveryWatermark('')).toBe(0)
		expect(e.deliveryWatermark).toBe(0)
		expect(target.acks).toEqual([])
	})

	test('a transport close while a staged batch is counted keeps the replica and the events its batches held', async () => {
		const target = await device(true)
		const e = target.engine as unknown as MatrixEngine
		await deliver(target, MATRIX_FIXTURE[0] as OperationBatchMessage)
		const opened = gate()
		pauseAfter(e.staging.replica, 'sizeBytes', opened)
		const second = deliver(target, MATRIX_FIXTURE[1] as OperationBatchMessage)
		await opened.reached
		const held = e.holdingEmitter.heldCount as number
		expect(held).toBeGreaterThan(0)
		await target.server.disconnect()
		opened.open()
		await second.catch(() => undefined)
		// Only the session moved: the replica is alive, and what it holds is still its to announce.
		expect(e.staging).not.toBeNull()
		expect(e.holdingEmitter.heldCount).toBe(held)
		await target.engine.start()
		await drain(target.engine)
		await deliver(target, MATRIX_FIXTURE[2] as OperationBatchMessage)
		await settle(target)
		expect((await state(target)).lessons).toHaveLength(90)
		// One event per applied operation reached the listeners, after the live commit.
		expect(target.published.filter((type) => type === 'operation:applied')).toHaveLength(90)
	})

	test('a batch received for one user is not applied after another user was bound', async () => {
		const user = { id: 'user-a' }
		const target = await device(false, undefined, false, { principal: async () => user.id })
		const e = target.engine as unknown as MatrixEngine
		const opened = gate()
		pauseAfter(e, 'applyBatchIntoStaging', opened)
		const first = deliver(target, MATRIX_FIXTURE[0] as OperationBatchMessage)
		await opened.reached
		user.id = 'user-b'
		await target.engine.bindSignedInUser()
		opened.open()
		await first.catch(() => undefined)
		await settle(target)
		expect((await state(target)).lessons).toHaveLength(0)
		expect(await target.store.loadDeliveryWatermark('')).toBe(0)
	})

	test('stop() between the context check and the apply: nothing commits and nothing is acknowledged', async () => {
		const target = await device(false)
		const e = target.engine as unknown as MatrixEngine
		const opened = gate()
		pauseAfter(e, 'applyBatchIntoStaging', opened)
		const first = deliver(target, MATRIX_FIXTURE[0] as OperationBatchMessage)
		await opened.reached
		await target.engine.stop()
		opened.open()
		await first.catch(() => undefined)
		expect((await state(target)).lessons).toHaveLength(0)
		expect(await target.store.loadDeliveryWatermark('')).toBe(0)
		expect(target.acks).toEqual([])
	})
})

// ===========================================================================================
// `commitDeliveryProgress` is the contract: each change it accepts is refused, writes nothing
// and acknowledges nothing when the context it is given is stale, and each change it accepts
// from a fresh context does what it says. Called directly, so that no other layer can carry
// the test (mutation testing removes each check in turn and every one must be noticed).
// ===========================================================================================
describe('commitDeliveryProgress refuses a stale context and honors a fresh one', () => {
	type Writer = MatrixEngine & {
		deliveryContext(): { generation: number }
		commitDeliveryProgress(
			context: unknown,
			change: Record<string, unknown>,
		): Promise<{ status: 'committed' | 'stale'; merge?: { kind: string } }>
	}
	const asWriter = (target: Device): Writer => target.engine as unknown as Writer

	test('check', async () => {
		const e = asWriter(await device(false))
		const context = e.deliveryContext()
		expect((await e.commitDeliveryProgress(context, { kind: 'check' })).status).toBe('committed')
		;(e as unknown as { deliveryGeneration: number }).deliveryGeneration += 1
		expect((await e.commitDeliveryProgress(context, { kind: 'check' })).status).toBe('stale')
	})

	test('reack acknowledges the watermark only from a fresh context', async () => {
		const target = await device(false)
		const e = asWriter(target)
		e.deliveryWatermark = 7
		const context = e.deliveryContext()
		const fresh = await e.commitDeliveryProgress(context, { kind: 'reack', messageId: 'm1' })
		await drain(target.engine)
		expect(fresh.status).toBe('committed')
		expect(target.acks).toEqual([7])
		;(e as unknown as { deliveryGeneration: number }).deliveryGeneration += 1
		const stale = await e.commitDeliveryProgress(context, { kind: 'reack', messageId: 'm2' })
		await drain(target.engine)
		expect(stale.status).toBe('stale')
		expect(target.acks).toEqual([7])
	})

	test('write persists the watermark only from a fresh context', async () => {
		const target = await device(false)
		const e = asWriter(target)
		const signature = e.deliverySignature()
		const context = e.deliveryContext()
		;(e as unknown as { deliveryGeneration: number }).deliveryGeneration += 1
		const stale = await e.commitDeliveryProgress(context, {
			kind: 'write',
			watermark: 5,
			quarantined: [],
		})
		expect(stale.status).toBe('stale')
		expect(await target.store.loadDeliveryWatermark(signature)).toBe(0)
		const fresh = await e.commitDeliveryProgress(e.deliveryContext(), {
			kind: 'write',
			watermark: 5,
			quarantined: [],
		})
		expect(fresh.status).toBe('committed')
		expect(await target.store.loadDeliveryWatermark(signature)).toBe(5)
	})

	test('write-in-transaction writes through the open transaction only from a fresh context', async () => {
		const target = await device(false)
		const e = asWriter(target)
		const calls: string[] = []
		const batch = {
			saveQuarantine: async () => {
				calls.push('quarantine')
			},
			saveDeliveryWatermark: async (_signature: string, watermark: number) => {
				calls.push(`watermark ${watermark}`)
			},
		}
		const change = { kind: 'write-in-transaction', batch, watermark: 9, quarantined: [] }
		const context = e.deliveryContext()
		expect((await e.commitDeliveryProgress(context, change)).status).toBe('committed')
		expect(calls).toEqual(['watermark 9'])
		;(e as unknown as { sessionEpoch: number }).sessionEpoch += 1
		expect((await e.commitDeliveryProgress(context, change)).status).toBe('stale')
		expect(calls).toEqual(['watermark 9'])
	})

	test('merge refuses a stale context before it merges anything, and records the replica cache entry when it merges', async () => {
		const target = await device(true)
		const e = asWriter(target)
		await deliver(target, MATRIX_FIXTURE[0] as OperationBatchMessage)
		const staging = e.staging as { watermark: number; signature: string } | null
		expect(staging).not.toBeNull()
		const context = e.deliveryContext()
		;(e as unknown as { deliveryGeneration: number }).deliveryGeneration += 1
		const stale = await e.commitDeliveryProgress(context, {
			kind: 'merge',
			staging,
			prefix: true,
		})
		expect(stale.status).toBe('stale')
		expect(e.staging).toBe(staging)
		expect((await state(target)).lessons).toHaveLength(0)
		const merged = await e.commitDeliveryProgress(e.deliveryContext(), {
			kind: 'merge',
			staging,
			prefix: true,
		})
		expect(merged.status).toBe('committed')
		expect(merged.merge?.kind).toBe('merged')
		expect((await state(target)).lessons).toHaveLength(30)
		// The cache entry of the replica's own view is recorded by the merge itself.
		expect(e.deliverySignatureWatermarks.get(staging?.signature ?? '')).toBe(30)
		expect(e.deliveryWatermark).toBe(30)
	})

	test('publish from a stale context records what is durable under its view and nothing else', async () => {
		const target = await device(false)
		const e = asWriter(target)
		const signature = e.deliverySignature()
		const context = e.deliveryContext()
		e.updateScope({ lessons: { school: 't' } })
		const result = await e.commitDeliveryProgress(context, {
			kind: 'publish',
			watermark: 30,
			isFinal: false,
			accessRulesKey: 'rules',
			ack: { messageId: 'm', lastSequenceNumber: 30 },
		})
		await drain(target.engine)
		expect(result.status).toBe('stale')
		// True of the view it was durable under:
		expect(e.deliverySignatureWatermarks.get(signature)).toBe(30)
		// Nothing of the current view moved, nothing was acknowledged or keyed.
		expect(e.deliveryWatermark).toBe(0)
		expect(target.acks).toEqual([])
		expect(e.accessRulesKey ?? null).toBeNull()
	})

	test('publish from a fresh context moves the position, keys the rules and acknowledges once', async () => {
		const target = await device(false)
		const e = asWriter(target)
		const context = e.deliveryContext()
		const result = await e.commitDeliveryProgress(context, {
			kind: 'publish',
			watermark: 30,
			isFinal: false,
			accessRulesKey: 'rules-a',
			ack: { messageId: 'm', lastSequenceNumber: 30 },
		})
		await drain(target.engine)
		expect(result.status).toBe('committed')
		expect(e.deliveryWatermark).toBe(30)
		expect(e.accessRulesKey).toBe('rules-a')
		expect(await e.syncState.loadAccessRulesKey()).toBe('rules-a')
		expect(target.acks).toEqual([30])
	})

	test('publish: a position that moves while the access-rules key is saved acknowledges nothing', async () => {
		const target = await device(false)
		const e = asWriter(target)
		const context = e.deliveryContext()
		const original = e.syncState.saveAccessRulesKey?.bind(e.syncState)
		;(
			e.syncState as unknown as { saveAccessRulesKey: (key: string) => Promise<void> }
		).saveAccessRulesKey = async (key) => {
			await original?.(key)
			;(e as unknown as { deliveryGeneration: number }).deliveryGeneration += 1
		}
		const result = await e.commitDeliveryProgress(context, {
			kind: 'publish',
			watermark: 30,
			isFinal: false,
			accessRulesKey: 'rules-a',
			ack: { messageId: 'm', lastSequenceNumber: 30 },
		})
		await drain(target.engine)
		expect(result.status).toBe('stale')
		expect(target.acks).toEqual([])
	})
})

describe('the callers of commitDeliveryProgress stop at the first stale answer', () => {
	const perOperationBatch = (): OperationBatchMessage => ({
		...(MATRIX_FIXTURE[0] as OperationBatchMessage),
		// A narrowing batch takes the per-operation path.
		accessNarrowing: { lessons: { school: 's' } },
	})

	test('a batch whose position moved during verification starts no replica', async () => {
		const target = await device(true)
		const e = target.engine as unknown as MatrixEngine
		const opened = gate()
		pauseAfter(e, 'prepareInboundBatch', opened)
		const delivering = deliver(target, MATRIX_FIXTURE[0] as OperationBatchMessage)
		await opened.reached
		target.engine.updateScope({ lessons: { school: 't' } })
		opened.open()
		await delivering
		await settle(target)
		expect(target.events.filter((event) => event === 'sync:staging-started')).toEqual([])
		expect(e.staging).toBeNull()
	})

	test('the per-operation path: a position that moved before its write records nothing', async () => {
		const target = await device(false)
		const e = target.engine as unknown as MatrixEngine
		const signature = e.deliverySignature()
		const opened = gate()
		pauseAfter(e, 'applyBatchPerOperation', opened)
		const delivering = deliver(target, perOperationBatch())
		await opened.reached
		target.engine.updateScope({ lessons: { school: 't' } })
		opened.open()
		await delivering
		await settle(target)
		expect(await target.store.loadDeliveryWatermark(signature)).toBe(0)
		expect(e.deliverySignatureWatermarks.get(signature) ?? 0).toBe(0)
		expect(target.acks).toEqual([])
	})

	test('the per-operation path stops applying once the signed-in user changed', async () => {
		const user = { id: 'user-a' }
		const target = await device(false, undefined, false, { principal: async () => user.id })
		const e = target.engine as unknown as MatrixEngine
		const opened = gate()
		pauseAfter(e, 'applyInbound', opened, 5)
		const delivering = deliver(target, perOperationBatch())
		await opened.reached
		user.id = 'user-b'
		const bound = target.engine.bindSignedInUser()
		await new Promise((resolve) => setTimeout(resolve, 0))
		opened.open()
		await Promise.all([bound, delivering])
		await settle(target)
		expect((await state(target)).lessons.length).toBeLessThanOrEqual(5)
	})

	test('a multi-chunk batch whose user changed in a later chunk keeps only the chunks before it', async () => {
		const user = { id: 'user-a' }
		const target = await device(false, undefined, false, { principal: async () => user.id })
		const e = target.engine as unknown as MatrixEngine
		const [big] = stream(numberedOps(1200, { prefix: 'm' }), 1200)
		const opened = gate()
		pauseAfter(e, 'applyInbound', opened, 600)
		const delivering = deliver(target, big as OperationBatchMessage)
		await opened.reached
		user.id = 'user-b'
		const bound = target.engine.bindSignedInUser()
		await new Promise((resolve) => setTimeout(resolve, 0))
		opened.open()
		await Promise.all([bound, delivering])
		await settle(target)
		// Chunk 1 (500 operations) committed before the user changed; chunk 2 rolled back.
		expect((await state(target)).lessons).toHaveLength(500)
		expect(await target.store.loadDeliveryWatermark('')).toBe(0)
	}, 60_000)

	test('a final staged batch dropped while its events are released does not complete the initial sync', async () => {
		const target = await device(true)
		const e = target.engine as unknown as MatrixEngine
		await deliver(target, MATRIX_FIXTURE[0] as OperationBatchMessage)
		await deliver(target, MATRIX_FIXTURE[1] as OperationBatchMessage)
		const opened = gate()
		pauseAfter(e.holdingEmitter, 'release', opened)
		const last = deliver(target, MATRIX_FIXTURE[2] as OperationBatchMessage)
		await opened.reached
		target.engine.updateScope({ lessons: { school: 't' } })
		opened.open()
		await last
		await settle(target)
		expect((e as unknown as { deltaReceiveComplete: boolean }).deltaReceiveComplete).toBe(false)
	})

	test('the context predicate for a merged replica compares the replica it follows', async () => {
		const target = await device(true)
		const e = target.engine as unknown as {
			deliveryContext(): { staging: unknown }
			deliveryContextChanged(context: unknown, mergedFrom?: unknown): boolean
			staging: unknown
		}
		await deliver(target, MATRIX_FIXTURE[0] as OperationBatchMessage)
		const replica = e.staging
		const context = e.deliveryContext()
		// Merged (the engine left staging): the same replica is consistent...
		const real = e.staging
		e.staging = null
		try {
			expect(e.deliveryContextChanged(context, replica)).toBe(false)
			// ...another replica is not...
			expect(e.deliveryContextChanged(context, {})).toBe(true)
			// ...and a replica that appeared after the merge is not either.
			e.staging = {}
			expect(e.deliveryContextChanged(context, replica)).toBe(true)
		} finally {
			e.staging = real
		}
	})
})
