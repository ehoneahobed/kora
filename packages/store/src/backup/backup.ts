import { generateUUIDv7 } from '@korajs/core'
import type { Operation, SchemaDefinition, VersionVector } from '@korajs/core'
import type { StorageAdapter } from '../types'
import type {
	BackupManifest,
	BackupOptions,
	BackupProgress,
	RestoreOptions,
	RestoreResult,
} from './types'

// ── Section I/O helpers ──────────────────────────────────────────────────────

function encodeSection(name: string, content: Uint8Array): Uint8Array {
	const nameBytes = new TextEncoder().encode(name)
	const header = new Uint8Array(8)
	const dv = new DataView(header.buffer)
	dv.setUint32(0, nameBytes.length, true)
	dv.setUint32(4, content.length, true)

	const result = new Uint8Array(header.length + nameBytes.length + content.length)
	result.set(header, 0)
	result.set(nameBytes, 8)
	result.set(content, 8 + nameBytes.length)
	return result
}

function encodeJsonSection(name: string, data: unknown): Uint8Array {
	const json = JSON.stringify(data)
	return encodeSection(name, new TextEncoder().encode(json))
}

function encodeNdjsonSection(name: string, records: unknown[]): Uint8Array {
	const lines = `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
	return encodeSection(name, new TextEncoder().encode(lines))
}

function readUint32(view: DataView, offset: number): number {
	return view.getUint32(offset, true)
}

interface Section {
	name: string
	content: Uint8Array
}

function parseSections(data: Uint8Array): Section[] {
	const sections: Section[] = []
	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
	let offset = 0

	while (offset + 8 <= data.byteLength) {
		const nameLen = readUint32(dv, offset)
		const contentLen = readUint32(dv, offset + 4)
		offset += 8

		if (offset + nameLen + contentLen > data.byteLength) break

		const name = new TextDecoder().decode(data.slice(offset, offset + nameLen))
		offset += nameLen

		const content = data.slice(offset, offset + contentLen)
		offset += contentLen

		sections.push({ name, content })
	}

	return sections
}

function findSection(sections: Section[], name: string): Uint8Array | null {
	for (const s of sections) {
		if (s.name === name) return s.content
	}
	return null
}

function parseJsonSection<T>(sections: Section[], name: string): T | null {
	const content = findSection(sections, name)
	if (!content) return null
	return JSON.parse(new TextDecoder().decode(content)) as T
}

/**
 * Export format version. Bump on breaking changes.
 */
const BACKUP_VERSION = 1

/**
 * Export a backup from a store.
 *
 * Reads all data via the adapter and produces a portable binary backup.
 *
 * @param adapter - The storage adapter
 * @param schema - The schema definition
 * @param nodeId - Current node ID
 * @param schemaVersion - Schema version
 * @param options - Backup options
 * @returns Backup as a Uint8Array
 */
export async function exportBackup(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	nodeId: string,
	schemaVersion: number,
	options?: BackupOptions,
): Promise<Uint8Array> {
	const onProgress = options?.onProgress ?? (() => {})
	const includeRecords = options?.includeRecords ?? true
	const collectionFilter = options?.collections
	const collections = collectionFilter
		? Object.keys(schema.collections).filter((c) => collectionFilter.includes(c))
		: Object.keys(schema.collections)

	onProgress({ phase: 'reading', progress: 0, message: 'Reading version vector' })
	const versionVector = await readVersionVector(adapter)
	onProgress({ phase: 'reading', progress: 0.1, message: 'Reading metadata' })
	const meta = await readMeta(adapter)
	onProgress({ phase: 'reading', progress: 0.2, message: 'Reading operations' })
	const operations = await readAllOperations(adapter, schema)
	onProgress({ phase: 'reading', progress: 0.5, message: 'Reading records' })

	const sections: Uint8Array[] = []
	let allContentForChecksum = new Uint8Array(0)

	// Helper: add a section and update running checksum content
	const addSection = (name: string, data: Uint8Array) => {
		sections.push(data)
		const newLen = allContentForChecksum.length + data.length
		const combined = new Uint8Array(newLen)
		combined.set(allContentForChecksum, 0)
		combined.set(data, allContentForChecksum.length)
		allContentForChecksum = combined
	}

	// Version vector section
	const vvObj: Record<string, number> = {}
	for (const [nid, seq] of versionVector) {
		vvObj[nid] = seq
	}
	addSection('version_vector', encodeJsonSection('version_vector', vvObj))

	// Meta section
	const metaObj: Record<string, string> = {}
	for (const row of meta) {
		metaObj[row.key] = row.value
	}
	addSection('meta', encodeJsonSection('meta', metaObj))

	// Operations section
	const opLines = `${operations.map((op) => JSON.stringify(op)).join('\n')}\n`
	addSection('operations', encodeSection('operations', new TextEncoder().encode(opLines)))

	// Records sections (optional)
	let totalRecords = 0
	if (includeRecords) {
		for (const col of collections) {
			const records = await readCollectionRecords(adapter, col)
			if (records.length > 0) {
				const lines = `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
				const sectionName = `records:${col}`
				addSection(sectionName, encodeSection(sectionName, new TextEncoder().encode(lines)))
				totalRecords += records.length
			}
		}
	}
	onProgress({ phase: 'reading', progress: 0.9, message: 'Computing checksum' })

	// Compute SHA-256 checksum over all content sections
	const checksumHex = await computeSha256(allContentForChecksum)
	onProgress({ phase: 'writing', progress: 1, message: 'Finalizing' })

	// Build manifest
	const manifest: BackupManifest = {
		version: BACKUP_VERSION,
		createdAt: Date.now(),
		nodeId,
		schemaVersion,
		operationCount: operations.length,
		collections,
		includesRecords: includeRecords,
		checksum: checksumHex,
	}

	// Final output: header + manifest + all content sections + checksum section
	const header = new Uint8Array(0)

	// Merge manifest + all sections + checksum section
	const manifestSection = encodeJsonSection('manifest', manifest)
	const checksumSection = encodeSection('checksum', new TextEncoder().encode(checksumHex))

	const totalLen = manifestSection.length + allContentForChecksum.length + checksumSection.length
	const result = new Uint8Array(totalLen)
	let pos = 0
	result.set(manifestSection, pos)
	pos += manifestSection.length
	result.set(allContentForChecksum, pos)
	pos += allContentForChecksum.length
	result.set(checksumSection, pos)

	return result
}

