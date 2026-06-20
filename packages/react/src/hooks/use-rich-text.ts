import type { CollectionAccessor } from '@korajs/store'
import { encodeRichtext } from '@korajs/store'
import type { AwarenessState, AwarenessUser, CursorInfo } from '@korajs/sync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { useKoraContext } from '../context/kora-context'
import type { UseRichTextResult } from '../types'

const LOAD_ORIGIN = 'kora-load'
const REMOTE_ORIGIN = 'kora-remote'
const DOC_CHANNEL_ORIGIN = 'kora-doc-channel'
const TEXT_KEY = 'content'
const COMPACT_AFTER_DELTAS = 20
const PERSIST_DEBOUNCE_MS = 400

export interface UseRichTextOptions {
	/** Presence identity broadcast with cursor updates. */
	user?: AwarenessUser
	/**
	 * Use the incremental Yjs doc channel for live edits (recommended for large documents).
	 * When omitted, the channel activates automatically once the snapshot exceeds the sync threshold.
	 */
	useDocChannel?: boolean
}

/**
 * Binds a richtext field to a shared Yjs document for editor integration.
 */
export function useRichText(
	collectionName: string,
	recordId: string,
	fieldName: string,
	options?: UseRichTextOptions,
): UseRichTextResult {
	const { store, syncEngine } = useKoraContext()
	const collection = useMemo<CollectionAccessor>(
		() => store.collection(collectionName),
		[store, collectionName],
	)
	const [doc] = useState(() => new Y.Doc())
	const [ready, setReady] = useState(false)
	const [error, setError] = useState<Error | null>(null)
	const [canUndo, setCanUndo] = useState(false)
	const [canRedo, setCanRedo] = useState(false)
	const [cursors, setCursors] = useState<CursorInfo[]>([])
	const baseUpdateRef = useRef<Uint8Array | null>(null)
	const pendingDeltasRef = useRef<Uint8Array[]>([])
	const docChannelActiveRef = useRef(false)
	const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const userRef = useRef<AwarenessUser | undefined>(options?.user)

	useEffect(() => {
		userRef.current = options?.user
	}, [options?.user])

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

	const resolveAwarenessUser = useCallback((): AwarenessUser => {
		if (userRef.current) {
			return userRef.current
		}
		if (syncEngine) {
			const existing = syncEngine.getAwarenessManager().getLocalState()?.user
			if (existing) {
				return existing
			}
		}
		return {
			name: 'Anonymous',
			color: '#6366f1',
		}
	}, [syncEngine])

	const setCursor = useCallback(
		(anchor: number, head: number) => {
			if (!syncEngine) {
				return
			}

			const awareness = syncEngine.getAwarenessManager()
			const state: AwarenessState = {
				user: resolveAwarenessUser(),
				cursor: {
					collection: collectionName,
					recordId,
					field: fieldName,
					anchor,
					head,
				},
			}
			awareness.setLocalState(state)
		},
		[collectionName, fieldName, recordId, resolveAwarenessUser, syncEngine],
	)

	const clearCursor = useCallback(() => {
		if (!syncEngine) {
			return
		}

		const awareness = syncEngine.getAwarenessManager()
		const current = awareness.getLocalState()
		if (!current?.cursor) {
			return
		}
		if (
			current.cursor.collection !== collectionName ||
			current.cursor.recordId !== recordId ||
			current.cursor.field !== fieldName
		) {
			return
		}

		awareness.setLocalState({ user: current.user })
	}, [collectionName, fieldName, recordId, syncEngine])

	const applyRemoteSnapshot = useCallback(
		(value: unknown) => {
			const encoded = encodeRichtextInput(value)
			if (!encoded) {
				return
			}

			const currentSnapshot = Y.encodeStateAsUpdate(doc)
			if (updatesEqual(currentSnapshot, encoded)) {
				return
			}

			Y.applyUpdate(doc, encoded, REMOTE_ORIGIN)
			baseUpdateRef.current = encoded
			pendingDeltasRef.current = []
			syncHistoryState()
		},
		[doc, syncHistoryState],
	)

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

				const channel = syncEngine?.getRichtextDocChannel?.()
				docChannelActiveRef.current =
					channel?.shouldUseChannel(encoded?.length ?? 0, options?.useDocChannel) ?? false

				setReady(true)
			} catch (cause) {
				if (disposed) return
				setError(cause instanceof Error ? cause : new Error(String(cause)))
			}
		}

		const flushPersist = async (): Promise<void> => {
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

		const schedulePersist = (): void => {
			if (persistTimerRef.current) {
				clearTimeout(persistTimerRef.current)
			}
			persistTimerRef.current = setTimeout(() => {
				persistTimerRef.current = null
				void flushPersist()
			}, PERSIST_DEBOUNCE_MS)
		}

		const persist = (_update: Uint8Array, origin: unknown): void => {
			syncHistoryState()
			if (origin === LOAD_ORIGIN || origin === REMOTE_ORIGIN || origin === DOC_CHANNEL_ORIGIN) {
				return
			}

			pendingDeltasRef.current.push(_update)

			if (docChannelActiveRef.current && syncEngine) {
				syncEngine.getRichtextDocChannel().send(collectionName, recordId, fieldName, _update)
				schedulePersist()
				return
			}

			void flushPersist()
		}

		doc.on('update', persist)
		void initialize()

		syncHistoryState()

		return () => {
			disposed = true
			if (persistTimerRef.current) {
				clearTimeout(persistTimerRef.current)
				persistTimerRef.current = null
			}
			doc.off('update', persist)
			undoManager.destroy()
			baseUpdateRef.current = null
			pendingDeltasRef.current = []
			docChannelActiveRef.current = false
		}
	}, [
		collection,
		collectionName,
		doc,
		fieldName,
		options?.useDocChannel,
		recordId,
		syncEngine,
		syncHistoryState,
		undoManager,
	])

	// Incremental Yjs updates from the doc channel (large-document side path).
	useEffect(() => {
		if (!ready || !syncEngine || !docChannelActiveRef.current) {
			return
		}

		const channel = syncEngine.getRichtextDocChannel()
		return channel.subscribe(collectionName, recordId, fieldName, (update) => {
			Y.applyUpdate(doc, update, DOC_CHANNEL_ORIGIN)
			syncHistoryState()
		})
	}, [collectionName, doc, fieldName, ready, recordId, syncEngine, syncHistoryState])

	// Merge remote richtext writes from sync into the live Y.Doc.
	useEffect(() => {
		if (!ready) {
			return
		}

		const unsubscribe = store
			.collection(collectionName)
			.where({ id: recordId })
			.subscribe((results) => {
				const record = results[0]
				if (!record) {
					return
				}
				applyRemoteSnapshot(record[fieldName])
			})

		return unsubscribe
	}, [applyRemoteSnapshot, collectionName, fieldName, ready, recordId, store])

	// Track remote collaborators' cursors for this specific field.
	useEffect(() => {
		if (!syncEngine) return

		const awareness = syncEngine.getAwarenessManager()
		const localClientId = awareness.clientId

		const updateCursors = (): void => {
			const states = awareness.getStates()
			const fieldCursors: CursorInfo[] = []

			for (const [clientId, state] of states) {
				if (clientId === localClientId) continue
				if (!state.cursor) continue
				if (
					state.cursor.collection !== collectionName ||
					state.cursor.recordId !== recordId ||
					state.cursor.field !== fieldName
				) {
					continue
				}
				fieldCursors.push({
					clientId,
					userName: state.user.name,
					color: state.user.color,
					anchor: state.cursor.anchor,
					head: state.cursor.head,
				})
			}

			setCursors(fieldCursors)
		}

		const unsubscribe = awareness.on('change', () => {
			updateCursors()
		})

		updateCursors()

		return () => {
			unsubscribe()
			clearCursor()
		}
	}, [clearCursor, collectionName, fieldName, recordId, syncEngine])

	return { doc, text, undo, redo, canUndo, canRedo, ready, error, cursors, setCursor, clearCursor }
}

function encodeRichtextInput(value: unknown): Uint8Array | null {
	if (value === null || value === undefined) {
		return null
	}

	try {
		return encodeRichtext(value as Parameters<typeof encodeRichtext>[0])
	} catch {
		if (typeof value === 'string') {
			const fallbackDoc = new Y.Doc()
			fallbackDoc.getText(TEXT_KEY).insert(0, value)
			return Y.encodeStateAsUpdate(fallbackDoc)
		}
		throw new Error('Richtext record value must be a string, Uint8Array, ArrayBuffer, or null.')
	}
}

function composeRichtextSnapshot(base: Uint8Array | null, deltas: Uint8Array[]): Uint8Array {
	const mergedDoc = new Y.Doc()
	if (base) {
		Y.applyUpdate(mergedDoc, base)
	}

	for (const delta of deltas) {
		Y.applyUpdate(mergedDoc, delta)
	}

	return Y.encodeStateAsUpdate(mergedDoc)
}

function updatesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) {
		return false
	}
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) {
			return false
		}
	}
	return true
}
