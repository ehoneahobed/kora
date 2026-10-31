import { KoraError, quoteIdent } from '@korajs/core'
import type { HLCTimestamp, Operation, SchemaDefinition } from '@korajs/core'
import { deserializeOperationWithCollection } from '../serialization/serializer'
import type { OperationRow, StorageAdapter, Transaction, TransactionStatement } from '../types'

/** Staging tables that hold one row (or more) per record, keyed by `(collection, record_id)`. */
const FOLD_TABLES = ['_kora_fold_state', '_kora_fold_base', '_kora_fold_snapshot'] as const
const PROVISIONAL_TABLE = '_kora_provisional_ops'
const RETRACTION_TABLE = '_kora_scope_retractions'

/** Bound variables per INSERT statement (SQLite allows 32,766 since 3.32; stay far below). */
const MAX_PARAMS_PER_STATEMENT = 8_000
/** Records per `IN (...)` list (one parameter each, times the tables of the presence query). */
const MAX_IN_LIST = 400
/** Work one main-database transaction should take, so a foreground write waits at most this long. */
const TARGET_CHUNK_MS = 150
const MIN_CHUNK_RECORDS = 20
const MAX_CHUNK_RECORDS = 1_000
const FIRST_CHUNK_RECORDS = 100

/**
 * What a merge needs from the store it merges into. The store implements this over its
 * private state, so this module never reaches into the store.
 */
export interface StagingMergeHost {
	readonly schema: SchemaDefinition
	/** Run `fn` as one write transaction on the live database (the store's write gate applies). */
	transaction(fn: (tx: Transaction) => Promise<void>): Promise<void>
	/** Node ids this database authors under; their operations never copy (see the merge). */
	localNodeIds(): Promise<ReadonlySet<string>>
	/** The collection's rows are about to change: instant-update verification must not trust them. */
	touchCollection(collection: string): void
	/** A merge chunk committed: the version vector in memory follows the one in the database. */
	noteVersionVector(entries: ReadonlyMap<string, number>): void
	/** The newest timestamp the merged operations carry; local writes must be stamped after it. */
	receiveTimestamp(timestamp: HLCTimestamp): void
	/** Re-run live queries over `collection` (once, after the merge). */
	invalidate(collection: string): void
	/** Apply one operation exactly as the sync engine would (deduplicates, folds, cascades). */
	replay(operation: Operation): Promise<void>
	/** Throw when this store may not take a merge now (retired tab, closed store). */
	assertWritable(): void
	/** The tab is shutting down or the engine gave up the merge: stop between chunks. */
	shouldContinue(): boolean
}

/** Where the merged replica's progress lands, written in the merge's final transaction. */
export interface StagingMergeTarget {
	/** Statements that persist the watermark (and the completion mark) in `tx`. */
	writeProgress(tx: Transaction): Promise<void>
}

/** Outcome of {@link mergeStagingInto}. */
export type StagingMergeResult =
	| {
			kind: 'merged'
			/** Operations copied into the live log (replayed ones excluded). */
			operations: number
			/** Records copied whole. */
			records: number
			/** Records the live database already knew: their staged operations were replayed. */
			contestedRecords: number
			/** Staged operations replayed through the ordinary apply path. */
			replayedOperations: number
			/** Quarantine rows copied. */
			quarantined: number
			/** Main-database transactions the merge used. */
			chunks: number
			durationMs: number
	  }
	| { kind: 'unmergeable'; reason: string }

/** Raised inside a chunk to abandon the merge without losing what earlier chunks committed. */
class Unmergeable extends KoraError {
	constructor(reason: string) {
		super(`The staged replica cannot be merged: ${reason}`, 'STAGING_UNMERGEABLE', { reason })
		this.name = 'Unmergeable'
	}
}

function inList(count: number): string {
	return Array.from({ length: count }, () => '?').join(', ')
}

function slices<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
	return out
}

