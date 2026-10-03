import { operationValueViolation } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { buildMergeRelationLookup, checkReferentialIntegrityOnDelete } from '@korajs/merge'
import type { SideEffectOp } from '@korajs/merge'
import type { ApplyResult } from '@korajs/sync'
import { enforceCrossRecordRules } from '../constraints/constraint-authority'
import { validateIncomingOperationConstraints } from '../constraints/operation-constraint-validator'
import { createServerReferentialContext } from '../constraints/server-referential-context'
import {
	UplinkAuthorizationError,
	type UplinkAuthorizationResult,
} from '../scopes/server-scope-filter'
import { serverOperationView } from '../store/record-fold'
import type { ApplyRemoteOptions, MaterializedRecord, ServerStore } from '../store/server-store'
import {
	SEQUENCE_CONFLICT_CODE,
	SequenceConflictError,
	UNSTORABLE_VALUE_CODE,
	UnstorableValueError,
} from '../store/server-store'
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
	/**
	 * Side effects of an applied delete that were NOT derived because
	 * {@link ApplyServerOperationOptions.isAuthoredSideEffect} claimed them (RT-69). The
	 * caller must derive each one with {@link deriveServerSideEffects} unless the
	 * author's own copy is stored.
	 */
	deferredSideEffects?: SideEffectOp[]
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
	/**
	 * The writer is a legacy client that does not reserve sequence numbers (RT-37): a
	 * different operation under a held `(nodeId, sequenceNumber)` is stored as a legacy
	 * pair instead of being refused with `SEQUENCE_CONFLICT`. Applies to the primary
	 * operation only; server-originated side effects are always enforced.
	 */
	legacySequenceWriter?: boolean
	/** See `ApplyRemoteOptions.onLegacySequencePair`; for the primary operation. */
	onLegacySequencePair?: ApplyRemoteOptions['onLegacySequencePair']
	/**
	 * True for a referential side effect of this delete that the writer authored itself
	 * (its own cascade or set-null, later in the same upload, RT-69). Such an effect is
	 * not derived now but returned in `deferredSideEffects`, so the log stores one copy
	 * per child instead of the author's and the server's. Effects it does not claim (a
	 * child the author did not know, a legacy client that authors no cascades) are
	 * derived as before.
	 */
	isAuthoredSideEffect?: (effect: SideEffectOp) => boolean
	/**
	 * The operation as the server schema reads it (transforms at fold time, RT-84), when
	 * the caller already computed it. Shape, constraint and referential checks judge the
	 * view; the store keeps `op` exactly as given and folds the same view. Default: the
	 * store's own view (`serverOperationView`).
	 */
	view?: Operation
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

	// Everything below judges the operation as the server schema reads it; only the
	// store write (applyPrimary) and the relayed operation are the stored original.
	const stored = op
	let view: Operation | null
	try {
		view = options.view ?? serverOperationView(store, stored)
	} catch (error) {
		return {
			result: 'skipped',
			appliedOperations: [],
			rejection: {
				code: 'SCHEMA_TRANSFORM_INVALID',
				message: error instanceof Error ? error.message : String(error),
				retriable: false,
			},
		}
	}
	if (view === null) {
		return {
			result: 'skipped',
			appliedOperations: [],
			rejection: {
				code: 'SCHEMA_TRANSFORM_UNAVAILABLE',
				message: `Operation "${stored.id}" cannot be transformed from schema v${stored.schemaVersion} to the server schema.`,
				retriable: false,
			},
		}
	}
	return applyJudgedOperation(store, stored, view, lookup, schema, options)
}

async function applyJudgedOperation(
	store: ServerStore,
	stored: Operation,
	op: Operation,
	lookup: ReturnType<typeof buildMergeRelationLookup>,
	schema: ReturnType<ServerStore['getSchema']>,
	options: ApplyServerOperationOptions,
): Promise<ApplyServerOperationResult> {
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
			primaryResult = await applyPrimary(store, stored, options)
		} catch (error) {
			const rejection = authorizationRejection(error)
			if (rejection) return { result: 'skipped', appliedOperations: [], rejection }
			throw error
		}
		if (primaryResult !== 'applied') {
			return { result: primaryResult, appliedOperations: [] }
		}

		const appliedOperations: Operation[] = [stored]
		const deferred: SideEffectOp[] = []
		const derive: SideEffectOp[] = []
		for (const effect of referential.sideEffectOps) {
			if (options.isAuthoredSideEffect?.(effect)) deferred.push(effect)
			else derive.push(effect)
		}
		appliedOperations.push(...(await deriveServerSideEffects(store, op, derive)))
		appliedOperations.push(...(await enforceAfterCommit(store, op)))

		return {
			result: 'applied',
			appliedOperations,
			...(deferred.length > 0 ? { deferredSideEffects: deferred } : {}),
		}
	}

	let result: Awaited<ReturnType<ServerStore['applyRemoteOperation']>>
	try {
		result = await applyPrimary(store, stored, options)
	} catch (error) {
		const rejection = authorizationRejection(error)
		if (rejection) return { result: 'skipped', appliedOperations: [], rejection }
		throw error
	}
	if (result !== 'applied') return { result, appliedOperations: [] }
	return { result, appliedOperations: [stored, ...(await enforceAfterCommit(store, op))] }
}

