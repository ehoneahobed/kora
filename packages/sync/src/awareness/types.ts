/**
 * Cursor position within a richtext field.
 * Uses Yjs-compatible anchor/head positions for editor interop.
 */
export interface AwarenessCursor {
	/** Collection containing the record being edited */
	collection: string
	/** ID of the record being edited */
	recordId: string
	/** Field name of the richtext field */
	field: string
	/** Cursor anchor position in Y.Text (start of selection) */
	anchor: number
	/** Cursor head position in Y.Text (end of selection, same as anchor if no selection) */
	head: number
}

/**
 * User identity information for presence display.
 */
export interface AwarenessUser {
	/** Display name of the user */
	name: string
	/** Hex color for cursor/selection rendering (e.g. '#ff0000') */
	color: string
	/** Optional avatar URL */
	avatar?: string
}

/**
 * Per-client awareness state. Ephemeral -- not persisted, only shared with connected peers.
 * Compatible with Yjs awareness protocol format for interop with existing editors.
 */
export interface AwarenessState {
	/** User identity information */
	user: AwarenessUser
	/** Current cursor position, if any */
	cursor?: AwarenessCursor
}

/**
 * Internal awareness message format used between AwarenessManager and transport layer.
 */
export interface AwarenessMessage {
	type: 'awareness'
	/** Client ID of the sender */
	clientId: number
	/** All known awareness states. null value means removal. */
	states: Record<number, AwarenessState | null>
}

/**
 * Describes a change in awareness states.
 * Emitted when remote clients update or remove their presence.
 */
export interface AwarenessChange {
	/** Client IDs whose states were added */
	added: number[]
	/** Client IDs whose states were updated */
	updated: number[]
	/** Client IDs whose states were removed */
	removed: number[]
}

/**
 * Cursor information for rendering in editors.
 * This is the developer-facing type -- simplified from internal awareness state.
 * Editor-agnostic: provides data that can be rendered by TipTap, ProseMirror, Quill, etc.
 */
export interface CursorInfo {
	/** Unique client ID */
	clientId: number
	/** User display name */
	userName: string
	/** Hex color for cursor rendering */
	color: string
	/** Cursor anchor position (start of selection) */
	anchor: number
	/** Cursor head position (end of selection) */
	head: number
}
