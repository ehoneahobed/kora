/**
 * First-sync benchmark (workstream C, docs/design/fast-first-sync.md).
 *
 * A fresh device (real Store on better-sqlite3, real SyncEngine, the korajs adapters)
 * signs in to a server whose log holds an LMS-shaped history and syncs its scope over
 * a modelled network. Timed from `engine.start()`:
 *
 * - `firstBatchMs`: the first delivery batch is applied (`sync:received`);
 * - `firstHomeRowMs`: the home query (`courses` of the device's school, subscribed
 *   before the start) first returns a row;
 * - `homeCompleteMs`: the home query returns every live course of the school;
 * - `fullScopeMs`: the engine reaches `streaming` (initial sync complete) and every
 *   collection holds exactly the school's live records.
 *
 * Environment (all optional):
 * - KORA_BENCH_VISIBLE_OPS (default 20000): operations of the device's school
 * - KORA_BENCH_TENANTS (default 5): schools sharing the log
 * - KORA_BENCH_PROFILE (default slow-4g): slow-4g | fast-4g | unthrottled
 * - KORA_BENCH_STORE (default sqlite): sqlite | memory | postgres (KORA_PG_TEST_URL)
 * - KORA_BENCH_RUNS (default 1): fresh devices per run (the server is seeded once)
 * - KORA_BENCH_BATCH (default 100): server delivery batch size
 * - KORA_BENCH_MOVE_RATE (default 0): share of updates that move a record to another
 *   school. Above 0 it reproduces the same-batch retraction ordering defect (see the
 *   design doc, "Found while measuring"): the device keeps a record whose insert and
 *   scope exit share one delivery batch, and the correctness check fails.
 *
 * Run: pnpm --filter @korajs/test bench:first-sync
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import type { Operation } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import {
	KoraSyncServer,
	MemoryServerStore,
	type ServerStore,
	TokenAuthProvider,
	createSqliteServerStore,
} from '@korajs/server'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { SyncEngine } from '@korajs/sync'
import {
	ApplyPipeline,
	MergeAwareSyncStore,
	StoreQueueStorage,
	StoreSyncStatePersistence,
} from 'korajs/testing'
import { afterAll, expect, test } from 'vitest'
import {
	HOME_COLLECTION,
	LMS_COLLECTIONS,
	generateLmsFixture,
	lmsFirstSyncSchema,
} from './lms-first-sync-fixture'
import {
	FAST_4G,
	type LinkProfile,
	SLOW_4G,
	UNTHROTTLED,
	createThrottledPair,
} from './throttled-link'

const VISIBLE_OPS = Number(process.env.KORA_BENCH_VISIBLE_OPS ?? 20_000)
const TENANTS = Number(process.env.KORA_BENCH_TENANTS ?? 5)
const RUNS = Number(process.env.KORA_BENCH_RUNS ?? 1)
const BATCH = Number(process.env.KORA_BENCH_BATCH ?? 100)
const PROFILE: LinkProfile =
	{ 'slow-4g': SLOW_4G, 'fast-4g': FAST_4G, unthrottled: UNTHROTTLED }[
		process.env.KORA_BENCH_PROFILE ?? 'slow-4g'
	] ?? SLOW_4G
const STORE = process.env.KORA_BENCH_STORE ?? 'sqlite'
const MOVE_RATE = Number(process.env.KORA_BENCH_MOVE_RATE ?? 0)

const tmp = mkdtempSync(join(tmpdir(), 'kora-first-sync-'))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {})
	rmSync(tmp, { recursive: true, force: true })
})

async function createServerStore(): Promise<ServerStore> {
	if (STORE === 'memory') return new MemoryServerStore()
	if (STORE === 'postgres') {
		const { createPostgresServerStore } = await import('@korajs/server')
		const url = process.env.KORA_PG_TEST_URL
		if (!url) throw new Error('KORA_BENCH_STORE=postgres needs KORA_PG_TEST_URL')
		return createPostgresServerStore({ connectionString: url })
	}
	return createSqliteServerStore({ filename: join(tmp, 'server.db') })
}

interface RunResult {
	/** Sum of the device's per-operation apply time (store transaction + fold). */
	clientApplyMs: number
	handshakeMs: number | null
	firstBatchMs: number | null
	firstHomeRowMs: number | null
	homeCompleteMs: number | null
	fullScopeMs: number
	batches: number
	operationsReceived: number
	downWireKiB: number
	downJsonKiB: number
}

