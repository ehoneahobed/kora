import {
	type KoraBytesValue,
	base64ToBytes,
	bytesToBase64,
	decodeBytesFromOpData,
	encodeBytesForOpData,
	isKoraBytesValue,
	isLegacyNumericByteObject,
} from '@korajs/core'
import type { FieldDescriptor } from '@korajs/core'

/**
 * The canonical binary op-data encoding lives in `@korajs/core` because
 * `op.data` is a core concept shared by store (creation, persistence) and merge
 * (CRDT merge). These re-exports keep existing store-internal import paths
 * working while the single source of truth is the core module.
 */
export type { KoraBytesValue }
export { base64ToBytes, bytesToBase64, isKoraBytesValue, isLegacyNumericByteObject }

/** @deprecated Use {@link encodeRichtextForOpData}; kept for existing imports. */
export const encodeRichtextForOpData = encodeBytesForOpData
/** @deprecated Use {@link decodeRichtextOpDataValue}; kept for existing imports. */
export const decodeRichtextOpDataValue = decodeBytesFromOpData

/**
 * Apply {@link encodeBytesForOpData} to every richtext-typed field in an
 * operation's data payload. Called at operation creation, BEFORE the payload
 * is content-hashed, so the hash input, persisted JSON, wire payload, and the
 * value the merge engine sees are the identical canonical value. Non-richtext
 * fields are untouched.
 */
export function encodeRichtextFieldsForOpData(
	data: Record<string, unknown>,
	fields: Record<string, FieldDescriptor>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...data }
	for (const [key, value] of Object.entries(data)) {
		if (fields[key]?.kind !== 'richtext') {
			continue
		}
		if (typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer) {
			result[key] = encodeBytesForOpData(value)
		}
	}
	return result
}

/**
 * Reverse of {@link encodeRichtextFieldsForOpData}: decode tagged (or legacy
 * numeric-key) richtext values in an op-data payload back to record-shaped
 * values (string or Uint8Array). Null/undefined and plain strings pass
 * through, preserving pre-fix behavior exactly.
 */
export function decodeRichtextFieldsFromOpData(
	data: Record<string, unknown>,
	fields: Record<string, FieldDescriptor>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...data }
	for (const [key, value] of Object.entries(data)) {
		if (fields[key]?.kind !== 'richtext' || value === null || value === undefined) {
			continue
		}
		result[key] = decodeBytesFromOpData(value)
	}
	return result
}
