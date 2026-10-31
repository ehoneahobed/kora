/**
 * Does staged replication pay off on native SQLite (better-sqlite3)? Applies the same
 * delivery stream to a fresh file-backed database directly and through the staging replica,
 * and reports medians. Native SQLite has no journaled-commit cost to avoid, so the expected
 * answer is no, which is why staging is opt-in there (`StorageAdapter.prefersStaging`).
 *
 * KORA_BENCH_NATIVE_OPS (default 20000), KORA_BENCH_NATIVE_RUNS (default 5).
 * Run: pnpm --filter @korajs/test exec vitest run --config vitest.benchmark.config.ts bench/staged-native
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Operation, defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { type OperationBatchMessage, SyncEngine, type SyncMessage } from '@korajs/sync'
import { createMemoryTransportPair } from '@korajs/sync/internal'
import {
	ApplyPipeline,
	MergeAwareSyncStore,
	StoreQueueStorage,
	StoreSyncStatePersistence,
} from 'korajs/testing'
import { expect, test } from 'vitest'

const OPS = Number(process.env.KORA_BENCH_NATIVE_OPS ?? 20_000)
const RUNS = Number(process.env.KORA_BENCH_NATIVE_RUNS ?? 5)

const schema = defineSchema({
	version: 1,
	collections: {
		items: { fields: { title: t.string(), group: t.string(), rank: t.number().default(0) } },
	},
})

function operations(): Operation[] {
	const out: Operation[] = []
	for (let i = 0; i < OPS; i++) {
		const recordId = `r${String(Math.floor(i * 0.6)).padStart(6, '0')}`
		const insert = i === 0 || Math.floor(i * 0.6) !== Math.floor((i - 1) * 0.6)
		out.push({
			id: `op-${i}`,
			nodeId: 'author',
			type: insert ? 'insert' : 'update',
			collection: 'items',
			recordId,
			data: insert ? { title: `t${i}`, group: `g${i % 7}`, rank: i } : { title: `u${i}` },
			previousData: insert ? null : { title: 'x' },
			timestamp: { wallTime: Date.UTC(2026, 0, 1) + i, logical: 0, nodeId: 'author' },
			sequenceNumber: i + 1,
			causalDeps: [],
			schemaVersion: 1,
		})
	}
	return out
}

async function applyStream(
	staged: boolean,
	ops: Operation[],
	dir: string,
	n: number,
): Promise<number> {
	const adapter = new BetterSqlite3Adapter(join(dir, `db-${n}-${staged}.db`))
	const emitter = new SimpleEventEmitter()
	const store = new Store({ schema, adapter, emitter, nodeId: 'device' })
	await store.open()
	const merge = new MergeEngine()
	store.setLocalMutationHandler(new ApplyPipeline({ store, mergeEngine: merge, emitter }))
	const { client, server } = createMemoryTransportPair()
	server.onMessage((message: SyncMessage) => {
		if (message.type === 'handshake') {
			server.send({
				type: 'handshake-response',
				messageId: `r-${message.messageId}`,
				nodeId: 'server',
				versionVector: {},
				schemaVersion: message.schemaVersion,
				accepted: true,
				serverMaxDeliverySequence: ops.length,
			})
		}
	})
	const engine = new SyncEngine({
		transport: client,
		store: new MergeAwareSyncStore(store, merge, emitter),
		queueStorage: new StoreQueueStorage(adapter),
		syncState: new StoreSyncStatePersistence(store),
		config: {
			url: 'ws://bench',
			schemaVersion: 1,
			bulkReplication: staged ? { minOperations: 0 } : false,
		},
		emitter,
	})
	await engine.start()
	const chained = engine as unknown as { messageChain: Promise<void> }
	for (;;) {
		const current = chained.messageChain
		await current
		if (chained.messageChain === current) break
	}
	const started = performance.now()
	for (let start = 0; start < ops.length; start += 100) {
		const slice = ops.slice(start, start + 100)
		const message: OperationBatchMessage = {
			type: 'operation-batch',
			messageId: `m${start}`,
			operations: slice.map((op) => JSON.parse(JSON.stringify(op))),
			isFinal: start + 100 >= ops.length,
			batchIndex: 0,
			baseDeliverySequence: start,
			maxDeliverySequence: start + slice.length,
			operationSequences: slice.map((_, i) => start + i + 1),
			retractions: [],
		}
		server.send(JSON.parse(JSON.stringify(message)) as SyncMessage)
	}
	for (;;) {
		const current = chained.messageChain
		await current
		if (chained.messageChain === current) break
	}
	const took = performance.now() - started
	const rows = await adapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM items')
	expect(rows[0]?.n).toBeGreaterThan(0)
	await engine.stop()
	await store.close()
	return took
}

test(`native SQLite: ${OPS} operations applied directly and through the replica`, async () => {
	const dir = mkdtempSync(join(tmpdir(), 'kora-staged-native-'))
	try {
		const ops = operations()
		const direct: number[] = []
		const staged: number[] = []
		for (let run = 0; run < RUNS; run++) {
			direct.push(await applyStream(false, ops, dir, run))
			staged.push(await applyStream(true, ops, dir, run))
		}
		const median = (values: number[]): number =>
			[...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN
		console.log(
			`[staged-native] ${OPS} ops, ${RUNS} runs: direct median ${median(direct).toFixed(0)} ms (${direct.map((v) => v.toFixed(0)).join(', ')}); staged median ${median(staged).toFixed(0)} ms (${staged.map((v) => v.toFixed(0)).join(', ')})`,
		)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}, 3_600_000)
