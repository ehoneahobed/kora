import type { CausalTracker, CollectionDefinition } from '@korajs/core'
import type { MutationCallback } from '../collection/collection'
import type { StorageAdapter } from '../types'
import type { WriteEnv } from './write-context'

/**
 * Shared context for executing local collection mutations.
 *
 * Extends the {@link WriteEnv} of the single local write path with the target
 * collection and the post-commit plumbing. There is deliberately no way to
 * allocate a sequence number outside a write transaction: every local operation
 * reserves its number inside the transaction that persists it (W6).
 */
export interface LocalMutationContext extends WriteEnv {
	readonly collection: string
	readonly definition: CollectionDefinition
	readonly adapter: StorageAdapter
	/** Called once per committed operation, after the storage transaction commits. */
	readonly onMutation: MutationCallback
	readonly causalTracker: CausalTracker | null
	/** Additional parent op ids (e.g. referential cascade from a delete). */
	readonly extraCausalDeps?: string[]
	/**
	 * Called when a write transaction fails, before the error propagates (the
	 * store maps out-of-space errors to `store:quota-exceeded`).
	 */
	readonly onStorageError?: (error: unknown) => void
}
