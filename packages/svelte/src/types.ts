import type { KoraEventEmitter } from '@korajs/core'
import type { Store } from '@korajs/store'

/**
 * Minimal app handle type for Svelte context (matches `createApp()` from korajs).
 */
export interface KoraAppHandle {
	readonly ready: Promise<void>
	readonly events: KoraEventEmitter
	readonly sync: unknown
	close(): Promise<void>
	getStore(): Store
	[collection: string]: unknown
}