async function runDevice(
	server: KoraSyncServer,
	serverStore: ServerStore,
	school: string,
	homeRows: number,
	liveInScope: Record<string, number>,
	index: number,
): Promise<RunResult> {
	const emitter = new SimpleEventEmitter()
	const adapter = new BetterSqlite3Adapter(join(tmp, `device-${index}.db`))
	const store = new Store({ schema: lmsFirstSyncSchema, adapter, emitter })
	await store.open()
	const merge = new MergeEngine()
	store.setLocalMutationHandler(new ApplyPipeline({ store, mergeEngine: merge, emitter }))
	const link = createThrottledPair(PROFILE)
	const engine = new SyncEngine({
		transport: link.client,
		store: new MergeAwareSyncStore(store, merge, emitter),
		queueStorage: new StoreQueueStorage(adapter),
		syncState: new StoreSyncStatePersistence(store),
		config: {
			url: 'ws://bench',
			schemaVersion: lmsFirstSyncSchema.version,
			auth: async () => ({ token: `user-${index}` }),
			// A record that moves to another school leaves the device, so it holds exactly
			// its scope (the default, 'retain', keeps it).
			scopeExit: 'retract',
		},
		emitter,
	})

	const result: RunResult = {
		clientApplyMs: 0,
		handshakeMs: null,
		firstBatchMs: null,
		firstHomeRowMs: null,
		homeCompleteMs: null,
		fullScopeMs: 0,
		batches: 0,
		operationsReceived: 0,
		downWireKiB: 0,
		downJsonKiB: 0,
	}
	let started = 0
	emitter.on('sync:received', (event: { operations: Operation[] }) => {
		result.batches += 1
		result.operationsReceived += event.operations.length
		if (result.firstBatchMs === null) result.firstBatchMs = performance.now() - started
	})
	emitter.on('operation:applied', (event: { duration: number }) => {
		result.clientApplyMs += event.duration
	})
	const unsubscribe = store
		.collection(HOME_COLLECTION)
		.where({ schoolId: school })
		.subscribe((rows) => {
			if (started === 0) return
			const now = performance.now() - started
			if (rows.length > 0 && result.firstHomeRowMs === null) result.firstHomeRowMs = now
			if (rows.length >= homeRows && result.homeCompleteMs === null) result.homeCompleteMs = now
		})

	server.handleConnection(link.server)
	started = performance.now()
	await engine.start()
	const deadline = started + 30 * 60_000
	while (engine.getState() !== 'streaming') {
		if (performance.now() > deadline) throw new Error('first sync did not complete in 30 minutes')
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	result.fullScopeMs = performance.now() - started
	const handshakeAt = link.stats.firstDownAt['handshake-response']
	result.handshakeMs = handshakeAt === undefined ? null : handshakeAt - started
	result.downWireKiB = Math.round(link.stats.downWireBytes / 1024)
	result.downJsonKiB = Math.round(link.stats.downJsonBytes / 1024)

	// Correctness: the device holds exactly the school's live records, as the server
	// materialized them.
	for (const collection of LMS_COLLECTIONS) {
		const rows = (await store.collection(collection).where({}).exec()) as Array<{ id: string }>
		const expected = await serverStore.queryCollection(collection, { where: { schoolId: school } })
		const mine = rows.map((row) => row.id).sort()
		const theirs = expected.map((row) => String(row.id)).sort()
		if (mine.join() !== theirs.join()) {
			console.log(collection, {
				extra: mine.filter((id) => !theirs.includes(id)),
				missing: theirs.filter((id) => !mine.includes(id)),
				generator: liveInScope[collection] ?? 0,
			})
		}
		expect(mine, collection).toEqual(theirs)
	}
	unsubscribe()
	await engine.stop()
	await store.close()
	return result
}

test(`first sync: ${VISIBLE_OPS} visible ops, ${TENANTS} tenants, ${PROFILE.name}, ${STORE}`, async () => {
	const generated = performance.now()
	const fixture = await generateLmsFixture({
		visibleOps: VISIBLE_OPS,
		tenants: TENANTS,
		moveRate: MOVE_RATE,
	})
	const generateMs = performance.now() - generated

	const store = await createServerStore()
	await store.setSchema(lmsFirstSyncSchema)
	const seeded = performance.now()
	for (const op of fixture.operations) await store.applyRemoteOperation(op)
	const seedMs = performance.now() - seeded

	const server = new KoraSyncServer({
		store,
		schemaVersion: lmsFirstSyncSchema.version,
		supportedSchemaVersions: { min: 1, max: 1 },
		batchSize: BATCH,
		relayRetransmitIntervalMs: 0,
		sessionRevalidationIntervalMs: 0,
		auth: new TokenAuthProvider({
			validate: async (token) => ({
				userId: token,
				scopes: Object.fromEntries(
					LMS_COLLECTIONS.map((collection) => [collection, { schoolId: fixture.school }]),
				),
			}),
		}),
	})
	cleanups.push(async () => {
		await server.stop()
		await store.close()
	})

	// What a C1 record snapshot of the same scope would carry (design doc, C1 "payload"):
	// every live in-scope record's values plus its serialized fold state, in batches
	// of BATCH records, JSON and per-message deflate like the operation batches.
	let snapshotJson = 0
	let snapshotWire = 0
	let snapshotRecords = 0
	let pendingBatch: unknown[] = []
	const flushSnapshot = (): void => {
		if (pendingBatch.length === 0) return
		const text = JSON.stringify({ type: 'record-snapshot', records: pendingBatch })
		snapshotJson += Buffer.byteLength(text)
		snapshotWire += deflateRawSync(text).length
		pendingBatch = []
	}
	for (const collection of LMS_COLLECTIONS) {
		const rows = await store.queryCollection(collection, { where: { schoolId: fixture.school } })
		for (const row of rows) {
			const state = await store.getRecordFoldState?.(collection, String(row.id))
			pendingBatch.push({ c: collection, r: row.id, values: row, foldState: state })
			snapshotRecords += 1
			if (pendingBatch.length >= BATCH) flushSnapshot()
		}
	}
	flushSnapshot()

	const results: RunResult[] = []
	for (let run = 0; run < RUNS; run++) {
		results.push(
			await runDevice(server, store, fixture.school, fixture.homeRows, fixture.liveInScope, run),
		)
	}

	console.log(
		JSON.stringify(
			{
				fixture: {
					totalOps: fixture.operations.length,
					visibleOps: fixture.visibleOps,
					tenants: TENANTS,
					moveRate: MOVE_RATE,
					liveRecordsInScope: Object.values(fixture.liveInScope).reduce((a, b) => a + b, 0),
					homeRows: fixture.homeRows,
					generateMs: Math.round(generateMs),
					seedMs: Math.round(seedMs),
				},
				snapshotEstimate: {
					records: snapshotRecords,
					jsonKiB: Math.round(snapshotJson / 1024),
					wireKiB: Math.round(snapshotWire / 1024),
				},
				profile: PROFILE.name,
				store: STORE,
				batchSize: BATCH,
				runs: results.map((r) => ({
					...r,
					clientApplyMs: Math.round(r.clientApplyMs),
					handshakeMs: r.handshakeMs === null ? null : Math.round(r.handshakeMs),
					firstBatchMs: r.firstBatchMs === null ? null : Math.round(r.firstBatchMs),
					firstHomeRowMs: r.firstHomeRowMs === null ? null : Math.round(r.firstHomeRowMs),
					homeCompleteMs: r.homeCompleteMs === null ? null : Math.round(r.homeCompleteMs),
					fullScopeMs: Math.round(r.fullScopeMs),
				})),
			},
			null,
			2,
		),
	)
})
