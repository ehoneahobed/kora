import type { Operation, VersionVector } from '@kora/core'
import { generateUUIDv7 } from '@kora/core'
import type { ApplyResult } from '@kora/sync'
import type { ServerStore } from './server-store'

interface PostgresClient {
	unsafe<T = unknown[]>(query: string, params?: unknown[]): Promise<T>
	end?: () => Promise<void> | void
}

interface OperationRow {
	id: string
	node_id: string
	type: string
	collection: string
	record_id: string
	data: string | null
	previous_data: string | null
	wall_time: number
	logical: number
	timestamp_node_id: string
	sequence_number: number
	causal_deps: string
	schema_version: number
}

/**
 * PostgreSQL-backed server store.
 */
export class PostgresServerStore implements ServerStore {
	private readonly nodeId: string
	private readonly client: PostgresClient
	private readonly versionVector: VersionVector = new Map()
	private readonly ready: Promise<void>
	private closed = false

	constructor(client: PostgresClient, nodeId?: string) {
		this.client = client
		this.nodeId = nodeId ?? generateUUIDv7()
		this.ready = this.initialize()
	}

	getVersionVector(): VersionVector {
		this.assertOpen()
		return new Map(this.versionVector)
	}

	getNodeId(): string {
		return this.nodeId
	}

	async applyRemoteOperation(op: Operation): Promise<ApplyResult> {
		this.assertOpen()
		await this.ready

		const existing = await this.client.unsafe<{ id: string }[]>(
			'SELECT id FROM operations WHERE id = $1 LIMIT 1',
			[op.id],
		)
		if (existing.length > 0) {
			return 'duplicate'
		}

		const now = Date.now()
		const row = this.serializeOperation(op)

		await this.client.unsafe('BEGIN')
		try {
			await this.client.unsafe(
				`INSERT INTO operations (
					id, node_id, type, collection, record_id, data, previous_data,
					wall_time, logical, timestamp_node_id, sequence_number,
					causal_deps, schema_version, received_at
				) VALUES (
					$1, $2, $3, $4, $5, $6, $7,
					$8, $9, $10, $11,
					$12, $13, $14
				)`,
				[
					row.id,
					row.nodeId,
					row.type,
					row.collection,
					row.recordId,
					row.data,
					row.previousData,
					row.wallTime,
					row.logical,
					row.timestampNodeId,
					row.sequenceNumber,
					row.causalDeps,
					row.schemaVersion,
					now,
				],
			)

			await this.client.unsafe(
				`INSERT INTO sync_state (node_id, max_sequence_number, last_seen_at)
				 VALUES ($1, $2, $3)
				 ON CONFLICT (node_id)
				 DO UPDATE SET
					max_sequence_number = GREATEST(sync_state.max_sequence_number, EXCLUDED.max_sequence_number),
					last_seen_at = EXCLUDED.last_seen_at`,
				[op.nodeId, op.sequenceNumber, now],
			)

			await this.client.unsafe('COMMIT')
		} catch (error) {
			await this.client.unsafe('ROLLBACK')
			throw error
		}

		const currentMax = this.versionVector.get(op.nodeId) ?? 0
		if (op.sequenceNumber > currentMax) {
			this.versionVector.set(op.nodeId, op.sequenceNumber)
		}

		return 'applied'
	}

	async getOperationRange(nodeId: string, fromSeq: number, toSeq: number): Promise<Operation[]> {
		this.assertOpen()
		await this.ready

		const rows = await this.client.unsafe<OperationRow[]>(
			`SELECT
				id,
				node_id,
				type,
				collection,
				record_id,
				data,
				previous_data,
				wall_time,
				logical,
				timestamp_node_id,
				sequence_number,
				causal_deps,
				schema_version
			 FROM operations
			 WHERE node_id = $1 AND sequence_number BETWEEN $2 AND $3
			 ORDER BY sequence_number ASC`,
			[nodeId, fromSeq, toSeq],
		)

		return rows.map((row) => this.deserializeOperation(row))
	}

	async getOperationCount(): Promise<number> {
		this.assertOpen()
		await this.ready

		const rows = await this.client.unsafe<{ count: number | string }[]>(
			'SELECT COUNT(*)::int AS count FROM operations',
		)
		const value = rows[0]?.count ?? 0
		return typeof value === 'string' ? Number(value) : value
	}

	async close(): Promise<void> {
		this.closed = true
		if (this.client.end) {
			await this.client.end()
		}
	}

