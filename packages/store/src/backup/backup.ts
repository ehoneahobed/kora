import { HybridLogicalClock, KoraError, quoteIdent } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { checkOperationRow, recoverTimestamp } from '../log-integrity/log-integrity'
import { deserializeOperationWithCollection, serializeOperation } from '../serialization/serializer'
import { SEQ_CONFLICTS_TABLE } from '../store/sequence-repair'
import { TERMINAL_REJECTIONS_TABLE, type TerminalRejection } from '../sync/local-sync-records'
import type { OperationRow, StorageAdapter, Transaction } from '../types'
import type { BackupManifest, BackupOptions, RestoreOptions, RestoreResult } from './types'

// ── Format ──────────────────────────────────────────────────────────────────
//
// A backup is a sequence of sections `[u32 nameLen][u32 contentLen][name][content]`:
//
//   manifest            JSON BackupManifest (first section)
//   version_vector      JSON { nodeId: maxSequence } of the exporting database
//   operations          NDJSON, one canonical Operation per line (collection, data,
//                       previousData, HLC timestamp object, atomicOps, transactionId,
//                       mutationName, fieldVersions), in HLC order. Includes
//                       operations kept only in the sequence-conflicts table.
//   terminal_rejections JSON TerminalRejection[] (operations the server refused for good)
//   records:<name>      NDJSON raw rows of the collection, tombstones included, bytes
//                       tagged as { "$bytes": "<base64>" }
//   checksum            SHA-256 hex over every section between manifest and checksum
//
// Version 2 (STORE-5) carries no `_kora_meta`: a device's identity (node id, node
// tokens) and sync state never travel in a backup. Version 1 files are refused with
// BACKUP_FORMAT_OUTDATED; {@link convertBackupV1} converts them.

/** Current backup format version. */
export const BACKUP_VERSION = 2

/** A backup file this release cannot restore as-is. */
export class BackupFormatError extends KoraError {
	constructor(message: string, code: string, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'BackupFormatError'
	}
}

function encodeSection(name: string, content: Uint8Array): Uint8Array {
	const nameBytes = new TextEncoder().encode(name)
	const result = new Uint8Array(8 + nameBytes.length + content.length)
	const dv = new DataView(result.buffer)
	dv.setUint32(0, nameBytes.length, true)
	dv.setUint32(4, content.length, true)
	result.set(nameBytes, 8)
	result.set(content, 8 + nameBytes.length)
	return result
}

function encodeJsonSection(name: string, data: unknown): Uint8Array {
	return encodeSection(name, new TextEncoder().encode(JSON.stringify(data, bytesReplacer)))
}

function encodeNdjsonSection(name: string, items: unknown[]): Uint8Array {
	const lines = items.map((item) => JSON.stringify(item, bytesReplacer)).join('\n')
	return encodeSection(name, new TextEncoder().encode(items.length > 0 ? `${lines}\n` : ''))
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
		const nameLen = dv.getUint32(offset, true)
		const contentLen = dv.getUint32(offset + 4, true)
		offset += 8
		if (offset + nameLen + contentLen > data.byteLength) break
		const name = new TextDecoder().decode(data.slice(offset, offset + nameLen))
		offset += nameLen
		sections.push({ name, content: data.slice(offset, offset + contentLen) })
		offset += contentLen
	}
	return sections
}

function findSection(sections: Section[], name: string): Uint8Array | null {
	return sections.find((section) => section.name === name)?.content ?? null
}

function parseJsonSection<T>(sections: Section[], name: string): T | null {
	const content = findSection(sections, name)
	if (!content) return null
	return JSON.parse(new TextDecoder().decode(content), bytesReviver) as T
}

function parseNdjson<T>(content: Uint8Array | null): T[] {
	if (!content) return []
	return new TextDecoder()
		.decode(content)
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line, bytesReviver) as T)
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0)
	const result = new Uint8Array(total)
	let pos = 0
	for (const part of parts) {
		result.set(part, pos)
		pos += part.length
	}
	return result
}

// ── Export ──────────────────────────────────────────────────────────────────

