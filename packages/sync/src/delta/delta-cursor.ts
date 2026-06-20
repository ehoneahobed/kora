import type { DeltaCursor } from '../types'

export type { DeltaCursor }

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string): Uint8Array {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
	const binary = atob(padded)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}

/**
 * Encode a delta cursor for wire transfer or `_kora_meta` persistence.
 */
export function encodeDeltaCursor(cursor: DeltaCursor): string {
	const json = JSON.stringify(cursor)
	return bytesToBase64Url(new TextEncoder().encode(json))
}

/**
 * Decode a delta cursor string. Returns null when malformed.
 */
export function decodeDeltaCursor(value: string | undefined | null): DeltaCursor | null {
	if (!value) {
		return null
	}

	try {
		const json = new TextDecoder().decode(base64UrlToBytes(value))
		const parsed: unknown = JSON.parse(json)
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			typeof (parsed as DeltaCursor).lastOperationId !== 'string' ||
			typeof (parsed as DeltaCursor).batchIndex !== 'number'
		) {
			return null
		}
		return parsed as DeltaCursor
	} catch {
		return null
	}
}

/**
 * Slice a causally sorted operation list to resume after a cursor.
 */
export function sliceOperationsAfterCursor(
	operations: import('@korajs/core').Operation[],
	cursor: DeltaCursor | null,
): import('@korajs/core').Operation[] {
	if (!cursor) {
		return operations
	}

	const index = operations.findIndex((op) => op.id === cursor.lastOperationId)
	if (index === -1) {
		return operations
	}

	return operations.slice(index + 1)
}

/**
 * Build a cursor from the last operation in a delta batch.
 */
export function createDeltaCursorFromBatch(
	operations: import('@korajs/core').Operation[],
	batchIndex: number,
): DeltaCursor | null {
	const last = operations[operations.length - 1]
	if (!last) {
		return null
	}

	return {
		lastOperationId: last.id,
		batchIndex,
	}
}
