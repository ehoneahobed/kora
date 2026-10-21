/**
 * Replay recorded delivery batches into a fresh device with no server in the process
 * (first-sync benchmark, `KORA_BENCH_BREAKDOWN=1`; see `apply-breakdown.ts`). The device is
 * wired as `createApp` wires it (real Store on better-sqlite3, merge-aware sync store, sync
 * state persistence, the home query subscribed). Messages are handed to the engine one at a
 * time and each is fully handled before the next, so the wall time is device apply only.
 */
import { join } from 'node:path'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { SyncEngine, type SyncMessage, type SyncTransport } from '@korajs/sync'
import {
	ApplyPipeline,
	MergeAwareSyncStore,
	StoreQueueStorage,
	StoreSyncStatePersistence,
} from 'korajs/testing'
import { instrumentDevice, summarize } from './apply-breakdown'
import { HOME_COLLECTION, LMS_COLLECTIONS, lmsFirstSyncSchema } from './lms-first-sync-fixture'

/** A sync store that declines to batch: the pre-C3 per-operation path. */
class PerOperationSyncStore extends MergeAwareSyncStore {
	override async applyDeliveryBatch<T>(): Promise<{ value: T } | null> {
		return null
	}
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

export interface ReplayResult {
	mode: 'batched' | 'per-operation'
	rowsPerCollection: Record<string, number>
	report: Record<string, unknown>
}

/**
 * @param recorded - Every message the live device received, in order (the first is the
 *   handshake response)
 */
export async function replayDelivery(
	recorded: readonly SyncMessage[],
	mode: 'batched' | 'per-operation',
	dir: string,
	school: string,
): Promise<ReplayResult> {
	const emitter = new SimpleEventEmitter()
	const adapter = new BetterSqlite3Adapter(join(dir, `replay-${mode}-${Date.now()}.db`))
	const store = new Store({ schema: lmsFirstSyncSchema, adapter, emitter })
	await store.open()
	const merge = new MergeEngine()
	store.setLocalMutationHandler(new ApplyPipeline({ store, mergeEngine: merge, emitter }))
	const SyncStoreKind = mode === 'batched' ? MergeAwareSyncStore : PerOperationSyncStore

	const inbound: { deliver: ((message: SyncMessage) => void) | null } = { deliver: null }
	const handshakeResponse = recorded.find((message) => message.type === 'handshake-response')
	if (!handshakeResponse) throw new Error('no handshake response recorded')
	const transport: SyncTransport = {
		async connect(): Promise<void> {},
		async disconnect(): Promise<void> {},
		send(message: SyncMessage): void {
			// Answer the handshake with the live session's response; ignore acknowledgements.
			if (message.type === 'handshake') {
				queueMicrotask(() =>
					inbound.deliver?.({ ...handshakeResponse, messageId: `replay-${message.messageId}` }),
				)
			}
		},
		onMessage(handler): void {
			inbound.deliver = handler
		},
		onClose(): void {},
		onError(): void {},
		isConnected(): boolean {
			return true
		},
	}
	const syncStore = new SyncStoreKind(store, merge, emitter)
	const engine = new SyncEngine({
		transport,
		store: syncStore,
		queueStorage: new StoreQueueStorage(adapter),
		syncState: new StoreSyncStatePersistence(store),
		config: {
			url: 'ws://replay',
			schemaVersion: lmsFirstSyncSchema.version,
			auth: async () => ({ token: 'replay' }),
			scopeExit: 'retract',
		},
		emitter,
	})
	const profile = instrumentDevice(adapter, store, engine, syncStore)
	const unsubscribe = store
		.collection(HOME_COLLECTION)
		.where({ schoolId: school })
		.subscribe(() => {})
	await engine.start()
	await drain(engine)

	const started = performance.now()
	for (const message of recorded) {
		if (message.type === 'handshake-response') continue
		inbound.deliver?.(JSON.parse(JSON.stringify(message)) as SyncMessage)
		await drain(engine)
	}
	// Let the last live-query re-run finish.
	await new Promise((resolve) => setTimeout(resolve, 0))
	const wall = performance.now() - started

	const rowsPerCollection: Record<string, number> = {}
	for (const collection of LMS_COLLECTIONS) {
		rowsPerCollection[collection] = (await store.collection(collection).where({}).exec()).length
	}
	unsubscribe()
	await engine.stop()
	await store.close()
	return { mode, rowsPerCollection, report: summarize(profile, wall) }
}
