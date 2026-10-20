import { type MigrationManifest, listMigrationManifests } from '../../migrate/migrate-command'
import { parseEvolveTableDirective } from '../../migrate/table-evolution-directive'
import type { DoctorCheckResult } from '../doctor-checks'
import type { DoctorDatabase } from './database'

/** Result of {@link checkPendingMigrations}. */
export interface PendingMigrationReport {
	result: DoctorCheckResult
	/** Generated migrations this database has no record of. */
	unapplied: number
}

/**
 * Compare the app's generated migrations (`kora/migrations`) with the ones recorded in
 * this database (`_kora_migrations`, written by `kora migrate --apply`).
 *
 * Most of what a migration does the sync server also does on its own at start (a new
 * collection's table, an added column, a relaxed enum check), so an unrecorded migration
 * is only reported when it holds a step the server never does: a field whose kind changed
 * (the column keeps its old type and its values are not converted). A removed field is
 * harmless (the column stays, unused). Reading the manifests is local; the database is
 * only read.
 */
export async function checkPendingMigrations(
	db: DoctorDatabase,
	tables: ReadonlySet<string>,
	migrationsDir: string,
): Promise<PendingMigrationReport> {
	const id = 'db-pending-migrations'
	const title = 'Pending migrations'
	let manifests: MigrationManifest[]
	try {
		manifests = await listMigrationManifests(migrationsDir)
	} catch (error) {
		return {
			unapplied: 0,
			result: {
				id,
				title,
				status: 'warn',
				message: `Could not read the generated migrations in ${migrationsDir}: ${error instanceof Error ? error.message : String(error)}`,
				fix: 'Regenerate them with `kora migrate`.',
			},
		}
	}
	if (manifests.length === 0) {
		return {
			unapplied: 0,
			result: {
				id,
				title,
				status: 'pass',
				message: `No generated migrations in ${migrationsDir}.`,
			},
		}
	}
	const recorded = new Set<string>()
	if (tables.has('_kora_migrations')) {
		for (const row of await db.all('SELECT id FROM _kora_migrations')) recorded.add(String(row.id))
	}
	const unapplied = manifests.filter((manifest) => !recorded.has(manifest.id))
	if (unapplied.length === 0) {
		return {
			unapplied: 0,
			result: {
				id,
				title,
				status: 'pass',
				message: `All ${manifests.length} generated migration(s) are recorded as applied.`,
			},
		}
	}
	const kindChanges: string[] = []
	for (const manifest of unapplied) {
		for (const statement of manifest.up) {
			const target = parseEvolveTableDirective(statement)
			if (!target) continue
			for (const [field, change] of Object.entries(target.change)) {
				kindChanges.push(
					`${manifest.id}: ${target.table}.${field} ${change.from.kind} -> ${change.to.kind}`,
				)
			}
		}
	}
	const names = unapplied.map((manifest) => manifest.id).join(', ')
	if (kindChanges.length > 0) {
		return {
			unapplied: unapplied.length,
			result: {
				id,
				title,
				status: 'warn',
				message: `${unapplied.length} migration(s) are not recorded in this database (${names}), and they change field kinds the server does not convert on start: ${kindChanges.join('; ')}.`,
				fix: 'Run `kora migrate --apply` against this database before deploying (with the server stopped for SQLite).',
			},
		}
	}
	return {
		unapplied: unapplied.length,
		result: {
			id,
			title,
			status: 'pass',
			message: `${unapplied.length} migration(s) are not recorded in this database (${names}); the server makes their changes itself on start (new tables and columns, relaxed enum checks), so nothing is needed.`,
		},
	}
}
