import type { Operation } from '@korajs/core'
import { buildMergeRelationLookup, checkReferentialIntegrityOnDelete } from '@korajs/merge'
import type { ApplyResult } from '@korajs/sync'
import { validateIncomingOperationConstraints } from '../constraints/operation-constraint-validator'
import { createServerReferentialContext } from '../constraints/server-referential-context'
import {
	UplinkAuthorizationError,
	type UplinkAuthorizationResult,
} from '../scopes/server-scope-filter'
import type { ApplyRemoteOptions, MaterializedRecord, ServerStore } from '../store/server-store'
import { SEQUENCE_CONFLICT_CODE, SequenceConflictError } from '../store/server-store'
import { validateIngestedOperation } from './ingest-validation'
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
 * Decides whether an untrusted writer may cause one referential side effect of its
 * delete. `effect` is the side effect shaped as the operation the server would
 * write; `stored` is the affected record as stored now (including soft-deleted).
 */
export type SideEffectAuthorizer = (
	effect: Operation,
	stored: MaterializedRecord | null,
) => UplinkAuthorizationResult

/** Rejection code for a delete refused because of related records (RT-10). */
export const RESTRICTED_REJECTION_CODE = 'RESTRICTED'

/** Options for {@link applyServerOperation}. */
export interface ApplyServerOperationOptions {
	/**
	 * Uplink authorization for an untrusted writer, re-evaluated by the store inside
	 * its apply critical section against the row as stored at commit time (see
	 * `ApplyRemoteOptions.authorize`). A refusal becomes a non-retriable rejection and
	 * nothing is written.
	 */
	authorize?: ApplyRemoteOptions['authorize']
	/**
	 * Authorization of the referential side effects (cascade delete, set-null) an
	 * untrusted writer's delete would cause (RT-10). Every side effect is checked
	 * against the writer's own scope BEFORE the delete is applied; if any falls
	 * outside it, the whole delete is refused and nothing is written.
	 *
	 * Design: integrity is judged on ALL children, in every tenant (a restrict or a
	 * cross-tenant cascade is never silently skipped, which would leave dangling
	 * references), but the writer learns nothing about children it cannot see: a
	 * restrict violation and an unauthorized side effect are refused with the same
	 * generic `RESTRICTED` rejection, with no ids and no counts. Setting `authorize`
	 * alone also switches restrict refusals to the generic form.
	 */
	authorizeSideEffect?: SideEffectAuthorizer
}

/**
 * Applies an incoming client operation with Tier 2 constraints and referential integrity.
 * Cascade/set-null side effects are persisted as server-originated operations in the op log.
 *
 * @param store - The server store
 * @param op - The operation to apply
 * @param relationLookup - Optional precomputed relation lookup
 * @param options - Optional in-store authorization for untrusted writers
 * @returns The apply result, applied operations, and rejection (if any)
 */
