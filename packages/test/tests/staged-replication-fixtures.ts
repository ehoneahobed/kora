/**
 * Shared fixtures of the staged-replication suites: a device (store, engine and in-memory
 * server over a real SQLite file), a direct reference, chained delivery batches and the
 * state a device is compared by (docs/design/first-visit-parity.md 5.7).
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
import { afterAll, afterEach } from 'vitest'

export const schema = defineSchema({
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

export const EPOCH = Date.UTC(2026, 0, 1)
export const tmp = mkdtempSync(join(tmpdir(), 'kora-staged-replication-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/**
 * A store that fails the operations in `stalling` (a busy database), in the live database and
 * in its scratch replica alike: the staged counterpart of the direct path's stall injection.
 */
export class StallingSyncStore extends MergeAwareSyncStore {
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

export interface Device {
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
	/** `lastDeliverySequence` of every handshake the engine sent (the transport's send is wrapped, the server handler stays). */
	handshakes: number[]
	emitter: SimpleEventEmitter
	close(): Promise<void>
}

export const devices: Device[] = []
afterEach(async () => {
	for (const device of devices.splice(0)) await device.close()
})

let deviceCounter = 0
export interface DeviceOptions {
	/** Overrides `bulkReplication` (default: `{ minOperations: 0 }` when staged, `false` otherwise). */
	bulk?: boolean | { minOperations?: number; maxOperations?: number; maxBytes?: number }
	/** `serverMaxDeliverySequence` of the handshake response. */
	frontier?: number
	/** `acceptedDownlinkScopes` of the handshake response (read at each response). */
	acceptedScope?: Record<string, Record<string, unknown>>
	/** The signed-in user, when the engine tracks one. */
	principal?: () => Promise<string | null>
}

export async function device(
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
	const handshakes: number[] = []
	const realSend = client.send.bind(client)
	client.send = (message: SyncMessage): void => {
		if (message.type === 'handshake') {
			handshakes.push(
				(message as unknown as { lastDeliverySequence?: number }).lastDeliverySequence ?? 0,
			)
		}
		realSend(message)
	}
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
		handshakes,
		emitter,
		close: async () => {
			await engine.stop()
			await store.close()
			// A device with a file of its own is reopened by the test; the others are scratch, and
			// a sweep of thousands of cells would otherwise fill the disk.
			if (file === undefined) {
				for (const suffix of ['', '-wal', '-shm', '-journal']) {
					rmSync(`${path}${suffix}`, { force: true })
				}
			}
		},
	}
	devices.push(created)
	return created
}

export async function drain(engine: SyncEngine): Promise<void> {
	const chained = engine as unknown as { messageChain: Promise<void> }
	for (;;) {
		const current = chained.messageChain
		await current
		if (chained.messageChain === current) return
	}
}

/** Wait for a restart the engine scheduled (a dropped replica reconnects) to finish. */
export async function settle(target: Device): Promise<void> {
	const engine = target.engine as unknown as { reconnectPromise: Promise<void> | null }
	await new Promise((resolve) => setTimeout(resolve, 0))
	await engine.reconnectPromise
	await drain(target.engine)
}

export async function deliver(target: Device, message: OperationBatchMessage): Promise<void> {
	target.server.send(JSON.parse(JSON.stringify(message)) as SyncMessage)
	await drain(target.engine)
}

let opCounter = 0
export function op(
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
export function batch(
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
export function stream(ops: Operation[], size: number): OperationBatchMessage[] {
	const batches: OperationBatchMessage[] = []
	for (let start = 0; start < ops.length; start += size) {
		batches.push(
			batch(`m${start}`, start, ops.slice(start, start + size), start + size >= ops.length),
		)
	}
	return batches
}

export interface DeviceState {
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

export async function state(target: Device): Promise<DeviceState> {
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

export function numberedOps(
	count: number,
	options: { at?: number; prefix?: string } = {},
): Operation[] {
	return Array.from({ length: count }, (_, index) =>
		op(
			'insert',
			`${options.prefix ?? 'r'}${String(index).padStart(3, '0')}`,
			{ title: `t${index}`, school: 's' },
			options.at === undefined ? {} : { at: options.at + index },
		),
	)
}
