import {
	type KoraBytesValue,
	decodeBytesFromOpData,
	isKoraBytesValue,
	isLegacyNumericByteObject,
} from '@korajs/core'
import * as Y from 'yjs'

export type RichtextValue = string | Uint8Array | ArrayBuffer | KoraBytesValue | null | undefined

const TEXT_KEY = 'content'

/**
 * Merges richtext values using Yjs CRDT updates.
 */
export function mergeRichtext(
	localValue: RichtextValue,
	remoteValue: RichtextValue,
	baseValue: RichtextValue,
): Uint8Array {
	return Y.encodeStateAsUpdate(mergeIntoDoc(localValue, remoteValue, baseValue))
}

/** Result of {@link mergeRichtextUpdate}. */
export interface RichtextUpdateMerge {
	/** The merged state: exactly `mergeRichtext(local, remote, null)`. */
	merged: Uint8Array
	/**
	 * False when the merged document holds pending content: an update referenced
	 * content neither value contains (a delta whose base is missing), which Yjs keeps
	 * aside until it arrives. A merge that integrated everything is complete.
	 */
	complete: boolean
}

/**
 * {@link mergeRichtext} of two values without a base, also saying whether the merged
 * document is complete (see {@link RichtextUpdateMerge.complete}). For incremental
 * materialization: merging one more update onto a previous merge gives the same bytes
 * as merging the whole set from scratch when every merge involved was complete, but
 * Yjs may encode the same content differently when pending content is integrated in
 * a different grouping.
 *
 * @param localValue - A merged state (or any richtext value)
 * @param remoteValue - The update to merge onto it
 */
export function mergeRichtextUpdate(
	localValue: RichtextValue,
	remoteValue: RichtextValue,
): RichtextUpdateMerge {
	const doc = mergeIntoDoc(localValue, remoteValue, null)
	return {
		merged: Y.encodeStateAsUpdate(doc),
		complete: doc.store.pendingStructs === null && doc.store.pendingDs === null,
	}
}

function mergeIntoDoc(
	localValue: RichtextValue,
	remoteValue: RichtextValue,
	baseValue: RichtextValue,
): Y.Doc {
	const mergedDoc = new Y.Doc()

	Y.applyUpdate(mergedDoc, toYjsUpdate(baseValue))
	Y.applyUpdate(mergedDoc, toYjsUpdate(localValue))
	Y.applyUpdate(mergedDoc, toYjsUpdate(remoteValue))

	return mergedDoc
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

	// Richtext values arrive here straight from op.data / previousData, where
	// binary payloads are stored in the canonical tagged { $koraBytes } form (or,
	// for pre-fix dev databases, a numeric-key object). Decode either shape back
	// to Yjs update bytes. Without this, a concurrent richtext edit whose values
	// round-tripped through JSON would crash the merge engine.
	if (isKoraBytesValue(value) || isLegacyNumericByteObject(value)) {
		const decoded = decodeBytesFromOpData(value)
		return decoded instanceof Uint8Array ? decoded : stringToRichtextUpdate(decoded)
	}

	throw new Error(
		'Richtext value must be a string, Uint8Array, ArrayBuffer, tagged { $koraBytes } object, null, or undefined.',
	)
}
