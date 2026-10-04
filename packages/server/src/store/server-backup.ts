import type { Operation } from '@korajs/core'
import { KoraError } from '@korajs/core'
import { validateKeyRecord } from '@korajs/sync'
import { assertBackupOperationsIngestible } from '../apply/ingest-validation'
import type { EncryptionKeyRecordRow, ServerStore } from './server-store'
import { SequenceConflictError } from './server-store'

/**
 * Server-side backup format: same portable section-based format as the client.
 *
 * Sections:
 *   manifest — metadata (version, nodeId, operationCount, checksum)
 *   version_vector — nodeId → maxSequenceNumber
 *   operations — NDJSON of full Operation objects
 *   encryption_keys — JSON array of the stored end-to-end key records (optional; RT-104)
 *   checksum — SHA-256 of all content sections
 *
 * A reader that predates `encryption_keys` ignores it. Without it, a server restored
 * from its backup would hold encrypted history but no key record to open it with.
 */

const BACKUP_VERSION = 1

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
	return encodeSection(name, new TextEncoder().encode(JSON.stringify(data)))
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

async function computeSha256(data: Uint8Array): Promise<string> {
	const digestInput = new Uint8Array(data)
	const hashBuffer = await crypto.subtle.digest('SHA-256', digestInput)
	const hashArray = Array.from(new Uint8Array(hashBuffer))
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Build a backup binary from server store data.
 */
export async function buildServerBackup(
	nodeId: string,
	operations: Operation[],
	versionVector: Map<string, number>,
	keyRecords: EncryptionKeyRecordRow[] = [],
): Promise<Uint8Array> {
	const sections: Uint8Array[] = []
	let allContentForChecksum = new Uint8Array(0)

	const addSection = (name: string, data: Uint8Array) => {
		sections.push(data)
		const newLen = allContentForChecksum.length + data.length
		const combined = new Uint8Array(newLen)
		combined.set(allContentForChecksum, 0)
		combined.set(data, allContentForChecksum.length)
		allContentForChecksum = combined
	}

	// Version vector
	const vvObj: Record<string, number> = {}
	for (const [nid, seq] of versionVector) {
		vvObj[nid] = seq
	}
	addSection('version_vector', encodeJsonSection('version_vector', vvObj))

	// Operations
	const opLines = `${operations.map((op) => JSON.stringify(op)).join('\n')}\n`
	addSection('operations', encodeSection('operations', new TextEncoder().encode(opLines)))

	// End-to-end key records (opaque: the server cannot open them)
	if (keyRecords.length > 0) {
		addSection('encryption_keys', encodeJsonSection('encryption_keys', keyRecords))
	}

	// Checksum
	const checksumHex = await computeSha256(allContentForChecksum)

	// Manifest
	const manifest = {
		version: BACKUP_VERSION,
		createdAt: Date.now(),
		nodeId,
		schemaVersion: 1,
		operationCount: operations.length,
		collections: [] as string[],
		includesRecords: false,
		encryptionKeyRecordCount: keyRecords.length,
		checksum: checksumHex,
	}

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
 * Parse a backup and return the operations, version vector and key records.
 */
export function parseServerBackup(data: Uint8Array): {
	operations: Operation[]
	versionVector: Map<string, number>
	keyRecords: EncryptionKeyRecordRow[]
} {
	const sections = parseSections(data)

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

	// Parse version vector
	const vvData = parseJsonSection<Record<string, number>>(sections, 'version_vector')
	const versionVector = new Map<string, number>()
	if (vvData) {
		for (const [nid, seq] of Object.entries(vvData)) {
			versionVector.set(nid, seq)
		}
	}

	// Every ingest path validates against server time (SYNC-7): a backup whose
	// operations are far-future or malformed is refused whole, before anything changes.
	assertBackupOperationsIngestible(operations)
	const keyRecords = parseKeyRecords(parseJsonSection<unknown>(sections, 'encryption_keys'))

	return { operations, versionVector, keyRecords }
}

/** Validate the `encryption_keys` section: a malformed entry refuses the whole backup. */
function parseKeyRecords(value: unknown): EncryptionKeyRecordRow[] {
	if (value === null || value === undefined) return []
	const refuse = (reason: string): never => {
		throw new KoraError(
			`Backup rejected: its encryption key records are malformed (${reason}).`,
			'BACKUP_INVALID_KEY_RECORD',
			{ reason },
		)
	}
	if (!Array.isArray(value)) return refuse('not an array')
	return value.map((entry: unknown, index): EncryptionKeyRecordRow => {
		if (typeof entry !== 'object' || entry === null) return refuse(`entry ${index}`)
		const { owner, keyring, revision, record } = entry as Record<string, unknown>
		if (typeof owner !== 'string' || typeof keyring !== 'string' || typeof record !== 'string') {
			return refuse(`entry ${index} fields`)
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(record)
		} catch {
			return refuse(`entry ${index} record is not JSON`)
		}
		const validation = validateKeyRecord(parsed, keyring)
		if (!validation.ok) return refuse(`entry ${index}: ${validation.reason}`)
		if ((parsed as { revision: unknown }).revision !== revision) {
			return refuse(`entry ${index} revision does not match its record`)
		}
		return { owner, keyring, revision: revision as number, record }
	})
}

/**
 * Restore backed-up key records (RT-104) that the store lacks. A record the store holds
 * is never replaced, whatever its revision: it is at least as new as the backup's copy
 * of the same ring (devices only move a ring forward), and a different ring there was
 * created after the loss and is merged by the devices holding both. Runs in both restore
 * modes: the key table is not part of the operation log.
 *
 * @returns The number of records restored
 */
export async function restoreBackupKeyRecords(
	store: Pick<ServerStore, 'putEncryptionKeyRecord'>,
	keyRecords: EncryptionKeyRecordRow[],
): Promise<number> {
	if (keyRecords.length === 0) return 0
	if (typeof store.putEncryptionKeyRecord !== 'function') {
		console.warn(
			`[kora] Backup restore: ${String(keyRecords.length)} encryption key record(s) were not restored: this store has no key table.`,
		)
		return 0
	}
	let restored = 0
	for (const row of keyRecords) {
		// expectedRevision 0: insert only where no record exists.
		if (await store.putEncryptionKeyRecord(row.owner, row.keyring, row.record, row.revision, 0)) {
			restored++
		}
	}
	return restored
}

/**
 * Merge-mode restore shared by the built-in stores: apply every backup operation
 * through the store's normal append (dedup by id). An operation refused for a
 * sequence conflict (another operation holds its node and sequence, W3 step 4) is
 * counted, not thrown, so the rest of the backup still restores; the result is then
 * `success: false` and the conflicts are logged, never silently dropped.
 */
export async function mergeBackupOperations(
	operations: Operation[],
	apply: (op: Operation) => Promise<string>,
): Promise<{ operationsRestored: number; success: boolean }> {
	let restored = 0
	const conflicts: string[] = []
	for (const op of operations) {
		try {
			if ((await apply(op)) === 'applied') restored++
		} catch (error) {
			if (!(error instanceof SequenceConflictError)) throw error
			conflicts.push(op.id)
		}
	}
	if (conflicts.length > 0) {
		console.warn(
			`[kora] Backup merge: ${String(conflicts.length)} operation(s) were not restored because another operation already holds their node and sequence number (SEQUENCE_CONFLICT). First: ${conflicts.slice(0, 5).join(', ')}`,
		)
	}
	return { operationsRestored: restored, success: conflicts.length === 0 }
}