/**
 * Read backup manifest without loading the entire backup.
 * Parses only the first section (which is always the manifest).
 *
 * @param data - The raw backup data
 * @returns The backup manifest
 */
export function readBackupManifest(data: Uint8Array): BackupManifest {
	const sections = parseSections(data)
	const manifest = parseJsonSection<BackupManifest>(sections, 'manifest')
	if (!manifest) {
		throw new Error('Invalid backup: manifest section not found')
	}
	return manifest
}

/**
 * Validate the backup checksum.
 *
 * @param data - The raw backup data
 * @returns True if the checksum is valid
 */
export async function verifyBackupChecksum(data: Uint8Array): Promise<boolean> {
	const sections = parseSections(data)
	const manifest = parseJsonSection<BackupManifest>(sections, 'manifest')
	if (!manifest) return false

	const storedChecksum = manifest.checksum
	if (!storedChecksum) return false

	// Recompute checksum over content sections (everything after manifest, before checksum)
	const manifestSection = findSection(sections, 'manifest')
	if (!manifestSection) return false

	// Find the checksum section
	const checksumSection = findSection(sections, 'checksum')

	// The content spans from end of manifest section to start of checksum section
	const checksumBytes = checksumSection
		? new TextEncoder().encode(manifest.checksum)
		: new Uint8Array(0)

	// Rebuild all content sections and hash them
	const contentSections = sections.filter((s) => s.name !== 'manifest' && s.name !== 'checksum')

	let contentForHash = new Uint8Array(0)
	for (const section of contentSections) {
		const sectionBytes = encodeSection(section.name, section.content)
		const newLen = contentForHash.length + sectionBytes.length
		const combined = new Uint8Array(newLen)
		combined.set(contentForHash, 0)
		combined.set(sectionBytes, contentForHash.length)
		contentForHash = combined
	}

	const computed = await computeSha256(contentForHash)
	return computed === storedChecksum
}

/**
 * Restore a backup into a store.
 *
 * @param adapter - The storage adapter
 * @param schema - The schema definition
 * @param data - The backup data
 * @param options - Restore options
 * @returns Result of the restore operation
 */
