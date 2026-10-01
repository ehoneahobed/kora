import {
	type AtomicOp,
	type SchemaDefinition,
	defineSchema,
	quoteIdent,
	replayOperationsForRecord,
	t,
} from '@korajs/core'
import type postgres from 'postgres'
import { serializeFieldValue } from '../../src/store/materialization'

/**
 * Shared LMS-shaped fixture for the LMS-10 / LMS-11 Postgres benchmarks: 27 collections,
 * a skewed op distribution (progress/attempts/answers/audit dominate), 20 schools, ~60%
 * inserts / ~35% partial updates (which do NOT restate schoolId) / ~5% deletes, and ~1%
 * of updates that move a record to another school (exercise scope exit).
 */
export const COLLECTIONS = [
	'users',
	'schools',
	'classes',
	'courses',
	'modules',
	'lessons',
	'lesson_progress',
	'quizzes',
	'questions',
	'answers',
	'attempts',
	'assignments',
	'submissions',
	'grades',
	'enrollments',
	'attendance',
	'announcements',
	'comments',
	'messages',
	'notifications',
	'files',
	'rubrics',
	'badges',
	'certificates',
	'calendars',
	'events',
	'audit_logs',
] as const

// Relative weight of each collection in the op log.
const HEAVY = new Set(['lesson_progress', 'answers', 'attempts', 'audit_logs', 'attendance'])

export const lmsSchema: SchemaDefinition = defineSchema({
	version: 1,
	collections: Object.fromEntries(
		COLLECTIONS.map((c) => [
			c,
			{
				fields: {
					schoolId: t.string(),
					ownerId: t.string(),
					title: t.string(),
					body: t.string(),
					status: t.string(),
					score: t.number(),
					position: t.number(),
					createdBy: t.string(),
				},
			},
		]),
	),
}) as SchemaDefinition

export interface OpRow {
	id: string
	node_id: string
	type: string
	collection: string
	record_id: string
	data: string | null
	previous_data: string | null
	atomic_ops: null
	wall_time: number
	logical: number
	timestamp_node_id: string
	sequence_number: number
	causal_deps: string
	schema_version: number
	received_at: number
	delivery_seq: number
	/** schoolId of the record at write time (for the denormalized-scope variant; not a Kora column). */
	scope_key: string
}

/** Deterministic PRNG so runs are comparable. */
function rng(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0
		return s / 2 ** 32
	}
}

export function generateOps(totalOps: number, seed = 42): OpRow[] {
	const r = rng(seed)
	const weights = COLLECTIONS.map((c) => (HEAVY.has(c) ? 10 : 1))
	const wsum = weights.reduce((a, b) => a + b, 0)
	const pick = (): string => {
		let x = r() * wsum
		for (let i = 0; i < COLLECTIONS.length; i++) {
			x -= weights[i] as number
			if (x <= 0) return COLLECTIONS[i] as string
		}
		return COLLECTIONS[0] as string
	}
	const live: Record<string, Array<{ id: string; school: string }>> = {}
	const nodeSeq = new Map<string, number>()
	const rows: OpRow[] = []
	let wall = 1_700_000_000_000
	let recordCounter = 0
	while (rows.length < totalOps) {
		const collection = pick()
		const node = `device-${Math.floor(r() * 200)}`
		const sn = (nodeSeq.get(node) ?? 0) + 1
		nodeSeq.set(node, sn)
		wall += 1 + Math.floor(r() * 3)
		const pool = live[collection] ?? []
		live[collection] = pool
		const roll = r()
		let type: 'insert' | 'update' | 'delete'
		let recordId: string
		let data: Record<string, unknown> | null
		let previous: Record<string, unknown> | null = null
		let scopeKey = ''
		if (pool.length === 0 || roll < 0.6) {
			type = 'insert'
			recordCounter += 1
			recordId = `${collection}-${recordCounter}`
			const school = `school-${Math.floor(r() * 20)}`
			pool.push({ id: recordId, school })
			scopeKey = school
			data = {
				schoolId: school,
				ownerId: `user-${Math.floor(r() * 5000)}`,
				title: `Title ${recordCounter} lorem ipsum`,
				body: 'x'.repeat(80 + Math.floor(r() * 200)),
				status: 'active',
				score: Math.floor(r() * 100),
				position: recordCounter,
				createdBy: node,
			}
		} else if (roll < 0.95) {
			type = 'update'
			const target = pool[Math.floor(r() * pool.length)] as { id: string; school: string }
			recordId = target.id
			scopeKey = target.school
			if (r() < 0.01) {
				const to = `school-${Math.floor(r() * 20)}`
				previous = { schoolId: target.school }
				data = { schoolId: to }
				target.school = to
				scopeKey = to
			} else {
				data = { score: Math.floor(r() * 100), status: r() < 0.5 ? 'active' : 'done' }
				previous = { score: 0, status: 'active' }
			}
		} else {
			type = 'delete'
			const idx = Math.floor(r() * pool.length)
			const target = pool[idx] as { id: string; school: string }
			pool.splice(idx, 1)
			recordId = target.id
			scopeKey = target.school
			data = null
		}
		rows.push({
			id: `op-${seed}-${rows.length}`,
			node_id: node,
			type,
			collection,
			record_id: recordId,
			data: data === null ? null : JSON.stringify(data),
			previous_data: previous === null ? null : JSON.stringify(previous),
			atomic_ops: null,
			wall_time: wall,
			logical: 0,
			timestamp_node_id: node,
			sequence_number: sn,
			causal_deps: '[]',
			schema_version: 1,
			received_at: wall,
			delivery_seq: rows.length + 1,
			scope_key: scopeKey,
		})
	}
	return rows
}

