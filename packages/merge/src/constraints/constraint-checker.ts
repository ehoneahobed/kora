import type { CollectionDefinition, Constraint } from '@korajs/core'
import type { ConstraintContext, ConstraintViolation } from '../types'

/**
 * Checks all constraints on a collection against a candidate merged record.
 *
 * Called after Tier 1+3 merge produces a candidate state. Each violated
 * constraint is returned as a ConstraintViolation for Tier 2 resolution.
 *
 * @param mergedRecord - The candidate record state after field-level merge
 * @param recordId - ID of the record being merged
 * @param collection - Name of the collection
 * @param collectionDef - Schema definition for the collection
 * @param constraintContext - Pluggable DB lookup interface
 * @returns Array of violated constraints (empty if all pass)
 */
export async function checkConstraints(
	mergedRecord: Record<string, unknown>,
	recordId: string,
	collection: string,
	collectionDef: CollectionDefinition,
	constraintContext: ConstraintContext,
): Promise<ConstraintViolation[]> {
	const violations: ConstraintViolation[] = []

	for (const constraint of collectionDef.constraints) {
		// For unique and capacity constraints, where clause filters which records
		// the constraint applies to. For referential constraints, where clause
		// stores metadata (e.g., the referenced collection), not a record filter.
		if (
			constraint.type !== 'referential' &&
			constraint.where !== undefined &&
			!matchesWhere(mergedRecord, constraint.where)
		) {
			continue
		}

		const violation = await checkSingleConstraint(
			constraint,
			mergedRecord,
			recordId,
			collection,
			constraintContext,
		)
		if (violation !== null) {
			violations.push(violation)
		}
	}

	return violations
}

async function checkSingleConstraint(
	constraint: Constraint,
	mergedRecord: Record<string, unknown>,
	recordId: string,
	collection: string,
	ctx: ConstraintContext,
): Promise<ConstraintViolation | null> {
	switch (constraint.type) {
		case 'unique':
			return checkUniqueConstraint(constraint, mergedRecord, recordId, collection, ctx)
		case 'capacity':
			return checkCapacityConstraint(constraint, mergedRecord, collection, ctx)
		case 'referential':
			return checkReferentialConstraint(constraint, mergedRecord, collection, ctx)
	}
}

async function checkUniqueConstraint(
	constraint: Constraint,
	mergedRecord: Record<string, unknown>,
	recordId: string,
	collection: string,
	ctx: ConstraintContext,
): Promise<ConstraintViolation | null> {
	// Build a where clause from the constraint fields and the merged record values
	const where: Record<string, unknown> = {}
	for (const field of constraint.fields) {
		where[field] = mergedRecord[field]
	}

	const existing = await ctx.queryRecords(collection, where)
	// Filter out the current record itself
	const duplicates = existing.filter((r) => r.id !== recordId)

	if (duplicates.length > 0) {
		return {
			constraint,
			fields: constraint.fields,
			message:
				`Unique constraint violated on fields [${constraint.fields.join(', ')}] ` +
				`in collection "${collection}": duplicate value(s) found`,
		}
	}

	return null
}

async function checkCapacityConstraint(
	constraint: Constraint,
	mergedRecord: Record<string, unknown>,
	collection: string,
	ctx: ConstraintContext,
): Promise<ConstraintViolation | null> {
	// Capacity constraint: the where clause defines the group, fields[0] is the capacity limit field name
	// We count records matching the where clause
	const where = constraint.where ?? {}
	const count = await ctx.countRecords(collection, where)

	// The capacity limit is stored in the first field name as a numeric value
	// For capacity constraints, fields represent the fields that define the capacity group
	// The capacity limit itself needs to come from somewhere — we use the constraint's where clause
	// to scope the group, and check if adding this record exceeds the existing count
	// For simplicity: if there's a capacity constraint, the presence of this violation
	// means the group is at or over capacity
	if (count > 0 && constraint.fields.length > 0) {
		// Build the group match from constraint fields
		const groupWhere: Record<string, unknown> = { ...where }
		for (const field of constraint.fields) {
			groupWhere[field] = mergedRecord[field]
		}

		const groupCount = await ctx.countRecords(collection, groupWhere)
		// Capacity constraints use the where clause to define the limit
		// If we can't determine a numeric limit, we flag the violation
		// The resolver will handle the actual resolution logic
		if (groupCount > 1) {
			return {
				constraint,
				fields: constraint.fields,
				message:
					`Capacity constraint violated on fields [${constraint.fields.join(', ')}] ` +
					`in collection "${collection}": group count ${groupCount} exceeds limit`,
			}
		}
	}

	return null
}

async function checkReferentialConstraint(
	constraint: Constraint,
	mergedRecord: Record<string, unknown>,
	collection: string,
	ctx: ConstraintContext,
): Promise<ConstraintViolation | null> {
	// Referential constraint: the first field is the foreign key field,
	// and where.collection (or similar) would specify the referenced collection.
	// For a simple check: the field value should reference an existing record.
	if (constraint.fields.length === 0) {
		return null
	}

	const fkField = constraint.fields[0]
	if (fkField === undefined) {
		return null
	}

	const fkValue = mergedRecord[fkField]
	if (fkValue === null || fkValue === undefined) {
		// Null FK is allowed (the relation is optional)
		return null
	}

	// Look up the referenced record. The referenced collection is specified
	// in constraint.where.collection (convention for referential constraints).
	const referencedCollection =
		constraint.where !== undefined ? (constraint.where.collection as string | undefined) : undefined
	if (referencedCollection === undefined) {
		return null
	}

	const referenced = await ctx.queryRecords(referencedCollection, { id: fkValue })
	if (referenced.length === 0) {
		return {
			constraint,
			fields: constraint.fields,
			message:
				`Referential constraint violated on field "${fkField}" ` +
				`in collection "${collection}": referenced record not found ` +
				`in "${referencedCollection}" with id "${String(fkValue)}"`,
		}
	}

	return null
}

/**
 * Check if a record matches a where clause (simple equality check).
 */
function matchesWhere(record: Record<string, unknown>, where: Record<string, unknown>): boolean {
	for (const [key, value] of Object.entries(where)) {
		if (record[key] !== value) {
			return false
		}
	}
	return true
}
