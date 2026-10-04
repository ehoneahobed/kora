import { KoraError, migrationStepsToSQL, quoteIdent, validateRecord } from '@korajs/core'
import type { CausalTracker, MigrationStep, Operation, SchemaDefinition } from '@korajs/core'
import {
	CausalScope,
	type WriteEnv,
	type WriteScope,
	withWriteScope,
} from '../mutations/write-context'
import { writeUpdateInTx } from '../mutations/write-ops'
import { deserializeRecord, serializeRecord } from '../serialization/serializer'
import type { MetaRow, RawCollectionRow, StorageAdapter, Transaction } from '../types'

type BackfillStep = Extract<MigrationStep, { type: 'backfill' }>

/** Keys every record carries besides its schema fields. */
const RECORD_KEYS: ReadonlySet<string> = new Set(['id', 'createdAt', 'updatedAt'])

/** Everything the migration runner needs from the store. */
export interface MigrationRunContext {
	readonly adapter: StorageAdapter
	readonly schema: SchemaDefinition
	/** Write environment of the store's current node (clock, node id, secrets). */
	readonly env: Omit<WriteEnv, 'mutationName' | 'transactionId'>
	readonly causalTracker: CausalTracker | null
	/** Called after each version commits, once per operation its backfills wrote. */
	readonly onOperation: (operation: Operation) => void
}

/**
 * Bring the local database from its stored schema version to `schema.version`
 * (STORE-13, NEW-STORE-1).
 *
 * Each version runs in ONE transaction: its structural DDL, its backfills and the
 * `schema_version` write. A failure (a throwing transform, a crash) leaves no partial
 * effect, so a retry never applies a non-idempotent backfill twice.
 *
 * Backfill transforms receive the deserialized record (booleans, arrays, objects as the
 * app reads them). Every changed record is written through the single local write path
 * as an update operation with mutation name `migration:v<N>`, so the backfilled values
 * sync to the server and other devices; a step declared `localOnly` rewrites the rows
 * only. Fields the transform returns unchanged are not written.
 *
 * @returns The operations the backfills wrote, in commit order
 */
export async function runSchemaMigrations(ctx: MigrationRunContext): Promise<Operation[]> {
	const stored = await readStoredSchemaVersion(ctx.adapter)
	const target = ctx.schema.version
	if (stored >= target) {
		if (stored === 0) await writeSchemaVersion(ctx.adapter, target)
		return []
	}

	const written: Operation[] = []
	const migrations = ctx.schema.migrations ?? {}
	for (let version = stored + 1; version <= target; version++) {
		const migration = migrations[version]
		const steps = migration?.steps ?? []
		const committed: Operation[] = []
		const causal = new CausalScope(ctx.causalTracker, false)
		await ctx.adapter.transaction(async (tx) => {
			for (const step of steps) {
				if (step.type === 'renameField') {
					await renameColumn(tx, step.collection, step.from, step.to)
					continue
				}
				for (const sql of migrationStepsToSQL([step])) {
					await executeStructural(tx, sql)
				}
			}
			const backfills = steps.filter((step): step is BackfillStep => step.type === 'backfill')
			if (backfills.length > 0) {
				const env: WriteEnv = { ...ctx.env, mutationName: `migration:v${version}` }
				await withWriteScope(tx, ctx.env.nodeId, causal, async (scope) => {
					for (const step of backfills) {
						committed.push(...(await runBackfill(ctx.schema, env, scope, version, step)))
					}
				})
			}
			await tx.execute(
				"INSERT OR REPLACE INTO _kora_meta (key, value) VALUES ('schema_version', ?)",
				[String(version)],
			)
		})
		causal.publish()
		for (const operation of committed) ctx.onOperation(operation)
		written.push(...committed)
	}
	return written
}

/**
 * Structural DDL, tolerating "duplicate column name": the adapter's open already ran the
 * current schema's DDL, which adds the target schema's columns (`--kora:safe-alter`).
 * Inside a transaction a failed statement rolls back only itself.
 */
async function executeStructural(tx: Transaction, sql: string): Promise<void> {
	try {
		await tx.execute(sql)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (!message.includes('duplicate column name')) throw error
	}
}

/**
 * A `renameField` step. The adapter's open has already run the target schema's DDL, whose
 * `--kora:safe-alter` adds the renamed field's column (empty, or holding its default) and
 * creates the target schema's indexes on it; a plain `RENAME COLUMN` would then fail
 * "duplicate column name" and leave the values in the old column. The pre-added column is
 * dropped first (with the indexes on it, recreated afterwards), so the rename keeps the
 * values and the source column's constraints. Runs inside the version's transaction.
 */
