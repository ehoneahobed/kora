import type { CollectionAccessor } from '../store/store'

/** User identity for collaborative cursor presence. */
export interface RichTextAwarenessUser {
	name: string
	color: string
	avatar?: string
}

/** Remote collaborator cursor for a richtext field. */
export interface RichTextCursorInfo {
	clientId: number
	userName: string
	color: string
	anchor: number
	head: number
}

/** Minimal sync surface required for richtext collaboration. */
export interface RichTextSyncEngine {
	getRichtextDocChannel?(): RichTextDocChannel
	getAwarenessManager(): RichTextAwarenessManager
}

export interface RichTextDocChannel {
	shouldUseChannel(snapshotBytes: number, useDocChannel?: boolean): boolean
	send(collection: string, recordId: string, field: string, update: Uint8Array): void
	subscribe(
		collection: string,
		recordId: string,
		field: string,
		listener: (update: Uint8Array) => void,
	): () => void
}

export interface RichTextAwarenessManager {
	clientId: number
	getLocalState(): RichTextAwarenessState | null
	setLocalState(state: RichTextAwarenessState): void
	getStates(): Map<number, RichTextAwarenessState>
	on(event: 'change', listener: () => void): () => void
}

export interface RichTextAwarenessState {
	user: RichTextAwarenessUser
	cursor?: {
		collection: string
		recordId: string
		field: string
		anchor: number
		head: number
	}
}

export interface CreateRichTextControllerOptions {
	collection: CollectionAccessor
	collectionName: string
	recordId: string
	fieldName: string
	store: { collection(name: string): CollectionAccessor }
	syncEngine?: RichTextSyncEngine | null
	useDocChannel?: boolean
	user?: RichTextAwarenessUser
}

export interface RichTextControllerSnapshot {
	ready: boolean
	error: Error | null
	canUndo: boolean
	canRedo: boolean
	cursors: readonly RichTextCursorInfo[]
}

export interface RichTextController {
	readonly doc: import('yjs').Doc
	readonly text: import('yjs').Text
	getSnapshot(): RichTextControllerSnapshot
	subscribe(listener: () => void): () => void
	undo(): void
	redo(): void
	setCursor(anchor: number, head: number): void
	clearCursor(): void
	setUser(user: RichTextAwarenessUser | undefined): void
	destroy(): void
}