export async function restoreBackup(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	data: Uint8Array,
	options?: RestoreOptions,
): Promise<RestoreResult> {
	const startTime = Date.now()
	const onProgress = options?.onProgress ?? (() => {})
	const collectionFilter = options?.collections

	onProgress({ phase: 'verifying', progress: 0, message: 'Parsing backup' })

	const sections = parseSections(data)
	const manifest = parseJsonSection<BackupManifest>(sections, 'manifest')
	if (!manifest) {
		return {
			operationsRestored: 0,
			recordsRestored: 0,
			success: false,
			error: 'Invalid backup: manifest section not found',
			duration: Date.now() - startTime,
		}
	}

	// Validate format version
	if (manifest.version !== BACKUP_VERSION) {
		return {
			operationsRestored: 0,
			recordsRestored: 0,
			success: false,
			error: `Unsupported backup version: ${manifest.version}`,
			duration: Date.now() - startTime,
		}
	}

	onProgress({ phase: 'verifying', progress: 0.2, message: 'Verifying checksum' })

	// Verify checksum
	const valid = await verifyBackupChecksum(data)
	if (!valid) {
		return {
			operationsRestored: 0,
			recordsRestored: 0,
			success: false,
			error: 'Backup checksum mismatch: data may be corrupted',
			duration: Date.now() - startTime,
		}
	}

	onProgress({ phase: 'restoring', progress: 0.3, message: 'Loading operations' })

	// Parse operations
	const opsContent = findSection(sections, 'operations')
	let operations: Operation[] = []
	if (opsContent) {
		const text = new TextDecoder().decode(opsContent)
		const lines = text
			.trim()
			.split('\n')
			.filter((l) => l.length > 0)
		operations = lines.map((line) => JSON.parse(line) as Operation)
	}

	// Filter collections if requested
	if (collectionFilter) {
		operations = operations.filter((op) => collectionFilter.includes(op.collection))
	}

	// Load version vector
	const vvData = parseJsonSection<Record<string, number>>(sections, 'version_vector')

	// Load meta
	const metaData = parseJsonSection<Record<string, string>>(sections, 'meta')

	onProgress({ phase: 'restoring', progress: 0.4, message: 'Applying operations' })

	if (options?.merge) {
		// Merge mode: replay operations through applyRemoteOperation.
		// This won't work directly since adapter doesn't have applyRemoteOperation.
		// Instead, we import the raw data into the adapter.
		await adapter.transaction(async (tx) => {
			// Import version vector
			if (vvData) {
				for (const [nid, seq] of Object.entries(vvData)) {
					await tx.execute(
						'INSERT OR REPLACE INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)',
						[nid, seq],
					)
				}
			}

			// Import meta
			if (metaData) {
				for (const [key, value] of Object.entries(metaData)) {
					await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
						key,
						value,
					])
				}
			}

			// Import operations into _kora_ops_ tables
			for (const op of operations) {
				const collection = op.collection
				const opRow = {
					id: op.id,
					node_id: op.nodeId,
					type: op.type,
					record_id: op.recordId,
					data: op.data !== null ? JSON.stringify(op.data) : null,
					previous_data: op.previousData !== null ? JSON.stringify(op.previousData) : null,
					timestamp: JSON.stringify(op.timestamp),
					sequence_number: op.sequenceNumber,
					causal_deps: JSON.stringify(op.causalDeps),
					schema_version: op.schemaVersion,
				}

				await tx.execute(
					`INSERT OR IGNORE INTO _kora_ops_${collection} (id, node_id, type, record_id, data, previous_data, timestamp, sequence_number, causal_deps, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						opRow.id,
						opRow.node_id,
						opRow.type,
						opRow.record_id,
						opRow.data,
						opRow.previous_data,
						opRow.timestamp,
						opRow.sequence_number,
						opRow.causal_deps,
						opRow.schema_version,
					],
				)
			}
		})
	} else {
		// Replace mode: clear existing data and bulk import
		await adapter.transaction(async (tx) => {
			// Clear existing data
			for (const collection of Object.keys(schema.collections)) {
				await tx.execute(`DELETE FROM _kora_ops_${collection}`)
				await tx.execute(`DELETE FROM ${collection}`)
			}
			await tx.execute('DELETE FROM _kora_version_vector')
			await tx.execute('DELETE FROM _kora_meta')

			// Import version vector
			if (vvData) {
				for (const [nid, seq] of Object.entries(vvData)) {
					await tx.execute(
						'INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, ?)',
						[nid, seq],
					)
				}
			}

			// Import meta
			if (metaData) {
				for (const [key, value] of Object.entries(metaData)) {
					await tx.execute('INSERT INTO _kora_meta (key, value) VALUES (?, ?)', [key, value])
				}
			}

			// Import operations
			for (const op of operations) {
				const collection = op.collection
				await tx.execute(
					`INSERT INTO _kora_ops_${collection} (id, node_id, type, record_id, data, previous_data, timestamp, sequence_number, causal_deps, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						op.id,
						op.nodeId,
						op.type,
						op.recordId,
						op.data !== null ? JSON.stringify(op.data) : null,
						op.previousData !== null ? JSON.stringify(op.previousData) : null,
						JSON.stringify(op.timestamp),
						op.sequenceNumber,
						JSON.stringify(op.causalDeps),
						op.schemaVersion,
					],
				)
			}
		})
	}

	onProgress({ phase: 'restoring', progress: 0.8, message: 'Restoring records' })

	// Restore records sections (optional)
	let recordsRestored = 0
	if (manifest.includesRecords) {
		for (const col of manifest.collections) {
			if (collectionFilter && !collectionFilter.includes(col)) continue

			const sectionContent = findSection(sections, `records:${col}`)
			if (!sectionContent) continue

			const text = new TextDecoder().decode(sectionContent)
			const lines = text
				.trim()
				.split('\n')
				.filter((l) => l.length > 0)
			const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>)

			if (records.length === 0) continue

			await adapter.transaction(async (tx) => {
				for (const record of records) {
					const keys = Object.keys(record)
					const placeholders = keys.map(() => '?').join(', ')
					const values = keys.map((k) => {
						const v = record[k]
						if (typeof v === 'boolean') return v ? 1 : 0
						if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return JSON.stringify(v)
						return v
					})

					await tx.execute(
						`INSERT OR REPLACE INTO ${col} (${keys.join(', ')}) VALUES (${placeholders})`,
						values,
					)
				}
			})

			recordsRestored += records.length
		}
	}

	onProgress({ phase: 'restoring', progress: 1, message: 'Done' })

	return {
		operationsRestored: operations.length,
		recordsRestored,
		success: true,
		duration: Date.now() - startTime,
	}
}