/** `INSERT INTO table (columns) VALUES (...), (...)`, split so no statement binds too many values. */
function insertStatements(
	table: string,
	columns: readonly string[],
	rows: ReadonlyArray<Record<string, unknown>>,
	verb = 'INSERT',
): TransactionStatement[] {
	if (rows.length === 0 || columns.length === 0) return []
	const perStatement = Math.max(1, Math.floor(MAX_PARAMS_PER_STATEMENT / columns.length))
	const head = `${verb} INTO ${quoteIdent(table)} (${columns.map((c) => quoteIdent(c)).join(', ')}) VALUES `
	const out: TransactionStatement[] = []
	for (const group of slices(rows, perStatement)) {
		const tuple = `(${columns.map(() => '?').join(', ')})`
		const params: unknown[] = []
		for (const row of group) for (const column of columns) params.push(row[column] ?? null)
		out.push({ sql: head + group.map(() => tuple).join(', '), params })
	}
	return out
}

async function run(tx: Transaction, statements: readonly TransactionStatement[]): Promise<void> {
	if (statements.length === 0) return
	if (tx.executeBatch) {
		await tx.executeBatch(statements)
		return
	}
	for (const statement of statements) await tx.execute(statement.sql, statement.params)
}

/** Column names of `table` in `adapter`. */
async function columnsOf(adapter: StorageAdapter, table: string): Promise<string[]> {
	const rows = await adapter.query<{ name: string }>(`PRAGMA table_info(${quoteIdent(table)})`)
	return rows.map((row) => row.name)
}

async function columnsIn(tx: Transaction, table: string): Promise<string[]> {
	const rows = await tx.query<{ name: string }>(`PRAGMA table_info(${quoteIdent(table)})`)
	return rows.map((row) => row.name)
}

/**
 * Every record id the staging database holds anything for, in one collection, sorted.
 * A record that has a log but no row (its insert was refused) is included.
 */
async function stagedRecordIds(staging: StorageAdapter, collection: string): Promise<string[]> {
	const ops = quoteIdent(`_kora_ops_${collection}`)
	const rows = await staging.query<{ id: string }>(
		`SELECT id FROM ${quoteIdent(collection)}
     UNION SELECT record_id FROM ${ops}
     UNION SELECT record_id FROM _kora_fold_state WHERE collection = ?
     UNION SELECT record_id FROM _kora_fold_base WHERE collection = ?
     UNION SELECT record_id FROM _kora_fold_snapshot WHERE collection = ?
     UNION SELECT record_id FROM ${PROVISIONAL_TABLE} WHERE collection = ?
     UNION SELECT record_id FROM ${RETRACTION_TABLE} WHERE collection = ?
     ORDER BY 1`,
		[collection, collection, collection, collection, collection],
	)
	return rows.map((row) => row.id)
}

/** The ids, among `ids`, the live database holds anything for. Read inside the chunk's transaction. */
async function presentInMain(
	tx: Transaction,
	collection: string,
	ids: readonly string[],
): Promise<Set<string>> {
	const present = new Set<string>()
	const ops = quoteIdent(`_kora_ops_${collection}`)
	for (const group of slices(ids, MAX_IN_LIST)) {
		const list = inList(group.length)
		const rows = await tx.query<{ id: string }>(
			`SELECT id FROM ${quoteIdent(collection)} WHERE id IN (${list})
       UNION SELECT record_id FROM ${ops} WHERE record_id IN (${list})
       UNION SELECT record_id FROM _kora_fold_state WHERE collection = ? AND record_id IN (${list})
       UNION SELECT record_id FROM _kora_fold_base WHERE collection = ? AND record_id IN (${list})
       UNION SELECT record_id FROM _kora_fold_snapshot WHERE collection = ? AND record_id IN (${list})
       UNION SELECT record_id FROM ${PROVISIONAL_TABLE} WHERE collection = ? AND record_id IN (${list})
       UNION SELECT record_id FROM ${RETRACTION_TABLE} WHERE collection = ? AND record_id IN (${list})`,
			[
				...group,
				...group,
				collection,
				...group,
				collection,
				...group,
				collection,
				...group,
				collection,
				...group,
				collection,
				...group,
			],
		)
		for (const row of rows) present.add(row.id)
	}
	return present
}

/** Staged rows of the given tables for `ids`. */
async function readStaged<T>(
	staging: StorageAdapter,
	sql: (list: string) => string,
	prefix: readonly unknown[],
	ids: readonly string[],
): Promise<T[]> {
	const out: T[] = []
	for (const group of slices(ids, MAX_IN_LIST)) {
		const rows = await staging.query<T>(sql(inList(group.length)), [...prefix, ...group])
		out.push(...rows)
	}
	return out
}

