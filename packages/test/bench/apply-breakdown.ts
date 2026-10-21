/**
 * Where a device's apply time goes (first-sync benchmark, `KORA_BENCH_BREAKDOWN=1`).
 *
 * The live benchmark shares one event loop between the server and the device, so a wall-clock
 * region on the device would include server work that ran during its awaits. The breakdown
 * therefore replays the delivery batches one device received into a fresh device with no
 * server: only device code runs. It is instrumented from the outside (bench only, no product
 * hooks):
 *
 * - every SQLite statement is timed synchronously inside better-sqlite3 (`run`/`all`/`get` of
 *   the adapter's prepared statements, and `exec` for BEGIN/COMMIT), and attributed by kind
 *   (verb and table family) and by whether it ran inside a storage transaction;
 * - async regions (a delivery batch, one operation's engine apply, the store's apply, the fold,
 *   the post-commit publish, one live-query re-run) record their wall time and the SQL time
 *   spent inside them, so JavaScript time = wall - SQL.
 *
 * Instrumentation overhead is a `performance.now()` pair per statement and region.
 */
import type { Store } from '@korajs/store'
import type { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import type { SyncEngine } from '@korajs/sync'

interface Region {
	wall: number
	/** SQL inside the region (in transactions, plus BEGIN/COMMIT). */
	sql: number
	/** BEGIN / COMMIT / ROLLBACK inside the region. */
	beginCommit: number
	/** Wall time of other regions that ran while this one was active. */
	nested: Record<string, number>
	count: number
}

interface SqlBucket {
	ms: number
	count: number
}

interface StatementLike {
	run(...params: unknown[]): unknown
	all(...params: unknown[]): unknown[]
	get(...params: unknown[]): unknown
}

/** Collected timings of one replay. */
export class ApplyProfile {
	readonly regions = new Map<string, Region>()
	readonly sql = new Map<string, SqlBucket>()
	private readonly active = new Map<string, number>()
	inTransaction = 0

	region(name: string): Region {
		let region = this.regions.get(name)
		if (!region) {
			region = { wall: 0, sql: 0, beginCommit: 0, nested: {}, count: 0 }
			this.regions.set(name, region)
		}
		return region
	}

	/** Time an async region (nesting by name; re-entrant calls count once). */
	async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
		const depth = this.active.get(name) ?? 0
		this.active.set(name, depth + 1)
		const start = performance.now()
		try {
			return await fn()
		} finally {
			const region = this.region(name)
			const wall = performance.now() - start
			if (depth === 0) {
				region.wall += wall
				this.addNested(name, wall)
			}
			region.count += 1
			this.active.set(name, depth)
		}
	}

	private addNested(name: string, wall: number): void {
		for (const [other, depth] of this.active) {
			if (other === name || depth === 0) continue
			const nested = this.region(other).nested
			nested[name] = (nested[name] ?? 0) + wall
		}
	}

	timeSync<T>(name: string, fn: () => T): T {
		const start = performance.now()
		try {
			return fn()
		} finally {
			const region = this.region(name)
			const wall = performance.now() - start
			region.wall += wall
			region.count += 1
			this.addNested(name, wall)
		}
	}

	recordSql(sql: string, ms: number): void {
		const key = `${this.inTransaction > 0 ? 'tx' : 'outside'} ${classify(sql)}`
		const bucket = this.sql.get(key) ?? { ms: 0, count: 0 }
		bucket.ms += ms
		bucket.count += 1
		this.sql.set(key, bucket)
		// Only statements inside a transaction belong to the apply regions: a live-query re-run
		// (outside any transaction) may interleave with an operation's awaits.
		const boundary = /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql.trim())
		const inside = this.inTransaction > 0 || boundary
		for (const [name, depth] of this.active) {
			if (depth === 0 || !(inside || name === 'reactivity')) continue
			const region = this.region(name)
			region.sql += ms
			if (boundary) region.beginCommit += ms
		}
	}
}

