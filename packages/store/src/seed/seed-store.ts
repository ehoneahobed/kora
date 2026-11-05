import { createSnapshotState } from '@korajs/core'
import type { FieldDescriptor, HLCTimestamp, SchemaDefinition } from '@korajs/core'
import { quoteIdent } from '@korajs/core'
import {
	FOLD_BASE_TABLE,
	FOLD_SNAPSHOT_TABLE,
	FOLD_STATE_TABLE,
	PROVISIONAL_OPS_TABLE,
	type RecordFolder,
} from '../fold/record-folder'
import type { Transaction } from '../types'

/**
 * Seeds (first-visit parity S4b, `docs/design/first-visit-parity.md` 5.6): records a read-through
 * answer showed, kept so the device can answer the same queries from its own database before
 * replication has delivered them.
 *
 * A seed is a row snapshot (RT-68) marked in `_kora_seed` with the server frontier it was read at.
 * It is no operation: it has no log entry, no sequence number and is never uploaded. The merge
 * of the staging replica deletes every seed (5.7.4), so the replica that results is exactly
 * what replication alone would have produced.
 */

/** Local-only table marking which row snapshots are seeds. */
export const SEED_TABLE = '_kora_seed'

/** DDL of {@link SEED_TABLE}. Idempotent. */
export const SEED_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${SEED_TABLE} (collection TEXT NOT NULL, record_id TEXT NOT NULL, frontier INTEGER NOT NULL, grant_key TEXT NOT NULL, PRIMARY KEY (collection, record_id))`

/** One record to seed: a read-through answer's record in the delivery wire form. */
export interface SeedInput {
	collection: string
	id: string
	/** The schema fields, as a scope entry carries them (binary as `{ $koraBytes }`). */
	values: Record<string, unknown>
	/** The HLC of the write that produced each field's current value. */
	fieldVersions: Record<string, HLCTimestamp>
	created: HLCTimestamp
	latest: HLCTimestamp
}

/** What the answer was read at. */
export interface SeedMeta {
	/** The server's delivery counter after the rows were read. */
	frontier: number
	/** Hash of the grant the rows were read under. */
	grantKey: string
}

/** Why a record was not seeded. Nothing is dropped silently: each skip is reported. */
export type SeedSkipReason =
	/** The collection is not in the schema. */
	| 'unknown-collection'
	/** The record has history here (operations, fold state, an ordinary snapshot): the store is authoritative. */
	| 'has-history'
	/** An array holds repeated values: a snapshot cannot say which copy a later local edit removes. */
	| 'array-duplicates'
	/** The clock refused the record's timestamp (invalid, or too far ahead). */
	| 'clock-refused'
	/** The record already has a seed read at the same or a later frontier. */
	| 'not-newer'
	/** This database does not fold records (a legacy-materialized database): it cannot hold seeds. */
	| 'fold-inactive'

/** The result of seeding. */
export interface SeedOutcome {
	seeded: Array<{ collection: string; id: string }>
	skipped: Array<{ collection: string; id: string; reason: SeedSkipReason }>
}

/** A seed marker. */
export interface SeedRow {
	collection: string
	recordId: string
	frontier: number
	grantKey: string
}

/**
 * Seed records inside `tx`.
 *
 * @param tx - The write transaction
 * @param folder - The store's record folder
 * @param schema - The schema
 * @param inputs - Records of an answer
 * @param meta - The frontier and grant the answer was read at
 * @param receive - Advances the clock past a record's newest timestamp; false when it is refused
 */
export async function seedRecordsInTx(
	tx: Transaction,
	folder: RecordFolder,
	schema: SchemaDefinition,
	inputs: readonly SeedInput[],
	meta: SeedMeta,
	receive: (timestamp: HLCTimestamp) => boolean,
): Promise<SeedOutcome> {
	const outcome: SeedOutcome = { seeded: [], skipped: [] }
	for (const input of inputs) {
		const skip = (reason: SeedSkipReason): void => {
			outcome.skipped.push({ collection: input.collection, id: input.id, reason })
		}
		const definition = schema.collections[input.collection]
		if (definition === undefined) {
			skip('unknown-collection')
			continue
		}
		if (hasRepeatedArrayValue(input.values, definition.fields)) {
			skip('array-duplicates')
			continue
		}
		const existing = await tx.query<{ frontier: number }>(
			`SELECT frontier FROM ${SEED_TABLE} WHERE collection = ? AND record_id = ?`,
			[input.collection, input.id],
		)
		const previous = existing[0]
		if (previous !== undefined) {
			if (meta.frontier <= previous.frontier) {
				skip('not-newer')
				continue
			}
		} else if (await hasHistory(tx, input.collection, input.id)) {
			skip('has-history')
			continue
		}
		if (!receive(input.latest)) {
			skip('clock-refused')
			continue
		}
		const snapshot = createSnapshotState(
			{
				collection: input.collection,
				recordId: input.id,
				values: input.values,
				fieldVersions: input.fieldVersions,
				created: input.created,
				latest: input.latest,
				deleted: false,
			},
			schema,
		)
		// A newer answer replaces the older snapshot: joining the two could not remove an element
		// the newer answer no longer shows.
		await tx.execute(`DELETE FROM ${FOLD_SNAPSHOT_TABLE} WHERE collection = ? AND record_id = ?`, [
			input.collection,
			input.id,
		])
		await folder.saveSnapshot(tx, snapshot)
		await tx.execute(
			`INSERT OR REPLACE INTO ${SEED_TABLE} (collection, record_id, frontier, grant_key) VALUES (?, ?, ?, ?)`,
			[input.collection, input.id, meta.frontier, meta.grantKey],
		)
		await folder.refoldInTx(tx, input.collection, input.id)
		outcome.seeded.push({ collection: input.collection, id: input.id })
	}
	return outcome
}

/** What {@link purgeSeedsInTx} did. */
export interface PurgeOutcome {
	/** Seeds whose record was removed: the device had never written to it. */
	removed: SeedRow[]
	/**
	 * Seeds the device has written to. The seed marker is gone but the snapshot stays as an
	 * ordinary row snapshot (RT-68), because without it the record would have no insert and
	 * the user's own edit would disappear. The caller settles it once the record's real history
	 * arrives (the merge replays the staged operations), or keeps it and reports it orphaned
	 * (`read:seed-orphaned`) when none does.
	 */
	retained: SeedRow[]
}

/**
 * Delete seeds inside `tx` (every seed, or those of `only`).
 *
 * @returns Which seeds were removed with their record and which were retained for local writes
 */
export async function purgeSeedsInTx(
	tx: Transaction,
	only?: ReadonlyArray<{ collection: string; recordId: string }>,
	options: { writtenSeeds?: 'keep-snapshot' | 'leave' } = {},
): Promise<PurgeOutcome> {
	const all = await listSeedsInTx(tx)
	const wanted =
		only === undefined ? null : new Set(only.map((r) => `${r.collection}\u0000${r.recordId}`))
	const outcome: PurgeOutcome = { removed: [], retained: [] }
	for (const seed of all) {
		if (wanted !== null && !wanted.has(`${seed.collection}\u0000${seed.recordId}`)) continue
		const ops = await tx.query<{ n: number }>(
			`SELECT COUNT(*) AS n FROM ${quoteIdent(`_kora_ops_${seed.collection}`)} WHERE record_id = ?`,
			[seed.recordId],
		)
		// `leave`: a seed the device wrote to stays exactly as it is (its marker too).
		if ((ops[0]?.n ?? 0) > 0 && options.writtenSeeds === 'leave') continue
		await tx.execute(`DELETE FROM ${SEED_TABLE} WHERE collection = ? AND record_id = ?`, [
			seed.collection,
			seed.recordId,
		])
		if ((ops[0]?.n ?? 0) > 0) {
			outcome.retained.push(seed)
			continue
		}
		await tx.execute(`DELETE FROM ${FOLD_SNAPSHOT_TABLE} WHERE collection = ? AND record_id = ?`, [
			seed.collection,
			seed.recordId,
		])
		await tx.execute(`DELETE FROM ${FOLD_STATE_TABLE} WHERE collection = ? AND record_id = ?`, [
			seed.collection,
			seed.recordId,
		])
		await tx.execute(`DELETE FROM ${quoteIdent(seed.collection)} WHERE id = ?`, [seed.recordId])
		outcome.removed.push(seed)
	}
	return outcome
}

/** Every seed marker. */
export async function listSeedsInTx(tx: Transaction): Promise<SeedRow[]> {
	const rows = await tx.query<{
		collection: string
		record_id: string
		frontier: number
		grant_key: string
	}>(
		`SELECT collection, record_id, frontier, grant_key FROM ${SEED_TABLE} ORDER BY collection, record_id`,
	)
	return rows.map((row) => ({
		collection: row.collection,
		recordId: row.record_id,
		frontier: row.frontier,
		grantKey: row.grant_key,
	}))
}

/** True when the database holds anything of the record that is not a seed. */
async function hasHistory(tx: Transaction, collection: string, id: string): Promise<boolean> {
	const found = await tx.query<{ n: number }>(
		`SELECT (SELECT COUNT(*) FROM ${quoteIdent(`_kora_ops_${collection}`)} WHERE record_id = ?)
     + (SELECT COUNT(*) FROM ${FOLD_STATE_TABLE} WHERE collection = ? AND record_id = ?)
     + (SELECT COUNT(*) FROM ${FOLD_BASE_TABLE} WHERE collection = ? AND record_id = ?)
     + (SELECT COUNT(*) FROM ${FOLD_SNAPSHOT_TABLE} WHERE collection = ? AND record_id = ?)
     + (SELECT COUNT(*) FROM ${PROVISIONAL_OPS_TABLE} WHERE collection = ? AND record_id = ?)
     + (SELECT COUNT(*) FROM _kora_scope_retractions WHERE collection = ? AND record_id = ?)
     + (SELECT COUNT(*) FROM ${quoteIdent(collection)} WHERE id = ?) AS n`,
		[id, collection, id, collection, id, collection, id, collection, id, collection, id, id],
	)
	return (found[0]?.n ?? 0) > 0
}

function hasRepeatedArrayValue(
	values: Record<string, unknown>,
	fields: Record<string, FieldDescriptor>,
): boolean {
	for (const [name, descriptor] of Object.entries(fields)) {
		if (descriptor.kind !== 'array') continue
		const value = values[name]
		if (!Array.isArray(value)) continue
		const seen = new Set<string>()
		for (const element of value) {
			const key = JSON.stringify(element)
			if (seen.has(key)) return true
			seen.add(key)
		}
	}
	return false
}
