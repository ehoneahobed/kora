import {
	type FoldState,
	FoldStateError,
	type Operation,
	type SchemaDefinition,
	deserializeFoldState,
	mismatchedFoldFields,
	quoteIdent,
} from '@korajs/core'
import { SEQ_CONFLICTS_TABLE } from '../store/sequence-repair'
import { LOCAL_NODES_TABLE } from '../sync/local-sync-records'
import type { Transaction } from '../types'
import { MAX_PARAMS, runTerms } from './query-terms'
import {
	COMPACTED_THROUGH_TABLE,
	FOLD_BASE_TABLE,
	FOLD_SNAPSHOT_TABLE,
	FOLD_STATE_TABLE,
	PROVISIONAL_OPS_TABLE,
} from './record-folder'

/**
 * C3b (docs/design/fast-first-sync.md): what a delivery batch needs to know about the
 * database before it applies its operations, read in a handful of queries instead of
 * about thirteen per operation.
 *
 * A remote operation's apply asks the same questions of the database every time: is the
 * operation already in the log (or compacted away), who holds its sequence number, is the
 * record's fold state stored, does the record have a base, a snapshot, provisional effects
 * or a retraction marker, which row is materialized. Inside a write transaction nothing
 * but the batch itself changes those answers, so they are read once for every operation
 * of the batch (IN lists, under SQLite's variable limit) and then kept up to date in
 * memory by the batch's own writes, so an operation sees the results of the earlier
 * operations of its batch exactly as if it had read them back.
 *
 * Only the common case is answered from memory: a record with a readable fold state, or
 * one that is plainly new, and nothing unusual around it. Anything else (a record with a
 * base, snapshot, provisional effect, retraction marker, retained sequence conflict or
 * unreadable state, a node this database also writes under, a taken sequence number, a
 * record the batch touched by another route) is not eligible, and its operations take the
 * per-operation path, which reads through the transaction as before. The fast path is an
 * optimization of that path, never a different behavior: both produce the same log rows,
 * fold states and rows (tests/prefetch property test).
 */

/** What the batch knows about one record. */
export interface PrefetchedRecord {
	readonly collection: string
	readonly recordId: string
	/** The stored fold state, when one is stored and readable. */
	state: FoldState | null
	/** A state row exists that the current plan cannot read: the record is re-folded. */
	unreadable: boolean
	/** The record has operations in its log (this batch's included). */
	hasLog: boolean
	/** The record has a compacted base state (only a record without a stored state cares). */
	hasBase: boolean
	/** Row snapshot, provisional effect, retained conflict or retraction marker. */
	unusual: boolean
	/** The materialized row, or null when there is none. */
	row: { deleted: boolean } | null
	/** The batch changed the record by a route the cache does not follow. */
	dirty: boolean
}

interface Term {
	sql: string
	params: unknown[]
}

type Row = {
	c: string | null
	k: string
	a: string | null
	b: string | null
	n: unknown
	s: unknown
}

export class RemoteBatchPrefetch {
	private readonly records = new Map<string, PrefetchedRecord>()
	/** `collection \0 id` of operations in a collection's log. */
	private readonly logged = new Set<string>()
	/** Ids of operations retained in the sequence-conflicts table (any collection). */
	private readonly conflictIds = new Set<string>()
	/** `collection \0 node \0 sequence` held in a collection's log. */
	private readonly holders = new Set<string>()
	private readonly compacted = new Map<string, number>()
	private readonly localNodes = new Set<string>()
	private readonly loadedIds = new Set<string>()
	private readonly loadedNodes = new Set<string>()

	constructor(private readonly schema: SchemaDefinition) {}

