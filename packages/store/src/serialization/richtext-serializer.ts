import * as Y from 'yjs'

const TEXT_KEY = 'content'

export type RichtextInput = string | Uint8Array | ArrayBuffer | null | undefined

/**
 * Encodes richtext values into Yjs document updates.
 */
export function encodeRichtext(value: RichtextInput): Uint8Array | null {
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

	throw new Error('Richtext storage value must be Uint8Array, ArrayBuffer, Buffer, null, or undefined.')
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