/**
 * Export a backup (format version 2) from an opened database.
 *
 * Everything is read inside one transaction, so the backup is a consistent snapshot.
 * Operations are exported in canonical form (exactly what `deserializeOperation` reads
 * back), including tombstones, so a restore rebuilds the same log.
 *
 * @param adapter - The storage adapter
 * @param schema - The schema definition
 * @param nodeId - Node id of the exporting device (informational only; never imported)
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
	const filter = options?.collections
	const collections = Object.keys(schema.collections).filter(
		(name) => !filter || filter.includes(name),
	)

	const snapshot: {
		vector: Record<string, number>
		operations: Operation[]
		terminal: TerminalRejection[]
		records: Map<string, Array<Record<string, unknown>>>
	} = { vector: {}, operations: [], terminal: [], records: new Map() }

	onProgress({ phase: 'reading', progress: 0, message: 'Reading the local database' })
	await adapter.transaction(async (tx) => {
		const vector = await tx.query<{ node_id: string; sequence_number: number }>(
			'SELECT node_id, sequence_number FROM _kora_version_vector',
		)
		for (const row of vector) snapshot.vector[row.node_id] = row.sequence_number
		snapshot.operations = await readOperations(tx, collections)
		snapshot.terminal = await readTerminalRejections(tx)
		if (includeRecords) {
			for (const collection of collections) {
				snapshot.records.set(
					collection,
					await tx.query<Record<string, unknown>>(`SELECT * FROM ${quoteIdent(collection)}`),
				)
			}
		}
	})
	onProgress({ phase: 'reading', progress: 0.7, message: 'Encoding' })

	const content: Uint8Array[] = [
		encodeJsonSection('version_vector', snapshot.vector),
		encodeNdjsonSection('operations', snapshot.operations),
		encodeJsonSection('terminal_rejections', snapshot.terminal),
	]
	for (const [collection, rows] of snapshot.records) {
		if (rows.length > 0) content.push(encodeNdjsonSection(`records:${collection}`, rows))
	}
	const body = concat(content)
	const checksum = await computeSha256(body)
	onProgress({ phase: 'writing', progress: 1, message: 'Finalizing' })

	const manifest: BackupManifest = {
		version: BACKUP_VERSION,
		createdAt: Date.now(),
		nodeId,
		schemaVersion,
		operationCount: snapshot.operations.length,
		collections,
		includesRecords: includeRecords,
		includesTombstones: true,
		checksum,
	}
	return concat([
		encodeJsonSection('manifest', manifest),
		body,
		encodeSection('checksum', new TextEncoder().encode(checksum)),
	])
}

/** Operations of `collections` in canonical form and HLC order (causal order). */
async function readOperations(tx: Transaction, collections: string[]): Promise<Operation[]> {
	const operations: Operation[] = []
	const seen = new Set<string>()
	const retained = await hasTable(tx, SEQ_CONFLICTS_TABLE)
	for (const collection of collections) {
		const rows = await tx.query<OperationRow>(
			`SELECT * FROM ${quoteIdent(`_kora_ops_${collection}`)} ORDER BY sequence_number ASC`,
		)
		// Other nodes' operations kept only in the sequence-conflicts table still belong
		// to the log (record folds and dedup use them).
		if (retained) {
			rows.push(
				...(await tx.query<OperationRow>(
					`SELECT id, node_id, type, record_id, data, previous_data, timestamp, sequence_number, causal_deps, schema_version FROM ${SEQ_CONFLICTS_TABLE} WHERE collection = ? AND reemitted_as IS NULL`,
					[collection],
				)),
			)
		}
		for (const row of rows) {
			if (seen.has(row.id)) continue
			seen.add(row.id)
			operations.push(deserializeOperationWithCollection(row, collection))
		}
	}
	operations.sort((a, b) => HybridLogicalClock.compare(a.timestamp, b.timestamp))
	return operations
}

