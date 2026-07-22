import type {
	CausalTracker,
	CollectionDefinition,
	HybridLogicalClock,
	Operation,
	SchemaDefinition,
	SecretKeyProvider,
} from '@korajs/core'
import { executeDelete } from '../mutations/execute-delete'
import { executeInsert } from '../mutations/execute-insert'
import { executeUpdate } from '../mutations/execute-update'
import type { LocalMutationContext } from '../mutations/types'
import type { RelationEnforcer } from '../relations/relation-enforcer'
import { deserializeRecord } from '../serialization/serializer'
import type {
	CollectionRecord,
	LocalMutationHandler,
	RawCollectionRow,
	StorageAdapter,
} from '../types'

/**
 * Callback invoked after a mutation so the Store can notify subscriptions.
 */
export type MutationCallback = (collection: string, operation: Operation) => void

/**
 * Collection provides CRUD operations on a single schema collection.
 * Delegates to {@link LocalMutationHandler} when configured (unified apply pipeline),
 * otherwise uses shared mutation executors directly.
 */
export class Collection {
	constructor(
		private readonly name: string,
		private readonly definition: CollectionDefinition,
		private readonly schema: SchemaDefinition,
		private readonly adapter: StorageAdapter,
		private readonly clock: HybridLogicalClock,
		private readonly nodeId: string,
		private readonly allocateSequenceNumber: () => Promise<number>,
		private readonly onMutation: MutationCallback,
		private readonly relationEnforcer: RelationEnforcer | null,
		private mutationHandler: LocalMutationHandler | null,
		private readonly causalTracker: CausalTracker | null,
		private readonly secretKeyProvider?: SecretKeyProvider,
	) {}

	private mutationContext(): LocalMutationContext {
		return {
			collection: this.name,
			definition: this.definition,
			schema: this.schema,
			adapter: this.adapter,
			clock: this.clock,
			nodeId: this.nodeId,
			allocateSequenceNumber: this.allocateSequenceNumber,
			onMutation: this.onMutation,
			relationEnforcer: this.relationEnforcer,
			causalTracker: this.causalTracker,
			inTransaction: false,
			secretKeyProvider: this.secretKeyProvider,
		}
	}

	async insert(data: Record<string, unknown>): Promise<CollectionRecord> {
		if (this.mutationHandler) {
			return this.mutationHandler.insert(this.name, data)
		}
		return executeInsert(this.mutationContext(), data)
	}

	async findById(id: string): Promise<CollectionRecord | null> {
		const rows = await this.adapter.query<RawCollectionRow>(
			`SELECT * FROM ${this.name} WHERE id = ? AND _deleted = 0`,
			[id],
		)
		const row = rows[0]
		if (!row) return null
		return deserializeRecord(row, this.definition.fields)
	}

	async update(id: string, data: Record<string, unknown>): Promise<CollectionRecord> {
		if (this.mutationHandler) {
			return this.mutationHandler.update(this.name, id, data)
		}
		return executeUpdate(this.mutationContext(), id, data)
	}

	async delete(id: string): Promise<void> {
		if (this.mutationHandler) {
			await this.mutationHandler.delete(this.name, id)
			return
		}
		await executeDelete(this.mutationContext(), id)
	}

	getName(): string {
		return this.name
	}

	getDefinition(): CollectionDefinition {
		return this.definition
	}

	/** Replace the mutation handler (e.g. after ApplyPipeline is wired in createApp). */
	setMutationHandler(handler: LocalMutationHandler | null): void {
		this.mutationHandler = handler
	}
}
