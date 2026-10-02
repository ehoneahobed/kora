import { HybridLogicalClock } from '../clock/hlc'
import type { AtomicOp, HLCTimestamp, OperationInput } from '../types'
import { bytesToBase64 } from './op-data-binary'

/**
 * Content-hash versions for operation ids.
 *
 * - **1** (default until protocol v2 is wired): hashes type, collection, recordId,
 *   data, timestamp, nodeId and atomicOps. previousData, sequenceNumber,
 *   causalDeps and schemaVersion are NOT covered (CORE-1).
 * - **2**: additionally hashes previousData, sequenceNumber, causalDeps (as a
 *   set) and schemaVersion, with the version itself as a domain tag, and binary
 *   values in their canonical tagged form. Operations carry `hashVersion: 2`.
 */
export type OperationHashVersion = 1 | 2

/** Hash version new operations get until protocol v2 flips it to 2 (Stage B). */
export const DEFAULT_OPERATION_HASH_VERSION: OperationHashVersion = 1

/** The operation fields a content hash can cover. */
export interface HashableOperation {
	nodeId: string
	type: OperationInput['type']
	collection: string
	recordId: string
	data: Record<string, unknown> | null
	previousData: Record<string, unknown> | null
	timestamp: HLCTimestamp
	sequenceNumber: number
	causalDeps: readonly string[]
	schemaVersion: number
	atomicOps?: Record<string, AtomicOp>
}

/**
 * Compute the content-addressed ID for an operation using SHA-256.
 * The same operation content always produces the same hash, ensuring deduplication.
 *
 * Two call forms:
 * - `computeOperationId(input, serializedTimestamp)`: the version-1 hash (legacy
 *   form, used by the store's rebase and node-id rotation).
 * - `computeOperationId(op, version)`: the hash of the given version over a full
 *   operation (with its HLC timestamp).
 *
 * @returns A hex-encoded SHA-256 hash
 */
export async function computeOperationId(input: OperationInput, timestamp: string): Promise<string>
export async function computeOperationId(
	op: HashableOperation,
	version: OperationHashVersion,
): Promise<string>
export async function computeOperationId(
	input: OperationInput | HashableOperation,
	timestampOrVersion: string | OperationHashVersion,
): Promise<string> {
	if (typeof timestampOrVersion === 'string') {
		return sha256Hex(canonicalize(v1HashInput(input, timestampOrVersion)))
	}
	const op = input as HashableOperation
	const serializedTs = HybridLogicalClock.serialize(op.timestamp)
	if (timestampOrVersion === 1) return sha256Hex(canonicalize(v1HashInput(op, serializedTs)))
	return sha256Hex(canonicalize(v2HashInput(op, serializedTs)))
}

function v1HashInput(
	input: OperationInput | HashableOperation,
	timestamp: string,
): Record<string, unknown> {
	// Only include atomicOps when present — ensures backward compatibility
	// (existing operations without atomicOps produce identical hashes).
	const hashInput: Record<string, unknown> = {
		type: input.type,
		collection: input.collection,
		recordId: input.recordId,
		data: input.data,
		timestamp,
		nodeId: input.nodeId,
	}
	if (input.atomicOps !== undefined && Object.keys(input.atomicOps).length > 0) {
		hashInput.atomicOps = input.atomicOps
	}
	return hashInput
}

function v2HashInput(op: HashableOperation, timestamp: string): Record<string, unknown> {
	const atomicOps =
		op.atomicOps !== undefined && Object.keys(op.atomicOps).length > 0
			? canonicalBinary(op.atomicOps)
			: null
	return {
		hashVersion: 2,
		type: op.type,
		collection: op.collection,
		recordId: op.recordId,
		data: canonicalBinary(op.data),
		previousData: canonicalBinary(op.previousData),
		timestamp,
		nodeId: op.nodeId,
		sequenceNumber: op.sequenceNumber,
		// A set of parents: their order carries no meaning, so a relay that reorders
		// them neither breaks verification nor creates a second id for one op.
		causalDeps: [...op.causalDeps].sort(),
		schemaVersion: op.schemaVersion,
		atomicOps,
	}
}

/**
 * Binary values hash in their canonical op-log form (`{ $koraBytes: base64 }`), so
 * an op hashed before and after a JSON round-trip has one id.
 */
function canonicalBinary(value: unknown): unknown {
	if (value instanceof Uint8Array) return { $koraBytes: bytesToBase64(value) }
	if (value instanceof ArrayBuffer) return { $koraBytes: bytesToBase64(new Uint8Array(value)) }
	if (Array.isArray(value)) return value.map(canonicalBinary)
	if (typeof value === 'object' && value !== null) {
		const out: Record<string, unknown> = {}
		for (const [key, member] of Object.entries(value)) out[key] = canonicalBinary(member)
		return out
	}
	return value
}

async function sha256Hex(canonical: string): Promise<string> {
	const encoded = new TextEncoder().encode(canonical)
	const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', encoded)
	return bufferToHex(hashBuffer)
}

/**
 * Deterministic JSON serialization with sorted keys.
 * Ensures identical objects always produce identical strings regardless of property insertion order.
 *
 * @param obj - The value to serialize
 * @returns A deterministic JSON string
 */
export function canonicalize(obj: unknown): string {
	if (obj === null) {
		return 'null'
	}

	if (obj === undefined) {
		return 'null'
	}

	if (typeof obj !== 'object') {
		return JSON.stringify(obj)
	}

	if (Array.isArray(obj)) {
		const items = obj.map((item) => canonicalize(item))
		return `[${items.join(',')}]`
	}

	const keys = Object.keys(obj as Record<string, unknown>).sort()
	const pairs = keys.map((key) => {
		const value = (obj as Record<string, unknown>)[key]
		// Serialize undefined values as null for deterministic output
		return `${JSON.stringify(key)}:${canonicalize(value === undefined ? null : value)}`
	})
	return `{${pairs.join(',')}}`
}

function bufferToHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