async function renameColumn(
	tx: Transaction,
	collection: string,
	from: string,
	to: string,
): Promise<void> {
	const table = quoteIdent(collection)
	const columns = await tx.query<{ name: string }>(
		`SELECT name FROM pragma_table_info(${sqlText(collection)})`,
	)
	const names = new Set(columns.map((column) => column.name))
	// A database created at (or past) this version: the open's DDL already made `to` and
	// there is no `from` to carry over (a fresh install of a schema whose history has
	// renames). Nothing to rename.
	if (!names.has(from) && names.has(to)) return
	if (names.has(from) && names.has(to)) {
		const indexes = await tx.query<{ name: string; sql: string }>(
			`SELECT m.name AS name, m.sql AS sql FROM sqlite_master m WHERE m.type = 'index' AND m.tbl_name = ${sqlText(collection)} AND m.sql IS NOT NULL AND EXISTS (SELECT 1 FROM pragma_index_info(m.name) i WHERE i.name = ${sqlText(to)})`,
		)
		for (const index of indexes) await tx.execute(`DROP INDEX ${quoteIdent(index.name)}`)
		await tx.execute(`ALTER TABLE ${table} DROP COLUMN ${quoteIdent(to)}`)
		await tx.execute(`ALTER TABLE ${table} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)}`)
		for (const index of indexes) {
			await tx.execute(index.sql.replace(/^CREATE INDEX /i, 'CREATE INDEX IF NOT EXISTS '))
		}
		return
	}
	await executeStructural(
		tx,
		`ALTER TABLE ${table} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)}`,
	)
}

function sqlText(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

async function runBackfill(
	schema: SchemaDefinition,
	env: WriteEnv,
	scope: WriteScope,
	version: number,
	step: BackfillStep,
): Promise<Operation[]> {
	const definition = schema.collections[step.collection]
	if (!definition) {
		throw new KoraError(
			`Migration v${version} backfills unknown collection "${step.collection}".`,
			'MIGRATION_UNKNOWN_COLLECTION',
			{ version, collection: step.collection },
		)
	}
	const rows = await scope.tx.query<RawCollectionRow>(
		`SELECT * FROM ${quoteIdent(step.collection)} WHERE _deleted = 0 ORDER BY id`,
	)
	const operations: Operation[] = []
	for (const row of rows) {
		const record = deserializeRecord(row, definition.fields)
		const updates = step.transform({ ...record })
		if (updates === null || typeof updates !== 'object') continue
		const changes: Record<string, unknown> = {}
		for (const [field, value] of Object.entries(updates)) {
			// `{ ...record, x }` restates the record's own keys: unchanged ones are ignored.
			if (RECORD_KEYS.has(field) && sameValue(record[field], value)) continue
			if (!(field in definition.fields)) {
				throw new KoraError(
					`Migration v${version} backfill of "${step.collection}" returned unknown field "${field}".`,
					'MIGRATION_UNKNOWN_FIELD',
					{ version, collection: step.collection, field, fix: 'Return only schema fields.' },
				)
			}
			if (!sameValue(record[field], value)) changes[field] = value
		}
		if (Object.keys(changes).length === 0) continue

		if (step.localOnly) {
			const serialized = serializeRecord(changes, definition.fields)
			const columns = Object.keys(serialized)
			await scope.tx.execute(
				`UPDATE ${quoteIdent(step.collection)} SET ${columns.map((c) => `${quoteIdent(c)} = ?`).join(', ')} WHERE id = ?`,
				[...columns.map((c) => serialized[c]), row.id],
			)
			continue
		}
		const validated = validateRecord(step.collection, definition, changes, 'update')
		const result = await writeUpdateInTx(env, scope, step.collection, row.id, validated)
		if (result.operation) operations.push(result.operation)
	}
	return operations
}

/** Structural equality for record values (JSON-shaped; bytes compared bytewise). */
function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (a instanceof Uint8Array || b instanceof Uint8Array) {
		if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
			return false
		}
		return a.every((byte, index) => byte === b[index])
	}
	if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
		// A missing value and null are the same stored value.
		return (a ?? null) === (b ?? null)
	}
	if (Array.isArray(a) !== Array.isArray(b)) return false
	const keysA = Object.keys(a)
	const keysB = Object.keys(b)
	if (keysA.length !== keysB.length) return false
	return keysA.every((key) =>
		sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
	)
}

async function readStoredSchemaVersion(adapter: StorageAdapter): Promise<number> {
	const rows = await adapter.query<MetaRow>(
		"SELECT value FROM _kora_meta WHERE key = 'schema_version'",
	)
	return rows[0] ? Number(rows[0].value) : 0
}

async function writeSchemaVersion(adapter: StorageAdapter, version: number): Promise<void> {
	await adapter.execute(
		"INSERT OR REPLACE INTO _kora_meta (key, value) VALUES ('schema_version', ?)",
		[String(version)],
	)
}
