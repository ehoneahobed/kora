import type { KoraEventEmitter } from '@korajs/core'
import type { Store } from '@korajs/store'

/**
 * Minimal app handle type for Vue provide/inject (matches `createApp()` from korajs).
 * Use the full `KoraApp` / `TypedKoraApp` types from korajs in application code when available.
 */
export interface KoraAppHandle {
	readonly ready: Promise<void>
	readonly events: KoraEventEmitter
	readonly sync: unknown
	close(): Promise<void>
	getStore(): Store
	[collection: string]: unknown
}