export async function applyServerOperation(
	store: ServerStore,
	op: Operation,
	relationLookup?: ReturnType<typeof buildMergeRelationLookup>,
	options: ApplyServerOperationOptions = {},
): Promise<ApplyServerOperationResult> {
	// Every ingest path (sync, route kora.apply, applyLocalOperation) validates the
	// timestamp against server time and the sequence number (SYNC-7, SRV-4).
	const ingest = validateIngestedOperation(op)
	if (!ingest.valid) {
		return {
			result: 'skipped',
			appliedOperations: [],
			rejection: { code: ingest.code, message: ingest.message, retriable: false },
		}
	}

	const schema = store.getSchema()
	const lookup = relationLookup ?? (schema ? buildMergeRelationLookup(schema) : new Map())

	const shapeCheck = validateOperationShape(op, schema)
	if (!shapeCheck.valid) {
		return {
			result: 'skipped',
			appliedOperations: [],
			rejection: {
				code: shapeCheck.code ?? 'SCHEMA_VALIDATION_ERROR',
				message: shapeCheck.message ?? `Operation "${op.id}" does not match the server schema`,
				retriable: false,
			},
		}
	}

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

		const untrusted = options.authorize !== undefined || options.authorizeSideEffect !== undefined
		if (!referential.allowed) {
			if (untrusted) return restrictedRejection(op)
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

		// An untrusted writer may only cause side effects inside its own scope: a
		// cascade must never delete (or null) another tenant's records (RT-10).
		if (options.authorizeSideEffect) {
			for (const effect of referential.sideEffectOps) {
				const stored = await readStoredRow(store, effect.collection, effect.recordId)
				const probe: Operation = {
					...op,
					id: `${op.id}:side-effect:${effect.collection}:${effect.recordId}`,
					type: effect.type === 'delete' ? 'delete' : 'update',
					collection: effect.collection,
					recordId: effect.recordId,
					data: effect.data,
					previousData: effect.previousData,
					causalDeps: [op.id],
				}
				if (!options.authorizeSideEffect(probe, stored).allowed) {
					return restrictedRejection(op)
				}
			}
		}

		let primaryResult: Awaited<ReturnType<ServerStore['applyRemoteOperation']>>
		try {
			primaryResult = await applyPrimary(store, op, options)
		} catch (error) {
			const rejection = authorizationRejection(error)
			if (rejection) return { result: 'skipped', appliedOperations: [], rejection }
			throw error
		}
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

	let result: Awaited<ReturnType<ServerStore['applyRemoteOperation']>>
	try {
		result = await applyPrimary(store, op, options)
	} catch (error) {
		const rejection = authorizationRejection(error)
		if (rejection) return { result: 'skipped', appliedOperations: [], rejection }
		throw error
	}
	return {
		result,
		appliedOperations: result === 'applied' ? [op] : [],
	}
}

/**
 * The generic refusal for a delete blocked by related records. It names only the
 * record the writer itself targeted: never the children, their ids or their count.
 */
function restrictedRejection(op: Operation): ApplyServerOperationResult {
	return {
		result: 'skipped',
		appliedOperations: [],
		rejection: {
			code: RESTRICTED_REJECTION_CODE,
			message: `Deleting "${op.collection}" record "${op.recordId}" is restricted by related records. Remove or reassign them first.`,
			retriable: false,
		},
	}
}

/** The record as stored (including a soft-deleted one), or null when never written. */
async function readStoredRow(
	store: ServerStore,
	collection: string,
	recordId: string,
): Promise<MaterializedRecord | null> {
	const rows = await store.queryCollection(collection, {
		where: { id: recordId },
		includeDeleted: true,
		limit: 1,
	})
	return rows[0] ?? null
}

function applyPrimary(
	store: ServerStore,
	op: Operation,
	options: ApplyServerOperationOptions,
): ReturnType<ServerStore['applyRemoteOperation']> {
	return options.authorize
		? store.applyRemoteOperation(op, { authorize: options.authorize })
		: store.applyRemoteOperation(op)
}

/**
 * Map an in-store refusal to a structured, non-retriable rejection: an authorization
 * refusal, or a sequence conflict (another operation holds the node and sequence).
 */
function authorizationRejection(error: unknown): OperationRejection | null {
	if (error instanceof SequenceConflictError) {
		return { code: SEQUENCE_CONFLICT_CODE, message: error.message, retriable: false }
	}
	if (!(error instanceof UplinkAuthorizationError)) return null
	return { code: error.rejectionCode, message: error.message, retriable: false }
}

function validateOperationShape(
	op: Operation,
	schema: ReturnType<ServerStore['getSchema']>,
): { valid: true } | { valid: false; code: string; message: string } {
	if (!schema) {
		return { valid: true }
	}

	const collection = schema.collections[op.collection]
	if (!collection) {
		return {
			valid: false,
			code: 'UNKNOWN_COLLECTION',
			message: `Operation "${op.id}" targets unknown collection "${op.collection}".`,
		}
	}

	const declaredFields = new Set(Object.keys(collection.fields))
	const systemPreviousFields = new Set(['id', '_created_at', '_updated_at', '_deleted'])
	const invalidDataField = firstInvalidField(op.data, declaredFields)
	if (invalidDataField) {
		return {
			valid: false,
			code: 'SCHEMA_VALIDATION_ERROR',
			message: `Operation "${op.id}" contains undeclared field "${invalidDataField}" in data for collection "${op.collection}".`,
		}
	}

	const invalidPreviousField = firstInvalidField(
		op.previousData,
		declaredFields,
		systemPreviousFields,
	)
	if (invalidPreviousField) {
		return {
			valid: false,
			code: 'SCHEMA_VALIDATION_ERROR',
			message: `Operation "${op.id}" contains undeclared field "${invalidPreviousField}" in previousData for collection "${op.collection}".`,
		}
	}

	if (op.atomicOps) {
		for (const field of Object.keys(op.atomicOps)) {
			if (!declaredFields.has(field)) {
				return {
					valid: false,
					code: 'SCHEMA_VALIDATION_ERROR',
					message: `Operation "${op.id}" contains undeclared atomic field "${field}" for collection "${op.collection}".`,
				}
			}
		}
	}

	return { valid: true }
}

function firstInvalidField(
	value: unknown,
	declaredFields: Set<string>,
	extraAllowedFields?: Set<string>,
): string | null {
	if (value === null || value === undefined) {
		return null
	}
	if (typeof value !== 'object' || Array.isArray(value)) {
		return null
	}
	for (const field of Object.keys(value)) {
		if (!declaredFields.has(field) && !extraAllowedFields?.has(field)) {
			return field
		}
	}
	return null
}
