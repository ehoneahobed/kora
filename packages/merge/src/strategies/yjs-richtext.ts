import * as Y from 'yjs'

export type RichtextValue = string | Uint8Array | ArrayBuffer | null | undefined

const TEXT_KEY = 'content'

/**
 * Merges richtext values using Yjs CRDT updates.
 */
export function mergeRichtext(
	localValue: RichtextValue,
	remoteValue: RichtextValue,
	baseValue: RichtextValue,
): Uint8Array {
	const mergedDoc = new Y.Doc()

	Y.applyUpdate(mergedDoc, toYjsUpdate(baseValue))
	Y.applyUpdate(mergedDoc, toYjsUpdate(localValue))
	Y.applyUpdate(mergedDoc, toYjsUpdate(remoteValue))

	return Y.encodeStateAsUpdate(mergedDoc)
}

/**
 * Converts a richtext state update to plain text.
 */
export function richtextToString(value: RichtextValue): string {
	const doc = new Y.Doc()
	Y.applyUpdate(doc, toYjsUpdate(value))
	return doc.getText(TEXT_KEY).toString()
}

/**
 * Converts a plain string to a Yjs state update.
 */
export function stringToRichtextUpdate(value: string): Uint8Array {
	const doc = new Y.Doc()
	doc.getText(TEXT_KEY).insert(0, value)
	return Y.encodeStateAsUpdate(doc)
}

function toYjsUpdate(value: RichtextValue): Uint8Array {
	if (value === null || value === undefined) {
		return Y.encodeStateAsUpdate(new Y.Doc())
	}

	if (typeof value === 'string') {
		return stringToRichtextUpdate(value)
	}

	if (value instanceof Uint8Array) {
		return value
	}

	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value)
	}

	throw new Error('Richtext value must be a string, Uint8Array, ArrayBuffer, null, or undefined.')
}
