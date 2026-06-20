import { generateUUIDv7 } from '@korajs/core'
import type { YjsDocUpdateMessage } from '../protocol/messages'
import { decodeYjsUpdate, encodeYjsUpdate, richtextDocKey } from './doc-channel-wire'

/** Default snapshot size above which the doc channel is preferred. */
export const DEFAULT_RICHTEXT_DOC_CHANNEL_THRESHOLD = 4096

export type RichtextDocListener = (update: Uint8Array) => void

export interface RichtextDocChannelOptions {
	/** Snapshot byte length at which incremental channel sync is recommended. */
	largeDocThreshold?: number
	/** Called when a local update should be sent on the wire. */
	onSend?: (message: YjsDocUpdateMessage) => void
}

/**
 * Side channel for incremental Yjs updates on large richtext fields.
 * Ephemeral — not persisted in the operation log (durable state still flows via ops).
 */
export class RichtextDocChannel {
	private readonly threshold: number
	private readonly onSend: ((message: YjsDocUpdateMessage) => void) | null
	private readonly listeners = new Map<string, Set<RichtextDocListener>>()

	constructor(options?: RichtextDocChannelOptions) {
		this.threshold = options?.largeDocThreshold ?? DEFAULT_RICHTEXT_DOC_CHANNEL_THRESHOLD
		this.onSend = options?.onSend ?? null
	}

	/**
	 * Whether the doc channel should be used for a field.
	 * @param preference - `true` forces on, `false` forces off, `undefined` uses size threshold
	 */
	shouldUseChannel(snapshotByteLength: number, preference?: boolean): boolean {
		if (preference === false) {
			return false
		}
		if (preference === true) {
			return true
		}
		return snapshotByteLength >= this.threshold
	}

	getThreshold(): number {
		return this.threshold
	}

	/**
	 * Subscribe to incremental updates for a document key.
	 */
	subscribe(
		collection: string,
		recordId: string,
		field: string,
		listener: RichtextDocListener,
	): () => void {
		const key = richtextDocKey(collection, recordId, field)
		let set = this.listeners.get(key)
		if (!set) {
			set = new Set()
			this.listeners.set(key, set)
		}
		set.add(listener)

		return () => {
			const current = this.listeners.get(key)
			if (!current) {
				return
			}
			current.delete(listener)
			if (current.size === 0) {
				this.listeners.delete(key)
			}
		}
	}

	/**
	 * Publish a local incremental update to peers.
	 */
	send(collection: string, recordId: string, field: string, update: Uint8Array): void {
		if (!this.onSend || update.length === 0) {
			return
		}

		this.onSend({
			type: 'yjs-doc-update',
			messageId: generateUUIDv7(),
			collection,
			recordId,
			field,
			update: encodeYjsUpdate(update),
		})
	}

	/**
	 * Deliver a remote incremental update to local subscribers.
	 */
	deliver(message: YjsDocUpdateMessage): void {
		const key = richtextDocKey(message.collection, message.recordId, message.field)
		const set = this.listeners.get(key)
		if (!set || set.size === 0) {
			return
		}

		const update = decodeYjsUpdate(message.update)
		for (const listener of set) {
			listener(update)
		}
	}
}