// ── Reading helpers ──────────────────────────────────────────────────────────

async function readVersionVector(adapter: StorageAdapter): Promise<Map<string, number>> {
	const rows = await adapter.query<{ node_id: string; sequence_number: number }>(
		'SELECT node_id, sequence_number FROM _kora_version_vector',
	)
	const vv = new Map<string, number>()
	for (const row of rows) {
		vv.set(row.node_id, row.sequence_number)
	}
	return vv
}

interface MetaRow {
	key: string
	value: string
}

async function readMeta(adapter: StorageAdapter): Promise<MetaRow[]> {
	return adapter.query<MetaRow>('SELECT key, value FROM _kora_meta')
}

interface OperationRow {
	id: string
	node_id: string
	type: string
	record_id: string
	data: string | null
	previous_data: string | null
	timestamp: string
	sequence_number: number
	causal_deps: string
	schema_version: number
}

async function readAllOperations(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
): Promise<Operation[]> {
	const allOps: Operation[] = []

	for (const collectionName of Object.keys(schema.collections)) {
		const rows = await adapter.query<OperationRow>(
			`SELECT * FROM _kora_ops_${collectionName} ORDER BY sequence_number ASC`,
		)

		for (const row of rows) {
			allOps.push({
				id: row.id,
				nodeId: row.node_id,
				type: row.type as Operation['type'],
				collection: collectionName,
				recordId: row.record_id,
				data: row.data !== null ? JSON.parse(row.data) : null,
				previousData: row.previous_data !== null ? JSON.parse(row.previous_data) : null,
				timestamp: JSON.parse(row.timestamp),
				sequenceNumber: row.sequence_number,
				causalDeps: JSON.parse(row.causal_deps),
				schemaVersion: row.schema_version,
			})
		}
	}

	return allOps
}

async function readCollectionRecords(
	adapter: StorageAdapter,
	collection: string,
): Promise<Record<string, unknown>[]> {
	return adapter.query<Record<string, unknown>>(`SELECT * FROM ${collection} WHERE _deleted = 0`)
}

// ── Crypto helpers ───────────────────────────────────────────────────────────

async function computeSha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data)
	const hashArray = Array.from(new Uint8Array(hashBuffer))
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}