/** `verb family` of a statement, e.g. `INSERT oplog`, `SELECT fold-state`, `COMMIT`. */
function classify(sql: string): string {
	const text = sql.trim()
	const verb = (text.match(/^\w+/)?.[0] ?? '?').toUpperCase()
	if (/^(SAVEPOINT|RELEASE|ROLLBACK TO)\b/i.test(text)) return 'savepoint'
	if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(text)) return verb
	const table =
		text.match(/\b(?:FROM|INTO|UPDATE|JOIN)\s+"?([\w]+)"?/i)?.[1] ??
		text.match(/^\w+\s+"?([\w]+)"?/)?.[1] ??
		'?'
	let family = 'rows'
	if (table.startsWith('_kora_ops_')) family = 'oplog'
	else if (table.startsWith('_kora_fold')) family = table.replace(/^_kora_/, '')
	else if (table === '_kora_scope_retractions') family = 'retraction-markers'
	else if (table === '_kora_unapplied_ops') family = 'quarantine'
	else if (table === '_kora_version_vector') family = 'version-vector'
	else if (table === '_kora_meta') family = 'meta'
	else if (table.startsWith('_kora_')) family = table.replace(/^_kora_/, '')
	return `${verb} ${family}`
}

type Patchable = Record<string, unknown>

function patchAsync(
	profile: ApplyProfile,
	target: Patchable,
	method: string,
	region: string,
): void {
	const original = target[method]
	if (typeof original !== 'function') throw new Error(`cannot instrument ${method}`)
	const bound = original.bind(target) as (...args: unknown[]) => Promise<unknown>
	target[method] = (...args: unknown[]) => profile.time(region, () => bound(...args))
}

/**
 * Instrument a device (better-sqlite3 adapter, Store, SyncEngine) in place. Call after the
 * store opened and before the engine starts.
 */
export function instrumentDevice(
	adapter: BetterSqlite3Adapter,
	store: Store,
	engine: SyncEngine,
	syncStore: object,
): ApplyProfile {
	const profile = new ApplyProfile()
	const adapterInternals = adapter as unknown as Patchable & {
		db: { exec(sql: string): unknown } | null
		statement(db: unknown, sql: string): StatementLike
	}
	const db = adapterInternals.db
	if (!db) throw new Error('instrument the device after the store opened')
	const exec = db.exec.bind(db)
	db.exec = (sql: string) => {
		const start = performance.now()
		try {
			return exec(sql)
		} finally {
			profile.recordSql(sql, performance.now() - start)
		}
	}
	const statement = adapterInternals.statement.bind(adapter)
	adapterInternals.statement = (handle: unknown, sql: string): StatementLike => {
		const prepared = statement(handle, sql)
		const timed =
			<K extends keyof StatementLike>(name: K) =>
			(...params: unknown[]) => {
				const start = performance.now()
				try {
					return (prepared[name] as (...p: unknown[]) => unknown)(...params)
				} finally {
					profile.recordSql(sql, performance.now() - start)
				}
			}
		return {
			run: timed('run'),
			all: timed('all') as StatementLike['all'],
			get: timed('get'),
		}
	}
	const transaction = adapter.transaction.bind(adapter)
	adapter.transaction = (fn) =>
		profile.time('storage transaction', () =>
			transaction(async (tx) => {
				profile.inTransaction += 1
				try {
					await fn(tx)
				} finally {
					profile.inTransaction -= 1
				}
			}),
		)

	const engineInternals = engine as unknown as Patchable
	patchAsync(profile, engineInternals, 'handleOperationBatch', 'delivery batch')
	patchAsync(profile, engineInternals, 'applyInbound', 'engine: one operation')
	patchAsync(profile, engineInternals, 'applyDeliveredRetraction', 'engine: one retraction')

	const storeInternals = store as unknown as Patchable & {
		folder: Patchable | null
		subscriptionManager: Patchable
	}
	patchAsync(profile, storeInternals, 'applyRemoteFoldedInTx', 'store: one operation')
	const publish = storeInternals.publishRemoteApply as (...args: unknown[]) => unknown
	storeInternals.publishRemoteApply = (...args: unknown[]) =>
		profile.timeSync('store: publish (post-commit)', () => publish.apply(store, args))
	if (!storeInternals.folder) throw new Error('the fold materialization is required')
	patchAsync(profile, storeInternals.folder, 'applyInTx', 'fold')
	patchAsync(profile, storeInternals.subscriptionManager, 'run', 'reactivity')
	// The korajs pipeline call (batched: inside the step's savepoint; per operation: around
	// the operation's own transaction).
	const pipeline = (syncStore as unknown as { pipeline: Patchable }).pipeline
	patchAsync(profile, pipeline, 'applyRemoteInBatch', 'pipeline')
	patchAsync(profile, pipeline, 'applyRemote', 'pipeline')
	return profile
}

