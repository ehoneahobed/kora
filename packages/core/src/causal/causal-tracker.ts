/**
 * Tracks the latest operation per collection and within an open transaction
 * to populate {@link Operation.causalDeps} for local mutations.
 */
export class CausalTracker {
	private readonly lastOpIdByCollection = new Map<string, string>()
	private lastTransactionOpId: string | null = null
	private holding: Promise<void> | null = null

	/**
	 * Hold new local writes back while operation ids are rewritten (a clock rebase): until the
	 * returned release is called, {@link settling} is a promise writes wait on before they start
	 * their storage transaction, so none builds causalDeps from heads the rewrite may still
	 * change or undo.
	 *
	 * @returns The release (idempotent)
	 */
	hold(): () => void {
		let release: () => void = () => {}
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		this.holding = held
		return () => {
			if (this.holding === held) this.holding = null
			release()
		}
	}

	/** A promise to wait on while a rewrite holds writes back, or null when none does. */
	get settling(): Promise<void> | null {
		return this.holding
	}

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
	 * Follow operations that were rewritten under new ids (a clock rebase): every head that
	 * names an old id names its new one, so the next write depends on an operation that
	 * still exists.
	 *
	 * @param idMapping - Old operation id to new operation id
	 * @returns A function that puts the replaced heads back (when the rewrite did not commit).
	 *   A head that changed again since is left alone.
	 */
	remapIds(idMapping: Readonly<Record<string, string>>): () => void {
		const replaced: Array<[collection: string, previous: string, next: string]> = []
		for (const [collection, id] of this.lastOpIdByCollection) {
			const next = idMapping[id]
			if (next === undefined) continue
			this.lastOpIdByCollection.set(collection, next)
			replaced.push([collection, id, next])
		}
		const previousTransactionOp = this.lastTransactionOpId
		if (previousTransactionOp !== null) {
			this.lastTransactionOpId = idMapping[previousTransactionOp] ?? previousTransactionOp
		}
		const transactionOp = this.lastTransactionOpId
		return () => {
			for (const [collection, previous, next] of replaced) {
				if (this.lastOpIdByCollection.get(collection) === next) {
					this.lastOpIdByCollection.set(collection, previous)
				}
			}
			if (this.lastTransactionOpId === transactionOp)
				this.lastTransactionOpId = previousTransactionOp
		}
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