	private async initialize(): Promise<void> {
		await this.ensureTables()

		const rows = await this.client.unsafe<{ node_id: string; max_sequence_number: number }[]>(
			'SELECT node_id, max_sequence_number FROM sync_state',
		)

		for (const row of rows) {
			this.versionVector.set(row.node_id, row.max_sequence_number)
		}
	}

	private async ensureTables(): Promise<void> {
		await this.client.unsafe(`
			CREATE TABLE IF NOT EXISTS operations (
				id TEXT PRIMARY KEY,
				node_id TEXT NOT NULL,
				type TEXT NOT NULL,
				collection TEXT NOT NULL,
				record_id TEXT NOT NULL,
				data TEXT,
				previous_data TEXT,
				wall_time INTEGER NOT NULL,
				logical INTEGER NOT NULL,
				timestamp_node_id TEXT NOT NULL,
				sequence_number INTEGER NOT NULL,
				causal_deps TEXT NOT NULL DEFAULT '[]',
				schema_version INTEGER NOT NULL,
				received_at INTEGER NOT NULL
			)
		`)

		await this.client.unsafe(
			'CREATE INDEX IF NOT EXISTS idx_node_seq ON operations (node_id, sequence_number)',
		)
		await this.client.unsafe('CREATE INDEX IF NOT EXISTS idx_collection ON operations (collection)')
		await this.client.unsafe('CREATE INDEX IF NOT EXISTS idx_received ON operations (received_at)')

		await this.client.unsafe(`
			CREATE TABLE IF NOT EXISTS sync_state (
				node_id TEXT PRIMARY KEY,
				max_sequence_number INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL
			)
		`)
	}

	private serializeOperation(op: Operation): {
		id: string
		nodeId: string
		type: string
		collection: string
		recordId: string
		data: string | null
		previousData: string | null
		wallTime: number
		logical: number
		timestampNodeId: string
		sequenceNumber: number
		causalDeps: string
		schemaVersion: number
	} {
		return {
			id: op.id,
			nodeId: op.nodeId,
			type: op.type,
			collection: op.collection,
			recordId: op.recordId,
			data: op.data !== null ? JSON.stringify(op.data) : null,
			previousData: op.previousData !== null ? JSON.stringify(op.previousData) : null,
			wallTime: op.timestamp.wallTime,
			logical: op.timestamp.logical,
			timestampNodeId: op.timestamp.nodeId,
			sequenceNumber: op.sequenceNumber,
			causalDeps: JSON.stringify(op.causalDeps),
			schemaVersion: op.schemaVersion,
		}
	}

	private deserializeOperation(row: OperationRow): Operation {
		return {
			id: row.id,
			nodeId: row.node_id,
			type: row.type as Operation['type'],
			collection: row.collection,
			recordId: row.record_id,
			data: row.data !== null ? JSON.parse(row.data) : null,
			previousData: row.previous_data !== null ? JSON.parse(row.previous_data) : null,
			timestamp: {
				wallTime: row.wall_time,
				logical: row.logical,
				nodeId: row.timestamp_node_id,
			},
			sequenceNumber: row.sequence_number,
			causalDeps: JSON.parse(row.causal_deps),
			schemaVersion: row.schema_version,
		}
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error('PostgresServerStore is closed')
		}
	}
}

/**
 * Creates a PostgresServerStore from a PostgreSQL connection string.
 *
 * Uses runtime dynamic imports so projects that do not use PostgreSQL
 * do not need to install `postgres`.
 */
export async function createPostgresServerStore(options: {
	connectionString: string
	nodeId?: string
}): Promise<PostgresServerStore> {
	const postgresModule = await loadPostgresModule()
	const postgresClient = postgresModule.default(options.connectionString)

	return new PostgresServerStore(postgresClient, options.nodeId)
}

async function loadPostgresModule(): Promise<{ default: (connectionString: string) => PostgresClient }> {
	try {
		const dynamicImport = new Function('specifier', 'return import(specifier)') as (
			specifier: string,
		) => Promise<unknown>
		const mod = await dynamicImport('postgres')
		if (typeof mod === 'object' && mod !== null && 'default' in mod) {
			return mod as { default: (connectionString: string) => PostgresClient }
		}
		throw new Error('Invalid postgres module shape')
	} catch {
		throw new Error(
			'PostgreSQL backend requires the "postgres" package. Install it in your project dependencies.',
		)
	}
}
