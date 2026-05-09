import type { OperationInput } from '../types'

/**
 * Compute the content-addressed ID for an operation using SHA-256.
 * The same operation content always produces the same hash, ensuring deduplication.
 *
 * @param input - The operation input (without id/timestamp, which are assigned separately)
 * @param timestamp - The HLC timestamp serialized as a string
 * @returns A hex-encoded SHA-256 hash
 */
export async function computeOperationId(
	input: OperationInput,
	timestamp: string,
): Promise<string> {
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
	const canonical = canonicalize(hashInput)
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