/**
 * The referential side effects of an already stored delete that are still undone:
 * children that still reference the deleted record (cascade), or still hold its id
 * (set-null). Used when a delete arrives again as a stored duplicate (RT-73): an effect
 * deferred to the end of a batch that failed after the delete committed (or one the
 * author covered with a copy that was later refused) is found again here, so the
 * referential effect of a committed delete is never lost with an in-memory list.
 *
 * Effects the writer may not cause (`authorizeSideEffect`) are left out: the original
 * delete was only committed when every effect it had was authorized, so such an effect
 * belongs to a child added later, which the cascade-late correction covers.
 *
 * @param store - The server store
 * @param op - The stored delete (in the server's schema)
 * @param authorizeSideEffect - The writer's side-effect authorization, if untrusted
 * @returns The effects to derive (or to defer to the author's copies)
 */
export async function undoneSideEffectsOfStoredDelete(
	store: ServerStore,
	op: Operation,
	authorizeSideEffect?: SideEffectAuthorizer,
): Promise<SideEffectOp[]> {
	const schema = store.getSchema()
	if (op.type !== 'delete' || !schema) return []
	const lookup = buildMergeRelationLookup(schema)
	const referential = await checkReferentialIntegrityOnDelete(
		op,
		schema,
		createServerReferentialContext(store),
		lookup,
	)
	if (!authorizeSideEffect) return referential.sideEffectOps
	const allowed: SideEffectOp[] = []
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
		if (authorizeSideEffect(probe, stored).allowed) allowed.push(effect)
	}
	return allowed
}

/**
 * Store the server's own copy of referential side effects (cascade delete, set-null)
 * of the applied delete `parentOp`: deterministic ids and timestamps (see
 * {@link createServerSideEffectOperation}), so a retry or another instance writes the
 * same operations.
 *
 * @param store - The server store
 * @param parentOp - The applied delete
 * @param effects - Its side effects to derive
 * @returns The side-effect operations the store applied (to relay)
 */
export async function deriveServerSideEffects(
	store: ServerStore,
	parentOp: Operation,
	effects: readonly SideEffectOp[],
): Promise<Operation[]> {
	const applied: Operation[] = []
	for (const effect of effects) {
		// Allocate each side-effect's sequence number individually. On a store
		// that reserves atomically (Postgres), this keeps a concurrent conditional
		// apply from being handed the same server sequence number; on a serialized
		// store, each allocation reads the version vector the prior apply advanced.
		const sideOp = await createServerSideEffectOperation(
			store,
			parentOp,
			effect,
			parentOp.schemaVersion,
			nextServerSequenceNumber(store),
		)
		const sideResult = await store.applyRemoteOperation(sideOp)
		if (sideResult === 'applied') applied.push(sideOp)
	}
	return applied
}

/**
 * Whether `op` (an operation of the delete's author) is the author's own copy of the
 * side effect `effect` of the delete `parentId`: same record, causally after the
 * delete, with the same effect (a delete for a cascade; for a set-null, an update
 * writing null to every field the effect nulls). An encrypted update cannot be read,
 * so it never counts as a set-null copy.
 */
export function isAuthoredCopyOfSideEffect(
	op: Operation,
	parentId: string,
	effect: SideEffectOp,
): boolean {
	if (op.collection !== effect.collection || op.recordId !== effect.recordId) return false
	if (!op.causalDeps.includes(parentId)) return false
	if (effect.type === 'delete') return op.type === 'delete'
	if (op.type !== 'update' || op.encrypted !== undefined || !op.data) return false
	const data = op.data
	return Object.entries(effect.data ?? {}).every(
		([field, value]) => value === null && field in data && data[field] === null,
	)
}

/**
 * Re-check the cross-record rules the committed `op` touched and store the server's
 * corrections (W7 step 3; see `constraint-authority.ts`). A failure is logged, never
 * thrown: the operation itself is committed, and the next write to the record (or a
 * concurrent detector) re-checks.
 */
async function enforceAfterCommit(store: ServerStore, op: Operation): Promise<Operation[]> {
	try {
		return await enforceCrossRecordRules(store, op, () => nextServerSequenceNumber(store))
	} catch (error) {
		console.error(
			`[kora] Cross-record rule check after operation "${op.id}" on ${op.collection}/${op.recordId} failed: ${error instanceof Error ? error.message : String(error)}`,
		)
		return []
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
	const storeOptions: ApplyRemoteOptions = {
		...(options.authorize ? { authorize: options.authorize } : {}),
		...(options.legacySequenceWriter ? { legacySequenceWriter: true } : {}),
		...(options.onLegacySequencePair ? { onLegacySequencePair: options.onLegacySequencePair } : {}),
	}
	return Object.keys(storeOptions).length > 0
		? store.applyRemoteOperation(op, storeOptions)
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
	if (error instanceof UnstorableValueError) {
		return { code: UNSTORABLE_VALUE_CODE, message: error.message, retriable: false }
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

	// One value domain (core value-domain.ts, RT-86, RT-87): every value the server stores
	// must be one every server store holds unchanged and every client accepts. Checked on
	// the operation as the server schema reads it, before any store sees it, so a value
	// outside the domain is refused per operation (non-retriable) on every store alike,
	// never by a database half-way through a batch.
	if (op.data !== null && op.data !== undefined) {
		for (const [field, value] of Object.entries(op.data)) {
			const descriptor = collection.fields[field]
			if (!descriptor) continue
			const violation = operationValueViolation(descriptor, value)
			if (violation !== null) {
				return {
					valid: false,
					code: 'SCHEMA_VALIDATION_ERROR',
					message: `Operation "${op.id}" writes a value outside the domain of "${op.collection}.${field}": it ${violation}.`,
				}
			}
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
