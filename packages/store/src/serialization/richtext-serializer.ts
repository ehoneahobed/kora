import * as Y from 'yjs'
import {
	type KoraBytesValue,
	decodeRichtextOpDataValue,
	isKoraBytesValue,
	isLegacyNumericByteObject,
} from './op-data-encoding'

const TEXT_KEY = 'content'

export type RichtextInput = string | Uint8Array | ArrayBuffer | null | undefined

/**
 * Encodes richtext values into Yjs document updates.
 *
 * Also accepts the tagged `{ $koraBytes }` form that binary richtext values
 * take inside `op.data` (and, for old dev databases, the pre-fix numeric-key
 * object shape), so every consumer that writes op-data values to columns
 * inherits the decoding. Plain strings keep their exact historical behavior:
 * encoded as a fresh Yjs document containing the string.
 */
export function encodeRichtext(value: RichtextInput | KoraBytesValue): Uint8Array | null {
	if (value === null || value === undefined) {
		return null
	}

	if (typeof value === 'string') {
		const doc = new Y.Doc()
		doc.getText(TEXT_KEY).insert(0, value)
		return Y.encodeStateAsUpdate(doc)
	}

	if (value instanceof Uint8Array) {
		return value
	}

	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value)
	}

	if (isKoraBytesValue(value) || isLegacyNumericByteObject(value)) {
		const decoded = decodeRichtextOpDataValue(value)
		// Both accepted shapes decode to bytes; strings were handled above.
		return decoded instanceof Uint8Array ? decoded : null
	}

	throw new Error('Richtext value must be a string, Uint8Array, ArrayBuffer, null, or undefined.')
}

/**
 * Decodes driver-provided richtext values into Uint8Array.
 */
export function decodeRichtext(value: unknown): Uint8Array | null {
	if (value === null || value === undefined) {
		return null
	}

	if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
		return new Uint8Array(value)
	}

	if (value instanceof Uint8Array) {
		return value
	}

	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value)
	}

	throw new Error(
		'Richtext storage value must be Uint8Array, ArrayBuffer, Buffer, null, or undefined.',
	)
}

/**
 * Reads plain text from a richtext Yjs state update.
 */
export function richtextToPlainText(value: RichtextInput): string {
	const encoded = encodeRichtext(value)
	if (!encoded) return ''

	const doc = new Y.Doc()
	Y.applyUpdate(doc, encoded)
	return doc.getText(TEXT_KEY).toString()
}

/**
 * Compares two richtext values by decoded plain text.
 * Yjs update bytes are not stable across separate encodes of the same string.
 */
export function richtextStatesEqual(a: unknown, b: unknown): boolean {
	try {
		return richtextToPlainText(a as RichtextInput) === richtextToPlainText(b as RichtextInput)
	} catch {
		return false
	}
}
