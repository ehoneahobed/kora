import type { Operation, SchemaDefinition } from '@korajs/core'
import { deserializeOperationWithCollection } from '../serialization/serializer'
import type { StorageAdapter } from '../types'
import type { OperationRow } from '../types'
import { deserializeAuditJson, serializeAuditJson } from './audit-json'
import { readAuditTraces } from './audit-trace-store'
import type {
	AuditExportManifest,
	AuditExportOptions,
	AuditExportPayload,
	AuditTraceQuery,
	PersistedAuditTrace,
} from './types'

function encodeSection(name: string, content: Uint8Array): Uint8Array {
	const nameBytes = new TextEncoder().encode(name)
	const header = new Uint8Array(8)
	const view = new DataView(header.buffer)
	view.setUint32(0, nameBytes.length, true)
	view.setUint32(4, content.length, true)

	const result = new Uint8Array(header.length + nameBytes.length + content.length)
	result.set(header, 0)
	result.set(nameBytes, 8)
	result.set(content, 8 + nameBytes.length)
	return result
}

function encodeJsonSection(name: string, data: unknown): Uint8Array {
	return encodeSection(name, new TextEncoder().encode(serializeAuditJson(data)))
}

function encodeNdjsonSection(name: string, records: unknown[]): Uint8Array {
	const lines = `${records.map((record) => serializeAuditJson(record)).join('\n')}\n`
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
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
	let offset = 0

	while (offset + 8 <= data.byteLength) {
		const nameLen = readUint32(view, offset)
		const contentLen = readUint32(view, offset + 4)
		offset += 8

		if (offset + nameLen + contentLen > data.byteLength) {
			break
		}

		const name = new TextDecoder().decode(data.slice(offset, offset + nameLen))
		offset += nameLen

		const content = data.slice(offset, offset + contentLen)
		offset += contentLen

		sections.push({ name, content })
	}

	return sections
}

function findSection(sections: Section[], name: string): Uint8Array | null {
	for (const section of sections) {
		if (section.name === name) {
			return section.content
		}
	}
	return null
}

async function computeSha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data)
	return Array.from(new Uint8Array(hashBuffer))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

async function readAllOperations(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	collectionFilter?: string[],
): Promise<Operation[]> {
	const collections = collectionFilter
		? Object.keys(schema.collections).filter((name) => collectionFilter.includes(name))
		: Object.keys(schema.collections)

	const allOps: Operation[] = []
	for (const collectionName of collections) {
		const rows = await adapter.query<OperationRow>(
			`SELECT * FROM _kora_ops_${collectionName} ORDER BY sequence_number ASC`,
		)

		for (const row of rows) {
			allOps.push(deserializeOperationWithCollection(row, collectionName))
		}
	}

	return allOps
}

function filterOperationsByCollections(
	operations: Operation[],
	collectionFilter?: string[],
): Operation[] {
	if (!collectionFilter || collectionFilter.length === 0) {
		return operations
	}
	const allowed = new Set(collectionFilter)
	return operations.filter((op) => allowed.has(op.collection))
}

/**
 * Export operations and persisted merge traces as a portable binary audit bundle.
 */
export async function exportAudit(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	nodeId: string,
	schemaVersion: number,
	options?: AuditExportOptions,
): Promise<Uint8Array> {
	const onProgress = options?.onProgress ?? (() => {})
	const traceQuery: AuditTraceQuery = {
		collections: options?.collections,
		since: options?.since,
		until: options?.until,
	}

	onProgress({ phase: 'reading', progress: 0, message: 'Reading operations' })
	const operations = filterOperationsByCollections(
		await readAllOperations(adapter, schema, options?.collections),
		options?.collections,
	)

	onProgress({ phase: 'reading', progress: 0.4, message: 'Reading merge traces' })
	const mergeTraces = await readAuditTraces(adapter, traceQuery)

	onProgress({ phase: 'writing', progress: 0.7, message: 'Encoding audit export' })
	const sections: Uint8Array[] = []
	let contentForChecksum = new Uint8Array(0)

	const addSection = (section: Uint8Array): void => {
		sections.push(section)
		const combined = new Uint8Array(contentForChecksum.length + section.length)
		combined.set(contentForChecksum, 0)
		combined.set(section, contentForChecksum.length)
		contentForChecksum = combined
	}

	addSection(encodeNdjsonSection('operations', operations))
	addSection(encodeNdjsonSection('merge_traces', mergeTraces))

	onProgress({ phase: 'verifying', progress: 0.9, message: 'Computing checksum' })
	const checksum = await computeSha256(contentForChecksum as Uint8Array<ArrayBuffer>)

	const manifest: AuditExportManifest = {
		version: 1,
		exportedAt: Date.now(),
		nodeId,
		schemaVersion,
		operationCount: operations.length,
		mergeTraceCount: mergeTraces.length,
		checksum,
	}

	const manifestSection = encodeJsonSection('manifest', manifest)
	const checksumSection = encodeSection('checksum', new TextEncoder().encode(checksum))

	onProgress({ phase: 'writing', progress: 1, message: 'Finalizing' })

	const parts = [manifestSection, ...sections, checksumSection]
	const finalOutput = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let offset = 0
	for (const part of parts) {
		finalOutput.set(part, offset)
		offset += part.length
	}

	return finalOutput
}

/**
 * Decode an audit export binary into structured data.
 */
export function decodeAuditExport(data: Uint8Array): AuditExportPayload {
	const sections = parseSections(data)
	const manifest = JSON.parse(
		new TextDecoder().decode(findSection(sections, 'manifest') ?? new Uint8Array()),
	) as AuditExportManifest

	const operationsContent = findSection(sections, 'operations')
	const mergeTracesContent = findSection(sections, 'merge_traces')

	const operations = parseNdjsonSection<Operation>(operationsContent)
	const mergeTraces = parseNdjsonSection<PersistedAuditTrace>(mergeTracesContent)

	return { manifest, operations, mergeTraces }
}

/**
 * Read only the manifest from an audit export without decoding all sections.
 */
export function readAuditExportManifest(data: Uint8Array): AuditExportManifest {
	const sections = parseSections(data)
	const manifestContent = findSection(sections, 'manifest')
	if (!manifestContent) {
		throw new Error('Invalid audit export: missing manifest section')
	}
	return JSON.parse(new TextDecoder().decode(manifestContent)) as AuditExportManifest
}

/**
 * Verify the checksum of an audit export file.
 */
export async function verifyAuditExportChecksum(data: Uint8Array): Promise<boolean> {
	const sections = parseSections(data)
	const manifest = readAuditExportManifest(data)
	const contentSections = sections.filter(
		(section) => section.name !== 'manifest' && section.name !== 'checksum',
	)

	let content = new Uint8Array(0)
	for (const section of contentSections) {
		const encoded = encodeSection(section.name, section.content)
		const combined = new Uint8Array(content.length + encoded.length)
		combined.set(content, 0)
		combined.set(encoded, content.length)
		content = combined
	}

	const checksum = await computeSha256(content as Uint8Array<ArrayBuffer>)
	return checksum === manifest.checksum
}

function parseNdjsonSection<T>(content: Uint8Array | null): T[] {
	if (!content || content.length === 0) {
		return []
	}
	const text = new TextDecoder().decode(content).trim()
	if (text.length === 0) {
		return []
	}
	return text.split('\n').map((line) => deserializeAuditJson<T>(line))
}