interface StagedOpRow {
	id: string
	node_id: string
	record_id: string
	sequence_number: number
	timestamp: string
	[column: string]: unknown
}

/** The newest HLC among operation rows (their `timestamp` column is serialized JSON). */
function newestTimestamp(
	rows: readonly StagedOpRow[],
	into: HLCTimestamp | null,
): HLCTimestamp | null {
	let best = into
	for (const row of rows) {
		let ts: HLCTimestamp
		try {
			ts = JSON.parse(row.timestamp) as HLCTimestamp
		} catch {
			continue
		}
		if (
			best === null ||
			ts.wallTime > best.wallTime ||
			(ts.wallTime === best.wallTime && ts.logical > best.logical)
		) {
			best = ts
		}
	}
	return best
}

/**
 * The collections in an order that copies a parent before the children that reference it
 * (a many-to-one relation's `to` before its `from`), so a foreign key is satisfied in every
 * committed chunk. Collections in a cycle keep the schema's order; a cycle that a chunk
 * cannot satisfy fails its commit, and the caller replicates directly (nothing is lost).
 */
function collectionOrder(schema: StagingMergeHost['schema']): string[] {
	const names = Object.keys(schema.collections)
	const parents = new Map<string, Set<string>>()
	for (const relation of Object.values(schema.relations ?? {})) {
		if (relation.from === relation.to) continue
		if (!(relation.from in schema.collections) || !(relation.to in schema.collections)) continue
		const set = parents.get(relation.from) ?? new Set<string>()
		set.add(relation.to)
		parents.set(relation.from, set)
	}
	const ordered: string[] = []
	const state = new Map<string, 'visiting' | 'done'>()
	const visit = (name: string): void => {
		if (state.has(name)) return
		state.set(name, 'visiting')
		for (const parent of parents.get(name) ?? []) visit(parent)
		state.set(name, 'done')
		ordered.push(name)
	}
	for (const name of names) visit(name)
	return ordered
}

/**
 * Orders a collection's record ids so a record comes after the record of the same collection
 * its foreign key names (a self-referencing relation), when both are staged.
 */
async function parentsFirst(
	staging: StorageAdapter,
	schema: StagingMergeHost['schema'],
	collection: string,
	ids: string[],
): Promise<string[]> {
	const fields = Object.values(schema.relations ?? {})
		.filter((relation) => relation.from === collection && relation.to === collection)
		.map((relation) => relation.field)
	if (fields.length === 0) return ids
	const staged = new Set(ids)
	const parentOf = new Map<string, string[]>()
	for (const field of fields) {
		const rows = await staging.query<{ id: string; parent: string | null }>(
			`SELECT id, ${quoteIdent(field)} AS parent FROM ${quoteIdent(collection)} WHERE ${quoteIdent(field)} IS NOT NULL`,
		)
		for (const row of rows) {
			if (row.parent === null || !staged.has(row.parent)) continue
			parentOf.set(row.id, [...(parentOf.get(row.id) ?? []), row.parent])
		}
	}
	if (parentOf.size === 0) return ids
	const ordered: string[] = []
	const seen = new Set<string>()
	const visit = (id: string): void => {
		if (seen.has(id)) return
		seen.add(id)
		for (const parent of parentOf.get(id) ?? []) visit(parent)
		ordered.push(id)
	}
	for (const id of ids) visit(id)
	return ordered
}