/** Bulk-load op rows straight into the operations table (bypasses apply). */
export async function bulkLoadOps(
	sql: postgres.Sql,
	rows: OpRow[],
	withScopeKey = false,
): Promise<void> {
	for (let i = 0; i < rows.length; i += 2000) {
		const chunk = rows
			.slice(i, i + 2000)
			.map(({ scope_key, ...rest }) => (withScopeKey ? { ...rest, scope_key } : rest))
		await sql`INSERT INTO operations ${sql(chunk as unknown as Record<string, unknown>[])}`
	}
	const max = rows.length
	await sql`UPDATE delivery_counter SET value = ${max} WHERE id = 1`
	const maxByNode = new Map<string, number>()
	for (const row of rows) {
		maxByNode.set(row.node_id, Math.max(maxByNode.get(row.node_id) ?? 0, row.sequence_number))
	}
	const ss = [...maxByNode].map(([node_id, max_sequence_number]) => ({
		node_id,
		max_sequence_number,
		last_seen_at: 0,
	}))
	await sql`INSERT INTO sync_state ${sql(ss)} ON CONFLICT DO NOTHING`
}

/**
 * The report's proposal, re-implemented faithfully: per-collection transaction, 4
 * collections concurrently, multi-row INSERT ... ON CONFLICT in batches of 500.
 */
export async function proposedBackfill(
	sql: postgres.Sql,
	schema: SchemaDefinition,
	opts: { concurrency: number; batch: number },
): Promise<void> {
	const names = Object.keys(schema.collections)
	let next = 0
	const worker = async (): Promise<void> => {
		while (next < names.length) {
			const c = names[next++] as string
			const def = schema.collections[c] as SchemaDefinition['collections'][string]
			const fields = Object.keys(def.fields)
			await sql.begin(async (txn) => {
				// postgres.js' TransactionSql type loses the call signature under Omit<>.
				const tx = txn as unknown as postgres.Sql
				interface Row {
					record_id: string
					type: string
					data: string | null
					atomic_ops: string | null
					wall_time: string | number
				}
				const ops = (await tx`
					SELECT record_id, type, data, atomic_ops, wall_time FROM operations
					WHERE collection = ${c} ORDER BY wall_time, logical, timestamp_node_id`) as unknown as Row[]
				const grouped = new Map<string, Row[]>()
				for (const op of ops) {
					const g = grouped.get(op.record_id)
					if (g) g.push(op)
					else grouped.set(op.record_id, [op])
				}
				const live: unknown[][] = []
				const dead: unknown[][] = []
				for (const [id, rops] of grouped) {
					const rec = replayOperationsForRecord(
						rops.map((o) => ({
							type: o.type,
							data: o.data !== null ? JSON.parse(o.data) : null,
							atomicOps:
								o.atomic_ops != null
									? (JSON.parse(o.atomic_ops) as Record<string, AtomicOp>)
									: null,
						})),
					)
					if (rec) {
						live.push([
							id,
							...fields.map((f) => serializeFieldValue(rec[f] ?? null, def.fields[f] as never)),
							Number(rops[0]?.wall_time),
							Number(rops[rops.length - 1]?.wall_time),
							0,
						])
					} else {
						dead.push([id, 1, Date.now(), Date.now()])
					}
				}
				const cols = ['id', ...fields, '_created_at', '_updated_at', '_deleted']
				const set = cols
					.slice(1)
					.map((col) => `${quoteIdent(col)} = excluded.${quoteIdent(col)}`)
					.join(', ')
				for (let i = 0; i < live.length; i += opts.batch) {
					const rows = live.slice(i, i + opts.batch)
					const params: unknown[] = []
					const tuples = rows.map((row) => {
						const ph = row.map((v) => {
							params.push(v)
							return `$${params.length}`
						})
						return `(${ph.join(', ')})`
					})
					await tx.unsafe(
						`INSERT INTO ${quoteIdent(c)} (${cols.map(quoteIdent).join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT (id) DO UPDATE SET ${set}`,
						params as never[],
					)
				}
				for (let i = 0; i < dead.length; i += opts.batch) {
					const rows = dead.slice(i, i + opts.batch)
					const params: unknown[] = []
					const tuples = rows.map((row) => {
						const ph = row.map((v) => {
							params.push(v)
							return `$${params.length}`
						})
						return `(${ph.join(', ')})`
					})
					await tx.unsafe(
						`INSERT INTO ${quoteIdent(c)} (id, _deleted, _created_at, _updated_at) VALUES ${tuples.join(', ')} ON CONFLICT (id) DO UPDATE SET _deleted = 1, _updated_at = excluded._updated_at`,
						params as never[],
					)
				}
			})
		}
	}
	await Promise.all(Array.from({ length: opts.concurrency }, worker))
}
