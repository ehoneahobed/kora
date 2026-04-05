import type { CollectionAccessor } from '@kora/store'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { useKoraContext } from '../context/kora-context'
import type { UseRichTextResult } from '../types'

const LOAD_ORIGIN = 'kora-load'
const TEXT_KEY = 'content'
const COMPACT_AFTER_DELTAS = 20

/**
 * Binds a richtext field to a shared Yjs document for editor integration.
 */
export function useRichText(
	collectionName: string,
	recordId: string,
	fieldName: string,
): UseRichTextResult {
	const { store } = useKoraContext()
	const collection = useMemo<CollectionAccessor>(() => store.collection(collectionName), [store, collectionName])
	const [doc] = useState(() => new Y.Doc())
	const [ready, setReady] = useState(false)
	const [error, setError] = useState<Error | null>(null)
	const [canUndo, setCanUndo] = useState(false)
	const [canRedo, setCanRedo] = useState(false)
	const baseUpdateRef = useRef<Uint8Array | null>(null)
	const pendingDeltasRef = useRef<Uint8Array[]>([])

	const text = useMemo(() => doc.getText(TEXT_KEY), [doc])
	const undoManager = useMemo(() => new Y.UndoManager(text), [text])

	const syncHistoryState = useCallback(() => {
		setCanUndo(undoManager.undoStack.length > 0)
		setCanRedo(undoManager.redoStack.length > 0)
	}, [undoManager])

	const undo = useCallback(() => {
		undoManager.undo()
		syncHistoryState()
	}, [syncHistoryState, undoManager])

	const redo = useCallback(() => {
		undoManager.redo()
		syncHistoryState()
	}, [syncHistoryState, undoManager])

	useEffect(() => {
		let disposed = false

		const initialize = async (): Promise<void> => {
			setReady(false)
			setError(null)

			try {
				const record = await collection.findById(recordId)
				if (disposed) return

				doc.transact(() => {
					const target = doc.getText(TEXT_KEY)
					target.delete(0, target.length)
				}, LOAD_ORIGIN)

				const encoded = encodeRichtextInput(record?.[fieldName])
				baseUpdateRef.current = encoded
				pendingDeltasRef.current = []
				if (encoded) {
					Y.applyUpdate(doc, encoded, LOAD_ORIGIN)
				}

				setReady(true)
			} catch (cause) {
				if (disposed) return
				setError(cause instanceof Error ? cause : new Error(String(cause)))
			}
		}

		const persist = async (_update: Uint8Array, origin: unknown): Promise<void> => {
			syncHistoryState()
			if (origin === LOAD_ORIGIN) {
				return
			}

			pendingDeltasRef.current.push(_update)
			const snapshot = composeRichtextSnapshot(baseUpdateRef.current, pendingDeltasRef.current)

			if (pendingDeltasRef.current.length >= COMPACT_AFTER_DELTAS) {
				baseUpdateRef.current = snapshot
				pendingDeltasRef.current = []
			}

			try {
				await collection.update(recordId, {
					[fieldName]: snapshot,
				})
			} catch (cause) {
				if (!disposed) {
					setError(cause instanceof Error ? cause : new Error(String(cause)))
				}
			}
		}

		doc.on('update', persist)
		void initialize()

		syncHistoryState()

		return () => {
			disposed = true
			doc.off('update', persist)
			undoManager.destroy()
			baseUpdateRef.current = null
			pendingDeltasRef.current = []
		}
	}, [collection, doc, fieldName, recordId, syncHistoryState, undoManager])

	return { doc, text, undo, redo, canUndo, canRedo, ready, error }
}

function encodeRichtextInput(value: unknown): Uint8Array | null {
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

	if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
		return new Uint8Array(value)
	}

	throw new Error('Richtext record value must be a string, Uint8Array, ArrayBuffer, or null.')
}

function composeRichtextSnapshot(base: Uint8Array | null, deltas: Uint8Array[]): Uint8Array {
	const doc = new Y.Doc()
	if (base) {
		Y.applyUpdate(doc, base)
	}

	for (const delta of deltas) {
		Y.applyUpdate(doc, delta)
	}

	return Y.encodeStateAsUpdate(doc)
}