/**
 * Merge a staging replica into the live database (`docs/design/first-visit-parity.md` 5.7.4).
 *
 * The staging database holds exactly what applying the same delivery stream to an empty
 * database would hold: per record the operations, the fold state, the materialized row, the
 * retraction marker and the provisional effects, all derived deterministically from the
 * record's set of operations. So a record the live database knows nothing about is **copied
 * whole** (rows, log, fold tables) in one transaction, with no fold work. A record the live
 * database knows something about (a write made on this device while replicating, an operation
 * an earlier crashed merge already copied, an operation under one of this database's own node
 * ids) is **never copied over**: its staged operations are replayed through the ordinary apply
 * path, which deduplicates by id and folds with the live database's own history, so the result
 * is `fold(staged ∪ live)` by the fold's own order-independence.
 *
 * Every chunk is a set of whole records in one transaction, so a crash leaves each record
 * either untouched or complete (log, state and row together), never a state without its log
 * (which a later re-fold would erase). The version vector moves in the same transaction as
 * the operations it counts. The watermark, the quarantine rows and the completion mark are
 * written last, in one transaction, so the delivery watermark never passes data that is not
 * durable (invariant: gap-free delivery).
 *
 * @returns `unmergeable` (nothing wrong is left behind; chunks already committed hold whole
 *   records) when the staged state cannot be reproduced faithfully by copying: the caller
 *   discards the staging database and replicates again from the live watermark.
 */
