import type { Operation } from '@korajs/core'
import { buildMergeRelationLookup, checkReferentialIntegrityOnDelete } from '@korajs/merge'
import type { ApplyResult } from '@korajs/sync'
import { validateIncomingOperationConstraints } from '../constraints/operation-constraint-validator'
import { createServerReferentialContext } from '../constraints/server-referential-context'
import type { ServerStore } from '../store/server-store'
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
	rejection?: {
		code: string
		message: string
	}
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
		return {
			result: 'skipped',
			appliedOperations: [],
			rejection: {
				code: constraintCheck.code ?? 'CONSTRAINT_VIOLATION',
				message: constraintCheck.message ?? `Operation "${op.id}" violates a schema constraint`,
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
				},
			}
		}

		const primaryResult = await store.applyRemoteOperation(op)
		if (primaryResult !== 'applied') {
			return { result: primaryResult, appliedOperations: [] }
		}

		const appliedOperations: Operation[] = [op]
		let serverSeq = nextServerSequenceNumber(store)

		for (const effect of referential.sideEffectOps) {
			const sideOp = await createServerSideEffectOperation(
				store,
				op,
				effect,
				op.schemaVersion,
				serverSeq,
			)
			serverSeq += 1
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