async function readTerminalRejections(tx: Transaction): Promise<TerminalRejection[]> {
	if (!(await hasTable(tx, TERMINAL_REJECTIONS_TABLE))) return []
	const rows = await tx.query<{
		operation_id: string
		node_id: string | null
		sequence_number: number | null
		code: string
		rejected_at: number
	}>(
		`SELECT operation_id, node_id, sequence_number, code, rejected_at FROM ${TERMINAL_REJECTIONS_TABLE} ORDER BY operation_id`,
	)
	return rows.map((row) => ({
		operationId: row.operation_id,
		nodeId: row.node_id,
		sequenceNumber: row.sequence_number,
		code: row.code,
		rejectedAt: row.rejected_at,
	}))
}

async function hasTable(tx: Transaction, name: string): Promise<boolean> {
	const rows = await tx.query<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		[name],
	)
	return rows.length > 0
}

// ── Parse ───────────────────────────────────────────────────────────────────

/** A verified, parsed version-2 backup. */
export interface ParsedBackup {
	manifest: BackupManifest
	/** Canonical operations of the requested collections, in HLC order. */
	operations: Operation[]
	/** Version vector of the exporting database. */
	versionVector: Map<string, number>
	terminalRejections: TerminalRejection[]
	/** Raw rows per collection (present only when the manifest includes records). */
	records: Map<string, Array<Record<string, unknown>>>
}

/**
 * Read backup manifest without loading the entire backup.
 *
 * @param data - The raw backup data
 * @returns The backup manifest
 */