export async function mergeStagingInto(
	host: StagingMergeHost,
	staging: StorageAdapter,
	target: StagingMergeTarget,
): Promise<StagingMergeResult> {
	const startedAt = Date.now()
	const schema = host.schema
	let chunks = 0
	let operations = 0
	let records = 0
	let contestedRecords = 0
	let replayedOperations = 0
	let newest: HLCTimestamp | null = null
	const touched = new Set<string>()
	const localNodes = await host.localNodeIds()
	let chunkSize = FIRST_CHUNK_RECORDS

	try {
		for (const collection of collectionOrder(schema)) {
			const rowTable = collection
			const opsTable = `_kora_ops_${collection}`
			const stagedRowColumns = await columnsOf(staging, rowTable)
			const stagedOpColumns = await columnsOf(staging, opsTable)
			const ids = await parentsFirst(
				staging,
				schema,
				collection,
				await stagedRecordIds(staging, collection),
			)
			if (ids.length === 0) continue
			let nextIndex = 0

			while (nextIndex < ids.length) {
				if (!host.shouldContinue()) throw new Unmergeable('the merge was cancelled')
				host.assertWritable()
				const page = ids.slice(nextIndex, nextIndex + chunkSize)
				nextIndex += page.length
				const chunkStarted = Date.now()

				// Read the page from staging, outside the live transaction (a different database).
				const rows = await readStaged<Record<string, unknown> & { id: string }>(
					staging,
					(list) => `SELECT * FROM ${quoteIdent(rowTable)} WHERE id IN (${list})`,
					[],
					page,
				)
				const opRows = await readStaged<StagedOpRow>(
					staging,
					(list) => `SELECT * FROM ${quoteIdent(opsTable)} WHERE record_id IN (${list})`,
					[],
					page,
				)
				const foldRows = new Map<
					string,
					Array<{ collection: string; record_id: string; state: string }>
				>()
				for (const table of FOLD_TABLES) {
					foldRows.set(
						table,
						await readStaged(
							staging,
							(list) => `SELECT * FROM ${table} WHERE collection = ? AND record_id IN (${list})`,
							[collection],
							page,
						),
					)
				}
				const provisionalRows = await readStaged<Record<string, unknown> & { record_id: string }>(
					staging,
					(list) =>
						`SELECT * FROM ${PROVISIONAL_TABLE} WHERE collection = ? AND record_id IN (${list})`,
					[collection],
					page,
				)
				const retractionRows = await readStaged<Record<string, unknown> & { record_id: string }>(
					staging,
					(list) =>
						`SELECT * FROM ${RETRACTION_TABLE} WHERE collection = ? AND record_id IN (${list})`,
					[collection],
					page,
				)

				let contestedOpRows: StagedOpRow[] = []
				let copied = { records: 0, operations: 0 }
				let contested = 0
				const versionVector = new Map<string, number>()

				await host.transaction(async (tx) => {
					// Reset per attempt: the transaction callback may run again after a retry.
					contestedOpRows = []
					copied = { records: 0, operations: 0 }
					contested = 0
					versionVector.clear()

					// A foreign key is checked when the chunk commits, so a self-referencing page may
					// hold a child beside its parent in any order.
					await tx.execute('PRAGMA defer_foreign_keys = ON')
					const liveRowColumns = await columnsIn(tx, rowTable)
					const liveOpColumns = await columnsIn(tx, opsTable)
					for (const column of stagedRowColumns) {
						if (!liveRowColumns.includes(column)) {
							throw new Unmergeable(`"${rowTable}.${column}" is not a column of the live table`)
						}
					}
					for (const column of stagedOpColumns) {
						if (!liveOpColumns.includes(column)) {
							throw new Unmergeable(`"${opsTable}.${column}" is not a column of the live log`)
						}
					}

					const present = await presentInMain(tx, collection, page)
					const contestedIds = new Set<string>(present)

					// Operations under this database's own node ids, or under a (node, sequence) the
					// live log already holds for another id, need the ordinary path's conflict rows.
					const wanted = new Map<string, Set<number>>()
					for (const row of opRows) {
						if (contestedIds.has(row.record_id)) continue
						if (localNodes.has(row.node_id)) {
							contestedIds.add(row.record_id)
							continue
						}
						let seqs = wanted.get(row.node_id)
						if (!seqs) {
							seqs = new Set()
							wanted.set(row.node_id, seqs)
						}
						seqs.add(row.sequence_number)
					}
					for (const [nodeId, seqs] of wanted) {
						for (const group of slices([...seqs], MAX_IN_LIST)) {
							const taken = await tx.query<{ id: string; sequence_number: number }>(
								`SELECT id, sequence_number FROM ${quoteIdent(opsTable)} WHERE node_id = ? AND sequence_number IN (${inList(group.length)})`,
								[nodeId, ...group],
							)
							if (taken.length === 0) continue
							const held = new Set(taken.map((row) => `${nodeId}\u0000${row.sequence_number}`))
							for (const row of opRows) {
								if (row.node_id === nodeId && held.has(`${nodeId}\u0000${row.sequence_number}`)) {
									contestedIds.add(row.record_id)
								}
							}
						}
					}

					// A contested record replays its operations without delivery positions; a
					// retraction marker (staged or live) needs them, so that record cannot be merged.
					for (const row of retractionRows) {
						if (contestedIds.has(row.record_id)) {
							throw new Unmergeable(
								`"${collection}" record ${row.record_id} is retracted and was also written here`,
							)
						}
					}
					if (contestedIds.size > 0) {
						const liveRetractions: Array<{ record_id: string }> = []
						for (const group of slices([...contestedIds], MAX_IN_LIST)) {
							liveRetractions.push(
								...(await tx.query<{ record_id: string }>(
									`SELECT record_id FROM ${RETRACTION_TABLE} WHERE collection = ? AND record_id IN (${inList(group.length)})`,
									[collection, ...group],
								)),
							)
						}
						if (liveRetractions.length > 0) {
							throw new Unmergeable(
								`"${collection}" record ${liveRetractions[0]?.record_id} is retracted here and was also delivered`,
							)
						}
					}

					const isCopied = (id: string): boolean => !contestedIds.has(id)
					const copyRows = rows.filter((row) => isCopied(row.id))
					const copyOps = opRows.filter((row) => isCopied(row.record_id))
					host.touchCollection(collection)
					const statements: TransactionStatement[] = []
					statements.push(...insertStatements(rowTable, stagedRowColumns, copyRows))
					statements.push(...insertStatements(opsTable, stagedOpColumns, copyOps))
					for (const table of FOLD_TABLES) {
						const list = (foldRows.get(table) ?? []).filter((row) => isCopied(row.record_id))
						statements.push(...insertStatements(table, ['collection', 'record_id', 'state'], list))
					}
					statements.push(
						...insertStatements(
							PROVISIONAL_TABLE,
							['id', 'collection', 'record_id', 'parent_id', 'operation'],
							provisionalRows.filter((row) => isCopied(row.record_id)),
						),
					)
					statements.push(
						...insertStatements(
							RETRACTION_TABLE,
							['collection', 'record_id', 'position'],
							retractionRows.filter((row) => isCopied(row.record_id)),
						),
					)
					for (const row of copyOps) {
						const previous = versionVector.get(row.node_id) ?? 0
						if (row.sequence_number > previous) versionVector.set(row.node_id, row.sequence_number)
					}
					for (const [nodeId, sequenceNumber] of versionVector) {
						statements.push({
							sql: `INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = MAX(sequence_number, excluded.sequence_number)`,
							params: [nodeId, sequenceNumber],
						})
					}
					await run(tx, statements)

					const copiedRecordIds = new Set<string>()
					for (const id of page) if (isCopied(id)) copiedRecordIds.add(id)
					copied = { records: copiedRecordIds.size, operations: copyOps.length }
					contested = contestedIds.size
					contestedOpRows = opRows.filter((row) => contestedIds.has(row.record_id))
				})

				chunks += 1
				records += copied.records
				operations += copied.operations
				contestedRecords += contested
				if (copied.records > 0 || copied.operations > 0) touched.add(collection)
				newest = newestTimestamp(opRows, newest)
				if (versionVector.size > 0) host.noteVersionVector(versionVector)

				// The ordinary path for what the live database already knows. After the chunk's
				// commit, so a failed replay costs the next attempt only duplicates.
				for (const row of contestedOpRows) {
					const operation = deserializeOperationWithCollection(
						row as unknown as OperationRow,
						collection,
					)
					await host.replay(operation)
					replayedOperations += 1
					touched.add(collection)
				}

				// Size the next chunk so a transaction takes about TARGET_CHUNK_MS of the live worker.
				const took = Math.max(1, Date.now() - chunkStarted)
				const scaled = Math.round((page.length * TARGET_CHUNK_MS) / took)
				chunkSize = Math.min(MAX_CHUNK_RECORDS, Math.max(MIN_CHUNK_RECORDS, scaled))
			}
		}

		// Everything else in one final transaction: quarantine, markers, progress.
		if (!host.shouldContinue()) throw new Unmergeable('the merge was cancelled')
		host.assertWritable()
		const stagedQuarantine = await staging
			.query<Record<string, unknown>>('SELECT * FROM _kora_unapplied_ops')
			.catch(() => [] as Array<Record<string, unknown>>)
		const stagedReceived = await staging
			.query<{ id: string }>('SELECT id FROM _kora_received_local_ops')
			.catch(() => [] as Array<{ id: string }>)
		const stagedConflicts = await staging
			.query<{ n: number }>('SELECT COUNT(*) AS n FROM _kora_seq_conflicts')
			.catch(() => [{ n: 0 }])
		if ((stagedConflicts[0]?.n ?? 0) > 0) {
			throw new Unmergeable('the staged log holds sequence-conflict rows')
		}
		const stagedVector = await staging.query<{ node_id: string; sequence_number: number }>(
			'SELECT node_id, sequence_number FROM _kora_version_vector',
		)
		const vectorUpdate = new Map<string, number>()
		await host.transaction(async (tx) => {
			vectorUpdate.clear()
			const statements: TransactionStatement[] = []
			if (stagedQuarantine.length > 0) {
				const columns = Object.keys(stagedQuarantine[0] ?? {})
				statements.push(
					...insertStatements('_kora_unapplied_ops', columns, stagedQuarantine, 'INSERT OR IGNORE'),
				)
			}
			if (stagedReceived.length > 0) {
				statements.push(
					...insertStatements(
						'_kora_received_local_ops',
						['id'],
						stagedReceived,
						'INSERT OR IGNORE',
					),
				)
			}
			for (const entry of stagedVector) {
				vectorUpdate.set(entry.node_id, entry.sequence_number)
				statements.push({
					sql: `INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = MAX(sequence_number, excluded.sequence_number)`,
					params: [entry.node_id, entry.sequence_number],
				})
			}
			await run(tx, statements)
			await target.writeProgress(tx)
		})
		chunks += 1
		host.noteVersionVector(vectorUpdate)
		if (newest !== null) host.receiveTimestamp(newest)
		for (const collection of touched) host.invalidate(collection)

		return {
			kind: 'merged',
			operations,
			records,
			contestedRecords,
			replayedOperations,
			quarantined: stagedQuarantine.length,
			chunks,
			durationMs: Date.now() - startedAt,
		}
	} catch (error) {
		// What earlier chunks committed is whole records; the live version vector already
		// follows it. Tell live queries to re-read what may have appeared.
		for (const collection of touched) host.invalidate(collection)
		if (error instanceof Unmergeable) return { kind: 'unmergeable', reason: error.message }
		throw error
	}
}