/** A report with shares of the device's busy time (the delivery batches' wall time). */
export function summarize(profile: ApplyProfile, wallMs: number): Record<string, unknown> {
	const r = (name: string): Region => profile.region(name)
	const busy = r('delivery batch').wall
	const sqlTotal = [...profile.sql.values()].reduce((sum, bucket) => sum + bucket.ms, 0)
	const sqlOf = (prefix: string): number =>
		[...profile.sql]
			.filter(([key]) => key.includes(prefix))
			.reduce((sum, [, bucket]) => sum + bucket.ms, 0)
	const beginCommit = sqlOf(' BEGIN') + sqlOf(' COMMIT') + sqlOf(' ROLLBACK')
	const savepoints = sqlOf(' savepoint')
	const fold = r('fold')
	const storeOp = r('store: one operation')
	const engineOp = r('engine: one operation')
	const engineRetraction = r('engine: one retraction')
	const publish = r('store: publish (post-commit)')
	const reactivity = r('reactivity')
	const quarantineWatermark = sqlOf('tx INSERT quarantine') + sqlOf('tx INSERT meta')
	// Exclusive parts of the device's busy time. The per-operation path commits and publishes
	// inside each operation (nested in 'engine: one operation'); the batched path does both
	// once per batch: nested time and BEGIN/COMMIT are taken out of the region that holds them.
	const pipeline = r('pipeline')
	const publishInOp = pipeline.nested['store: publish (post-commit)'] ?? 0
	const parts: Record<string, number> = {
		'fold: JavaScript (mergeOp, state (de)serialization, materialize)': fold.wall - fold.sql,
		'fold: SQL (fold state, rows, provisional, snapshots)': fold.sql,
		'store apply outside the fold: SQL (dedup, visibility markers, op-log append, version vector)':
			storeOp.sql - fold.sql,
		'store apply outside the fold: JavaScript': storeOp.wall - storeOp.sql - (fold.wall - fold.sql),
		'engine per operation, outside the store: JavaScript (content-id verification SHA-256, decode view, transform check, positions, failure bookkeeping)':
			engineOp.wall - pipeline.wall - (engineOp.sql - pipeline.sql),
		'pipeline and savepoint glue around the store apply: JavaScript (korajs pipeline, savepoint + write-behind flush awaits; per operation: transaction open/close awaits)':
			pipeline.wall - storeOp.wall - (pipeline.sql - storeOp.sql) - publishInOp,
		'savepoints and other SQL around the store apply':
			pipeline.sql - storeOp.sql - pipeline.beginCommit + (engineOp.sql - pipeline.sql),
		'retractions (engine + store)': engineRetraction.wall - engineRetraction.beginCommit,
		'BEGIN / COMMIT / ROLLBACK': beginCommit,
		'quarantine rows + watermark write': quarantineWatermark,
		'publish after commit (notifications, events, merge traces)': publish.wall,
	}
	const accounted = Object.values(parts).reduce((sum, ms) => sum + ms, 0)
	parts['batch rest (message decode, ack, bookkeeping, settle)'] = busy - accounted
	const share = (ms: number): string => `${((100 * ms) / Math.max(busy, 1)).toFixed(1)}%`
	return {
		replayWallMs: Math.round(wallMs),
		deviceBusyMs: Math.round(busy),
		sqlMsInsideBatches: Math.round(sqlTotal - sqlOf('outside ')),
		savepointMs: Math.round(savepoints),
		reactivityMs: Math.round(reactivity.wall),
		reactivityRuns: reactivity.count,
		transactions: r('storage transaction').count,
		operations: engineOp.count,
		breakdown: Object.fromEntries(
			Object.entries(parts)
				.sort((a, b) => b[1] - a[1])
				.map(([name, ms]) => [name, { ms: Math.round(ms), share: share(ms) }]),
		),
		sqlByKind: Object.fromEntries(
			[...profile.sql]
				.sort((a, b) => b[1].ms - a[1].ms)
				.slice(0, 18)
				.map(([key, bucket]) => [
					key,
					{
						ms: Math.round(bucket.ms),
						count: bucket.count,
						usPerStatement: Math.round((1000 * bucket.ms) / bucket.count),
					},
				]),
		),
	}
}
