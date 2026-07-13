import * as Y from 'yjs'
import { encodeRichtext } from '../serialization/richtext-serializer'
import type {
	CreateRichTextControllerOptions,
	RichTextAwarenessState,
	RichTextAwarenessUser,
	RichTextController,
	RichTextControllerSnapshot,
	RichTextCursorInfo,
} from './types'

const LOAD_ORIGIN = 'kora-load'
const REMOTE_ORIGIN = 'kora-remote'
const DOC_CHANNEL_ORIGIN = 'kora-doc-channel'
const TEXT_KEY = 'content'
const COMPACT_AFTER_DELTAS = 20
const PERSIST_DEBOUNCE_MS = 400

/**
 * Framework-agnostic richtext binding: Yjs document lifecycle, persistence,
 * incremental doc channel, and awareness cursors.
 */
export function createRichTextController(
	options: CreateRichTextControllerOptions,
): RichTextController {
	const {
		collection,
		collectionName,
		recordId,
		fieldName,
		store,
		syncEngine = null,
		useDocChannel,
	} = options

	const doc = new Y.Doc()
	const text = doc.getText(TEXT_KEY)
	const undoManager = new Y.UndoManager(text)

	let user = options.user
	let disposed = false
	let ready = false
	let error: Error | null = null
	let canUndo = false
	let canRedo = false
	let cursors: RichTextCursorInfo[] = []

	const listeners = new Set<() => void>()
	let snapshot: RichTextControllerSnapshot = {
		ready: false,
		error: null,
		canUndo: false,
		canRedo: false,
		cursors: [],
	}
	const baseUpdateRef = { current: null as Uint8Array | null }
	const pendingDeltasRef = { current: [] as Uint8Array[] }
	const docChannelActiveRef = { current: false }
	let persistTimer: ReturnType<typeof setTimeout> | null = null

	let recordUnsubscribe: (() => void) | null = null
	let docChannelUnsubscribe: (() => void) | null = null
	let awarenessUnsubscribe: (() => void) | null = null

	const refreshSnapshot = (): void => {
		snapshot = {
			ready,
			error,
			canUndo,
			canRedo,
			cursors: [...cursors],
		}
	}

	const notify = (): void => {
		refreshSnapshot()
		for (const listener of listeners) {
			listener()
		}
	}

	const syncHistoryState = (): void => {
		canUndo = undoManager.undoStack.length > 0
		canRedo = undoManager.redoStack.length > 0
		notify()
	}

	const getSnapshot = (): RichTextControllerSnapshot => snapshot

	const resolveAwarenessUser = (): RichTextAwarenessUser => {
		if (user) {
			return user
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
	}

	const setCursor = (anchor: number, head: number): void => {
		if (!syncEngine) {
			return
		}

		const awareness = syncEngine.getAwarenessManager()
		const state: RichTextAwarenessState = {
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
	}

	const clearCursor = (): void => {
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
	}

	const applyRemoteSnapshot = (value: unknown): void => {
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
				error = cause instanceof Error ? cause : new Error(String(cause))
				notify()
			}
		}
	}

	const schedulePersist = (): void => {
		if (persistTimer) {
			clearTimeout(persistTimer)
		}
		persistTimer = setTimeout(() => {
			persistTimer = null
			void flushPersist()
		}, PERSIST_DEBOUNCE_MS)
	}

	const onDocUpdate = (update: Uint8Array, origin: unknown): void => {
		syncHistoryState()
		if (origin === LOAD_ORIGIN || origin === REMOTE_ORIGIN || origin === DOC_CHANNEL_ORIGIN) {
			return
		}

		pendingDeltasRef.current.push(update)

		if (docChannelActiveRef.current && syncEngine) {
			syncEngine.getRichtextDocChannel?.().send(collectionName, recordId, fieldName, update)
			schedulePersist()
			return
		}

		void flushPersist()
	}

	const subscribeRecordChanges = (): void => {
		recordUnsubscribe?.()
		recordUnsubscribe = store
			.collection(collectionName)
			.where({ id: recordId })
			.subscribe((results) => {
				const record = results[0]
				if (!record) {
					return
				}
				applyRemoteSnapshot(record[fieldName])
			})
	}

	const subscribeDocChannel = (): void => {
		docChannelUnsubscribe?.()
		if (!ready || !syncEngine || !docChannelActiveRef.current) {
			return
		}

		const channel = syncEngine.getRichtextDocChannel?.()
		if (!channel) {
			return
		}

		docChannelUnsubscribe = channel.subscribe(collectionName, recordId, fieldName, (update) => {
			Y.applyUpdate(doc, update, DOC_CHANNEL_ORIGIN)
			syncHistoryState()
		})
	}

	const updateCursors = (): void => {
		if (!syncEngine) {
			cursors = []
			notify()
			return
		}

		const awareness = syncEngine.getAwarenessManager()
		const localClientId = awareness.clientId
		const states = awareness.getStates()
		const fieldCursors: RichTextCursorInfo[] = []

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

		cursors = fieldCursors
		notify()
	}

	const subscribeAwareness = (): void => {
		awarenessUnsubscribe?.()
		if (!syncEngine) {
			cursors = []
			notify()
			return
		}

		const awareness = syncEngine.getAwarenessManager()
		awarenessUnsubscribe = awareness.on('change', () => {
			updateCursors()
		})
		updateCursors()
	}

	const initialize = async (): Promise<void> => {
		ready = false
		error = null
		notify()

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
				channel?.shouldUseChannel(encoded?.length ?? 0, useDocChannel) ?? false

			ready = true
			syncHistoryState()
			subscribeRecordChanges()
			subscribeDocChannel()
			subscribeAwareness()
			notify()
		} catch (cause) {
			if (disposed) return
			error = cause instanceof Error ? cause : new Error(String(cause))
			notify()
		}
	}

	doc.on('update', onDocUpdate)
	void initialize()

	return {
		doc,
		text,
		getSnapshot,
		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		undo() {
			undoManager.undo()
			syncHistoryState()
		},
		redo() {
			undoManager.redo()
			syncHistoryState()
		},
		setCursor,
		clearCursor,
		setUser(nextUser: RichTextAwarenessUser | undefined) {
			user = nextUser
		},
		destroy() {
			if (disposed) {
				return
			}
			disposed = true
			if (persistTimer) {
				clearTimeout(persistTimer)
				persistTimer = null
			}
			doc.off('update', onDocUpdate)
			recordUnsubscribe?.()
			docChannelUnsubscribe?.()
			awarenessUnsubscribe?.()
			clearCursor()
			undoManager.destroy()
			baseUpdateRef.current = null
			pendingDeltasRef.current = []
			docChannelActiveRef.current = false
			listeners.clear()
		},
	}
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
