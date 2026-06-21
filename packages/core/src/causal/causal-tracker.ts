/**
 * Tracks the latest operation per collection and within an open transaction
 * to populate {@link Operation.causalDeps} for local mutations.
 */
export class CausalTracker {
	private readonly lastOpIdByCollection = new Map<string, string>()
	private lastTransactionOpId: string | null = null

	/**
	 * Start a new transaction boundary. Clears in-transaction op ids.
	 */
	beginTransaction(): void {
		this.lastTransactionOpId = null
	}

	/**
	 * Clear the transaction boundary without recording ops (after rollback).
	 */
	clearTransaction(): void {
		this.lastTransactionOpId = null
	}

	/**
	 * Compute causal dependencies for the next operation in a collection.
	 * Uses direct parents only: collection head and the previous op in the open transaction.
	 */
	nextCausalDeps(collection: string, inTransaction: boolean): string[] {
		const deps: string[] = []
		const lastInCollection = this.lastOpIdByCollection.get(collection)
		if (lastInCollection !== undefined) {
			deps.push(lastInCollection)
		}
		if (inTransaction && this.lastTransactionOpId !== null) {
			if (!deps.includes(this.lastTransactionOpId)) {
				deps.push(this.lastTransactionOpId)
			}
		}
		return deps
	}

	/**
	 * Record an operation after it has been created and assigned an id.
	 */
	afterOperation(collection: string, operationId: string, inTransaction: boolean): void {
		this.lastOpIdByCollection.set(collection, operationId)
		if (inTransaction) {
			this.lastTransactionOpId = operationId
		}
	}
}