export function readBackupManifest(data: Uint8Array): BackupManifest {
	const manifest = parseJsonSection<BackupManifest>(parseSections(data), 'manifest')
	if (!manifest) {
		throw new BackupFormatError('Invalid backup: manifest section not found', 'BACKUP_INVALID')
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
	if (!manifest?.checksum) return false
	const body = concat(
		sections
			.filter((s) => s.name !== 'manifest' && s.name !== 'checksum')
			.map((s) => encodeSection(s.name, s.content)),
	)
	return (await computeSha256(body)) === manifest.checksum
}

/**
 * Parse and verify a backup: format version, checksum, and every operation must be
 * canonical (it round-trips through the operation serializer). Throws
 * {@link BackupFormatError}; nothing is written.
 *
 * @param data - The raw backup data
 * @param options - `collections` keeps only those collections
 */
export async function parseBackup(
	data: Uint8Array,
	options?: { collections?: string[] },
): Promise<ParsedBackup> {
	const sections = parseSections(data)
	const manifest = parseJsonSection<BackupManifest>(sections, 'manifest')
	if (!manifest) {
		throw new BackupFormatError('Invalid backup: manifest section not found', 'BACKUP_INVALID')
	}
	if (manifest.version === 1) {
		throw new BackupFormatError(
			'This backup was written by Kora 1.0.0-beta.13 or earlier (format version 1), whose restore corrupted operation timestamps and copied the exporting device identity. Convert it first: `restoreBackup`/`importBackup(await convertBackupV1(data))`.',
			'BACKUP_FORMAT_OUTDATED',
			{ version: 1, fix: 'Call convertBackupV1(data) and import the result.' },
		)
	}
	if (manifest.version !== BACKUP_VERSION) {
		throw new BackupFormatError(
			`Unsupported backup version: ${String(manifest.version)} (this release reads version ${BACKUP_VERSION}).`,
			'BACKUP_VERSION_UNSUPPORTED',
			{ version: manifest.version },
		)
	}
	if (!(await verifyBackupChecksum(data))) {
		throw new BackupFormatError(
			'Backup checksum mismatch: data may be corrupted',
			'BACKUP_CHECKSUM_MISMATCH',
		)
	}

	const keep = (collection: string): boolean =>
		!options?.collections || options.collections.includes(collection)
	const operations: Operation[] = []
	for (const raw of parseNdjson<Operation>(findSection(sections, 'operations'))) {
		if (!keep(raw.collection)) continue
		operations.push(canonicalOperation(raw))
	}
	operations.sort((a, b) => HybridLogicalClock.compare(a.timestamp, b.timestamp))

	const vector = new Map<string, number>()
	for (const [nodeId, seq] of Object.entries(
		parseJsonSection<Record<string, number>>(sections, 'version_vector') ?? {},
	)) {
		if (Number.isInteger(seq) && seq > 0) vector.set(nodeId, seq)
	}

	const records = new Map<string, Array<Record<string, unknown>>>()
	if (manifest.includesRecords) {
		for (const collection of manifest.collections) {
			if (!keep(collection)) continue
			records.set(
				collection,
				parseNdjson<Record<string, unknown>>(findSection(sections, `records:${collection}`)),
			)
		}
	}

	return {
		manifest,
		operations,
		versionVector: vector,
		terminalRejections:
			parseJsonSection<TerminalRejection[]>(sections, 'terminal_rejections') ?? [],
		records,
	}
}

/** Re-read an exported operation through the log serializer; refuse a damaged one. */
function canonicalOperation(raw: Operation): Operation {
	let row: OperationRow
	try {
		row = serializeOperation(raw)
	} catch (error) {
		throw new BackupFormatError(
			`Backup operation ${String(raw?.id)} is not a valid operation: ${error instanceof Error ? error.message : String(error)}`,
			'BACKUP_OPERATION_INVALID',
			{ operationId: raw?.id },
		)
	}
	const verdict = checkOperationRow(row)
	if (verdict.kind !== 'ok' || typeof raw.collection !== 'string' || raw.collection === '') {
		throw new BackupFormatError(
			`Backup operation ${String(raw.id)} is not canonical (${verdict.kind === 'ok' ? 'no collection' : verdict.problem}).`,
			'BACKUP_OPERATION_INVALID',
			{ operationId: raw.id },
		)
	}
	return deserializeOperationWithCollection(row, raw.collection)
}

// ── Version 1 conversion ────────────────────────────────────────────────────

/** Options for {@link convertBackupV1}. */
export interface ConvertBackupV1Options {
	/**
	 * Drop operations whose timestamp cannot be recovered instead of refusing the file.
	 * Default false.
	 */
	dropUnrecoverable?: boolean
}

/**
 * Convert a version-1 backup (Kora 1.0.0-beta.13 and earlier) to version 2.
 *
 * - Operations: a v1 file exported from a database that a v1 restore had damaged holds
 *   misread timestamps (`wallTime: null`); they are recovered from the misread values
 *   (the same rule as the log-integrity scan). An unrecoverable one refuses the file
 *   unless `dropUnrecoverable` is set.
 * - The `meta` section (the exporting device's node id, node tokens, sync state) is
 *   dropped: it must never be imported into another database.
 * - Record rows are kept; v1 exported live rows only, so the manifest records
 *   `includesTombstones: false`. Bytes that v1 serialized as `{"0":..,"1":..}` objects
 *   are decoded on restore.
 *
 * @throws {BackupFormatError} When the input is not a valid version-1 backup
 */
export async function convertBackupV1(
	data: Uint8Array,
	options?: ConvertBackupV1Options,
): Promise<Uint8Array> {
	const sections = parseSections(data)
	const manifest = parseJsonSection<BackupManifest>(sections, 'manifest')
	if (!manifest || manifest.version !== 1) {
		throw new BackupFormatError('convertBackupV1 expects a version-1 backup.', 'BACKUP_INVALID', {
			version: manifest?.version,
		})
	}
	if (!(await verifyBackupChecksum(data))) {
		throw new BackupFormatError(
			'Backup checksum mismatch: data may be corrupted',
			'BACKUP_CHECKSUM_MISMATCH',
		)
	}
	const operations: Operation[] = []
	const dropped: string[] = []
	for (const raw of parseNdjson<Operation>(findSection(sections, 'operations'))) {
		const fixed = recoverV1Operation(raw)
		if (fixed) operations.push(fixed)
		else dropped.push(String(raw?.id))
	}
	if (dropped.length > 0 && !options?.dropUnrecoverable) {
		throw new BackupFormatError(
			`${dropped.length} operation(s) in this version-1 backup have unrecoverable timestamps (first: ${dropped[0]}). Pass { dropUnrecoverable: true } to convert without them.`,
			'BACKUP_OPERATION_INVALID',
			{ operationIds: dropped.slice(0, 20) },
		)
	}
	operations.sort((a, b) => HybridLogicalClock.compare(a.timestamp, b.timestamp))

	const content: Uint8Array[] = [
		encodeJsonSection(
			'version_vector',
			parseJsonSection<Record<string, number>>(sections, 'version_vector') ?? {},
		),
		encodeNdjsonSection('operations', operations),
		encodeJsonSection('terminal_rejections', []),
	]
	for (const section of sections) {
		if (section.name.startsWith('records:')) {
			const rows = parseNdjson<Record<string, unknown>>(section.content).map(decodeV1Bytes)
			content.push(encodeNdjsonSection(section.name, rows))
		}
	}
	const body = concat(content)
	const checksum = await computeSha256(body)
	const converted: BackupManifest = {
		version: BACKUP_VERSION,
		createdAt: manifest.createdAt,
		nodeId: manifest.nodeId,
		schemaVersion: manifest.schemaVersion,
		operationCount: operations.length,
		collections: manifest.collections,
		includesRecords: manifest.includesRecords,
		includesTombstones: false,
		checksum,
		convertedFrom: 1,
	}
	return concat([
		encodeJsonSection('manifest', converted),
		body,
		encodeSection('checksum', new TextEncoder().encode(checksum)),
	])
}

function recoverV1Operation(raw: Operation): Operation | null {
	if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null
	const ts = raw.timestamp as unknown
	let timestamp = ts as Operation['timestamp']
	const valid =
		ts !== null &&
		typeof ts === 'object' &&
		Number.isInteger((ts as { wallTime: unknown }).wallTime) &&
		Number.isInteger((ts as { logical: unknown }).logical)
	if (!valid) {
		const recovered = recoverTimestamp(JSON.stringify(ts))
		if (!recovered) return null
		timestamp = HybridLogicalClock.deserialize(recovered)
	}
	try {
		return canonicalOperation({ ...raw, timestamp })
	} catch {
		return null
	}
}

/** v1 wrote Uint8Array columns through JSON.stringify: `{"0":1,"1":2}`. */
function decodeV1Bytes(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(row)) {
		out[key] = looksLikeSerializedBytes(value) ? toBytes(value as Record<string, number>) : value
	}
	return out
}