	/**
	 * Read everything `operations` need, in a few queries. Operations of collections the
	 * schema does not have are left out (they are skipped or quarantined without a read).
	 * Safe to call again with more operations: what was loaded is not read twice.
	 */
	async load(tx: Transaction, operations: readonly Operation[]): Promise<void> {
		const fresh = operations.filter((op) => this.schema.collections[op.collection])
		const newRecords = new Map<string, { collection: string; recordId: string }>()
		const byCollection = new Map<
			string,
			{
				records: Set<string>
				ids: Set<string>
				pairs: Map<string, { node: string; seq: number }>
				rowIds: Set<string>
			}
		>()
		const newIds = new Set<string>()
		const newNodes = new Set<string>()
		for (const op of fresh) {
			const key = recordKey(op.collection, op.recordId)
			const needRecord = !this.records.has(key)
			if (needRecord) newRecords.set(key, { collection: op.collection, recordId: op.recordId })
			const idKey = `${op.collection}\0${op.id}`
			const needId = !this.loadedIds.has(idKey)
			if (!needRecord && !needId) continue
			let group = byCollection.get(op.collection)
			if (!group) {
				group = { records: new Set(), ids: new Set(), pairs: new Map(), rowIds: new Set() }
				byCollection.set(op.collection, group)
			}
			if (needRecord) {
				group.records.add(op.recordId)
				group.rowIds.add(op.recordId)
			}
			if (needId) {
				group.ids.add(op.id)
				group.pairs.set(`${op.nodeId}\0${op.sequenceNumber}`, {
					node: op.nodeId,
					seq: op.sequenceNumber,
				})
				newIds.add(idKey)
				if (!this.loadedNodes.has(op.nodeId)) newNodes.add(op.nodeId)
			}
		}
		if (newRecords.size === 0 && newIds.size === 0) return

		// Per-record tables (the fold's, the retraction markers, retained conflicts).
		const keys = [...newRecords.values()]
		for (const key of keys) {
			this.records.set(recordKey(key.collection, key.recordId), {
				collection: key.collection,
				recordId: key.recordId,
				state: null,
				unreadable: false,
				hasLog: false,
				hasBase: false,
				unusual: false,
				row: null,
				dirty: false,
			})
		}
		const RECORD_CHUNK = Math.floor(MAX_PARAMS / 2)
		for (let start = 0; start < keys.length; start += RECORD_CHUNK) {
			const chunk = keys.slice(start, start + RECORD_CHUNK)
			const values = chunk.map(() => '(?, ?)').join(', ')
			const join = (table: string, alias: string, extra = ''): string =>
				`FROM ${table} ${alias} JOIN k ON ${alias}.collection = k.c AND ${alias}.record_id = k.r${extra}`
			const rows = await tx.query<Row>(
				`WITH k(c, r) AS (VALUES ${values})
SELECT f.collection AS c, 'state' AS k, f.state AS a, NULL AS b, NULL AS n, f.record_id AS s ${join(FOLD_STATE_TABLE, 'f')}
UNION ALL SELECT x.collection, 'base', NULL, NULL, NULL, x.record_id ${join(FOLD_BASE_TABLE, 'x')}
UNION ALL SELECT x.collection, 'snapshot', NULL, NULL, NULL, x.record_id ${join(FOLD_SNAPSHOT_TABLE, 'x')}
UNION ALL SELECT x.collection, 'provisional', NULL, NULL, NULL, x.record_id ${join(PROVISIONAL_OPS_TABLE, 'x')}
UNION ALL SELECT x.collection, 'marker', NULL, NULL, NULL, x.record_id ${join('_kora_scope_retractions', 'x')}
UNION ALL SELECT x.collection, 'retained', x.id, NULL, NULL, x.record_id ${join(SEQ_CONFLICTS_TABLE, 'x', ' WHERE x.reemitted_as IS NULL')}`,
				chunk.flatMap((key) => [key.collection, key.recordId]),
			)
			for (const row of rows) {
				const record = this.records.get(recordKey(String(row.c), String(row.s)))
				if (!record) continue
				if (row.k === 'state') this.readState(record, String(row.a))
				else if (row.k === 'base') record.hasBase = true
				else record.unusual = true
				if (row.k === 'retained' && row.a !== null) this.conflictIds.add(row.a)
			}
		}

		// Per-collection tables: the log (by record, by id, by sequence) and the rows.
		const terms: Term[] = []
		for (const [collection, group] of byCollection) {
			const log = quoteIdent(`_kora_ops_${collection}`)
			for (const chunk of chunked([...group.records], MAX_PARAMS - 2)) {
				terms.push({
					sql: `SELECT ? AS c, 'r' AS k, NULL AS a, record_id AS b, NULL AS n, COUNT(*) AS s FROM ${log} WHERE record_id IN (${marks(chunk.length)}) GROUP BY record_id`,
					params: [collection, ...chunk],
				})
			}
			for (const chunk of chunked([...group.ids], MAX_PARAMS - 2)) {
				terms.push({
					sql: `SELECT ? AS c, 'i' AS k, id AS a, record_id AS b, node_id AS n, sequence_number AS s FROM ${log} WHERE id IN (${marks(chunk.length)})`,
					params: [collection, ...chunk],
				})
			}
			for (const chunk of chunked([...group.pairs.values()], Math.floor((MAX_PARAMS - 2) / 2))) {
				terms.push({
					sql: `SELECT ? AS c, 's' AS k, id AS a, record_id AS b, node_id AS n, sequence_number AS s FROM ${log} WHERE (node_id, sequence_number) IN (VALUES ${chunk
						.map(() => '(?, ?)')
						.join(', ')})`,
					params: [collection, ...chunk.flatMap((pair) => [pair.node, pair.seq])],
				})
			}
			for (const chunk of chunked([...group.rowIds], MAX_PARAMS - 2)) {
				terms.push({
					sql: `SELECT ? AS c, 'w' AS k, id AS a, NULL AS b, NULL AS n, _deleted AS s FROM ${quoteIdent(collection)} WHERE id IN (${marks(chunk.length)})`,
					params: [collection, ...chunk],
				})
			}
		}
		// Node-level tables and retained conflicts by id.
		const nodes = [...newNodes]
		for (const chunk of chunked(nodes, Math.floor((MAX_PARAMS - 2) / 2))) {
			terms.push({
				sql: `SELECT NULL AS c, 'compacted' AS k, node_id AS a, NULL AS b, NULL AS n, sequence_number AS s FROM ${COMPACTED_THROUGH_TABLE} WHERE node_id IN (${marks(chunk.length)})`,
				params: [...chunk],
			})
			terms.push({
				sql: `SELECT NULL AS c, 'local' AS k, node_id AS a, NULL AS b, NULL AS n, NULL AS s FROM ${LOCAL_NODES_TABLE} WHERE node_id IN (${marks(chunk.length)})`,
				params: [...chunk],
			})
		}
		const ids = [...new Set([...byCollection.values()].flatMap((group) => [...group.ids]))]
		for (const chunk of chunked(ids, MAX_PARAMS - 2)) {
			terms.push({
				sql: `SELECT NULL AS c, 'conflictid' AS k, id AS a, NULL AS b, NULL AS n, NULL AS s FROM ${SEQ_CONFLICTS_TABLE} WHERE reemitted_as IS NULL AND id IN (${marks(chunk.length)})`,
				params: [...chunk],
			})
		}
		for (const rows of await runTerms(tx, terms)) {
			for (const row of rows) this.absorb(row as Row)
		}
		for (const idKey of newIds) this.loadedIds.add(idKey)
		for (const node of newNodes) this.loadedNodes.add(node)
	}

