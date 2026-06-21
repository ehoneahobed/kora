import type { Operation, SchemaDefinition } from '@korajs/core'
import { checkConstraints } from '@korajs/merge'
import type { ServerStore } from '../store/server-store'
import { createServerConstraintContext } from './server-constraint-context'

export interface OperationConstraintValidation {
	valid: boolean
	code?: string
	message?: string
}

/**
 * Validates an incoming operation against Tier 2 schema constraints on the server.
 * Deletes are skipped (removal cannot violate capacity/unique on the deleted row).
 */
export async function validateIncomingOperationConstraints(
	store: ServerStore,
	op: Operation,
	schema: SchemaDefinition | null,
): Promise<OperationConstraintValidation> {
	if (!schema) {
		return { valid: true }
	}

	if (op.type === 'delete') {
		return { valid: true }
	}

	const collectionDef = schema.collections[op.collection]
	if (!collectionDef || collectionDef.constraints.length === 0) {
		return { valid: true }
	}

	const candidate = await projectCandidateRecord(store, op)
	if (candidate === null) {
		return { valid: true }
	}

	const ctx = createServerConstraintContext(store)
	const violations = await checkConstraints(
		candidate,
		op.recordId,
		op.collection,
		collectionDef,
		ctx,
	)

	if (violations.length === 0) {
		return { valid: true }
	}

	const first = violations[0]
	if (first === undefined) {
		return { valid: true }
	}
	return {
		valid: false,
		code: 'CONSTRAINT_VIOLATION',
		message: first.message,
	}
}

async function projectCandidateRecord(
	store: ServerStore,
	op: Operation,
): Promise<Record<string, unknown> | null> {
	if (op.data === null) {
		return null
	}

	const existing = await store.findRecord(op.collection, op.recordId)
	const base = existing ? { ...existing } : {}

	if (op.type === 'insert') {
		return { ...op.data, id: op.recordId }
	}

	return { ...base, ...op.data, id: op.recordId }
}