function looksLikeSerializedBytes(value: unknown): boolean {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const entries = Object.entries(value as Record<string, unknown>)
	if (entries.length === 0) return false
	return entries.every(
		([key, byte], index) =>
			key === String(index) &&
			Number.isInteger(byte) &&
			(byte as number) >= 0 &&
			(byte as number) < 256,
	)
}

function toBytes(value: Record<string, number>): Uint8Array {
	const length = Object.keys(value).length
	const bytes = new Uint8Array(length)
	for (let i = 0; i < length; i++) bytes[i] = value[String(i)] ?? 0
	return bytes
}

// ── Low-level restore (deprecated entry point) ─────────────────────────────

/**
 * Restore a backup into the database behind `adapter`.
 *
 * @deprecated Use `store.importBackup()` / `app.importBackup()`: restoring needs the
 *   store (the device's identity, version vector, clock and live queries). This entry
 *   point opens a temporary `Store` on `adapter`, imports, and CLOSES the adapter.
 *
 * @param adapter - A storage adapter no store is using
 * @param schema - The schema definition
 * @param data - The backup data
 * @param options - Restore options
 */
export async function restoreBackup(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	data: Uint8Array,
	options?: RestoreOptions,
): Promise<RestoreResult> {
	const { Store } = await import('../store/store')
	const store = new Store({ schema, adapter })
	await store.open()
	try {
		return await store.importBackup(data, options)
	} finally {
		await store.close()
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function bytesReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Uint8Array) return { $bytes: toBase64(value) }
	return value
}

function bytesReviver(_key: string, value: unknown): unknown {
	if (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length === 1 &&
		typeof (value as { $bytes?: unknown }).$bytes === 'string'
	) {
		return fromBase64((value as { $bytes: string }).$bytes)
	}
	return value
}

function toBase64(bytes: Uint8Array): string {
	let binary = ''
	const CHUNK = 0x8000
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
	}
	return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}

async function computeSha256(data: Uint8Array): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', new Uint8Array(data))
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}