	/** The record's knowledge when its operations can be applied from memory, else null. */
	eligible(collection: string, recordId: string): PrefetchedRecord | null {
		const record = this.records.get(recordKey(collection, recordId))
		if (!record || record.dirty || record.unusual || record.unreadable) return null
		// No stored state: only a record with no history at all is plainly new.
		if (record.state === null && (record.hasLog || record.hasBase)) return null
		return record
	}

	/** Whether `op` is already in the log, retained as a sequence conflict, or compacted away. */
	isDuplicate(op: Operation): boolean {
		if (this.logged.has(`${op.collection}\0${op.id}`) || this.conflictIds.has(op.id)) return true
		const through = this.compacted.get(op.nodeId)
		return through !== undefined && op.sequenceNumber <= through
	}

	/**
	 * Whether `op`'s append needs the careful path: its node is also one of this database's
	 * (a beta.12 shared node: the append records it as received), or another operation of
	 * its node holds its sequence number (the append keeps it in the conflicts table).
	 */
	needsCarefulAppend(op: Operation): boolean {
		return (
			this.localNodes.has(op.nodeId) ||
			this.holders.has(`${op.collection}\0${op.nodeId}\0${op.sequenceNumber}`)
		)
	}

	/** Follow a committed-in-transaction fast apply: the operation is in the log now. */
	noteApplied(
		op: Operation,
		record: PrefetchedRecord,
		result: { saved: FoldState | null; row: { deleted: boolean } | null; refolded: boolean },
	): void {
		this.logged.add(`${op.collection}\0${op.id}`)
		this.holders.add(`${op.collection}\0${op.nodeId}\0${op.sequenceNumber}`)
		record.hasLog = true
		if (result.refolded) {
			record.dirty = true
			return
		}
		if (result.saved !== null) record.state = result.saved
		record.row = result.row
	}

	/**
	 * The record was (or may have been) changed by something the cache does not follow: a
	 * per-operation apply, a retraction, a provisional side effect. Its operations read the
	 * transaction from now on.
	 */
	markDirty(collection: string, recordId: string): void {
		const record = this.records.get(recordKey(collection, recordId))
		if (record) record.dirty = true
	}

	private readState(record: PrefetchedRecord, raw: string): void {
		try {
			const state = deserializeFoldState(raw)
			// A plan the schema has since changed re-folds the record (RT-63).
			if (mismatchedFoldFields(state, this.schema).length > 0) record.unreadable = true
			else record.state = state
		} catch (error) {
			if (!(error instanceof FoldStateError)) throw error
			record.unreadable = true
		}
	}

	private absorb(row: Row): void {
		switch (row.k) {
			case 'r': {
				// Only whether the record has a history matters here; its operations' ids and
				// sequence numbers are asked for by the batch's own operations ('i', 's').
				const record = this.records.get(recordKey(String(row.c), String(row.b)))
				if (record) record.hasLog = true
				break
			}
			case 'i':
			case 's':
				this.logged.add(`${row.c}\0${row.a}`)
				this.holders.add(`${row.c}\0${row.n}\0${row.s}`)
				break
			case 'w': {
				const record = this.records.get(recordKey(String(row.c), String(row.a)))
				if (record) record.row = { deleted: Number(row.s) === 1 }
				break
			}
			case 'compacted':
				this.compacted.set(String(row.a), Number(row.s))
				break
			case 'local':
				this.localNodes.add(String(row.a))
				break
			case 'conflictid':
				this.conflictIds.add(String(row.a))
				break
		}
	}
}

function recordKey(collection: string, recordId: string): string {
	return `${collection}\0${recordId}`
}

function marks(count: number): string {
	return new Array<string>(count).fill('?').join(', ')
}

function chunked<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = []
	for (let start = 0; start < items.length; start += size)
		out.push(items.slice(start, start + size))
	return out
}
