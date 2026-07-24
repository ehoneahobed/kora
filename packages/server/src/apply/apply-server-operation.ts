import type { Operation } from '@korajs/core'
import { buildMergeRelationLookup, checkReferentialIntegrityOnDelete } from '@korajs/merge'
import type { ApplyResult } from '@korajs/sync'
import { validateIncomingOperationConstraints } from '../constraints/operation-constraint-validator'
import { createServerReferentialContext } from '../constraints/server-referential-context'
import type { ServerStore } from '../store/server-store'
import { type OperationRejection, isRetriableRejection } from './rejection-taxonomy'
import {
	createServerSideEffectOperation,
	nextServerSequenceNumber,
} from './server-side-effect-operation'

export interface ApplyServerOperationResult {
	/** Result of applying the primary operation */
	result: ApplyResult
	/** Primary op when applied, plus any server-generated side-effect operations */
	appliedOperations: Operation[]
	/** Rejection reason when the operation was not applied */
	rejection?: OperationRejection
}

/**
 * Applies an incoming client operation with Tier 2 constraints and referential integrity.
 * Cascade/set-null side effects are persisted as server-originated operations in the op log.
 */
export async function applyServerOperation(
	store: ServerStore,
	op: Operation,
	relationLookup?: ReturnType<typeof buildMergeRelationLookup>,
): Promise<ApplyServerOperationResult> {
	const schema = store.getSchema()
	const lookup = relationLookup ?? (schema ? buildMergeRelationLookup(schema) : new Map())

	const constraintCheck = await validateIncomingOperationConstraints(store, op, schema)
	if (!constraintCheck.valid) {
		const code = constraintCheck.code ?? 'CONSTRAINT_VIOLATION'
		return {
			result: 'skipped',
			appliedOperations: [],
			rejection: {
				code,
				message: constraintCheck.message ?? `Operation "${op.id}" violates a schema constraint`,
				retriable: isRetriableRejection(code),
			},
		}
	}

	if (op.type === 'delete' && schema) {
		const refCtx = createServerReferentialContext(store)
		const referential = await checkReferentialIntegrityOnDelete(op, schema, refCtx, lookup)

		if (!referential.allowed) {
			return {
				result: 'skipped',
				appliedOperations: [],
				rejection: {
					code: 'REFERENTIAL_INTEGRITY',
					message: `Operation "${op.id}" violates referential integrity on "${op.collection}"`,
					retriable: isRetriableRejection('REFERENTIAL_INTEGRITY'),
				},
			}
		}

		const primaryResult = await store.applyRemoteOperation(op)
		if (primaryResult !== 'applied') {
			return { result: primaryResult, appliedOperations: [] }
		}

		const appliedOperations: Operation[] = [op]

		for (const effect of referential.sideEffectOps) {
			// Allocate each side-effect's sequence number individually. On a store
			// that reserves atomically (Postgres), this keeps a concurrent conditional
			// apply from being handed the same server sequence number; on a serialized
			// store, each allocation reads the version vector the prior apply advanced.
			const sideOp = await createServerSideEffectOperation(
				store,
				op,
				effect,
				op.schemaVersion,
				nextServerSequenceNumber(store),
			)
			const sideResult = await store.applyRemoteOperation(sideOp)
			if (sideResult === 'applied') {
				appliedOperations.push(sideOp)
			}
		}

		return { result: 'applied', appliedOperations }
	}

	const result = await store.applyRemoteOperation(op)
	return {
		result,
		appliedOperations: result === 'applied' ? [op] : [],
	}
}
