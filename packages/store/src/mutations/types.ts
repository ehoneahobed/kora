import type {
	CausalTracker,
	CollectionDefinition,
	HybridLogicalClock,
	SchemaDefinition,
} from '@korajs/core'
import type { MutationCallback } from '../collection/collection'
import type { RelationEnforcer } from '../relations/relation-enforcer'
import type { StorageAdapter } from '../types'

/**
 * Shared context for executing local collection mutations.
 */
export interface LocalMutationContext {
	readonly collection: string
	readonly definition: CollectionDefinition
	readonly schema: SchemaDefinition
	readonly adapter: StorageAdapter
	readonly clock: HybridLogicalClock
	readonly nodeId: string
	readonly allocateSequenceNumber: () => Promise<number>
	readonly onMutation: MutationCallback
	readonly relationEnforcer: RelationEnforcer | null
	readonly causalTracker: CausalTracker | null
	readonly inTransaction: boolean
	/** Additional parent op ids (e.g. referential cascade from a delete). */
	readonly extraCausalDeps?: string[]
}
