import type { Operation } from '@korajs/core'

/**
 * Server-side backup format: same portable section-based format as the client.
 *
 * Sections:
 *   manifest — metadata (version, nodeId, operationCount, checksum)
 *   version_vector — nodeId → maxSequenceNumber
 *   operations — NDJSON of full Operation objects
 *   checksum — SHA-256 of all content sections
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
	const hashBuffer = await crypto.subtle.digest('SHA-256', data)
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
 * Parse a backup and return the operations and version vector.
 */
export function parseServerBackup(data: Uint8Array): {
	operations: Operation[]
	versionVector: Map<string, number>
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

	return { operations, versionVector }
}
