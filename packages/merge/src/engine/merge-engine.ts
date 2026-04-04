import { HybridLogicalClock } from '@kora/core'
import type { Operation } from '@kora/core'
import type { MergeTrace } from '@kora/core'
import { checkConstraints } from '../constraints/constraint-checker'
import { resolveConstraintViolation } from '../constraints/resolvers'
import type { ConstraintContext, MergeInput, MergeResult } from '../types'
import { mergeField } from './field-merger'

/**
 * Three-tier merge engine for resolving concurrent operations.
 *
 * Tier 1: Auto-merge per field kind (LWW, add-wins set, CRDT)
 * Tier 3: Custom resolvers override Tier 1 for specific fields
 * Tier 2: Constraint validation against the candidate merged state
 *
 * Tier 3 runs BEFORE Tier 2 so that constraints validate the final merged state
 * including any custom resolver outputs.
 *
 * @example
 * ```typescript
 * const engine = new MergeEngine()
 * const result = await engine.merge({
 *   local: localOp,
 *   remote: remoteOp,
 *   baseState: { title: 'old', completed: false },
 *   collectionDef: schema.collections.todos,
 * })
 * ```
 */
export class MergeEngine {
	/**
	 * Merge two concurrent operations with all three tiers.
	 *
	 * Flow:
	 * 1. Determine which fields conflict (both ops modified the same field)
	 * 2. For non-conflicting fields: take the changed value from whichever op modified it
	 * 3. For conflicting fields: Tier 3 custom resolver if exists, else Tier 1 auto-merge
	 * 4. Assemble candidate merged record
	 * 5. If constraintContext provided: run Tier 2 constraint checks and resolve violations
	 * 6. Return MergeResult with all traces
	 *
	 * @param input - The two operations, base state, and collection definition
	 * @param constraintContext - Optional DB lookup interface for Tier 2 constraints
	 * @returns The merged data and traces for DevTools
	 */
	async merge(input: MergeInput, constraintContext?: ConstraintContext): Promise<MergeResult> {
		// Handle delete vs delete: both agree, no merge needed
		if (input.local.type === 'delete' && input.remote.type === 'delete') {
			return {
				mergedData: {},
				traces: [],
				appliedOperation: 'merged',
			}
		}

		// Handle update vs delete (or delete vs update)
		if (input.local.type === 'delete' || input.remote.type === 'delete') {
			return this.mergeWithDelete(input)
		}

		// Insert vs insert or update vs update: field-level merge
		const fieldResult = this.mergeFields(input)

		// Tier 2: Constraint checking (requires async DB lookups)
		if (constraintContext !== undefined && input.collectionDef.constraints.length > 0) {
			const recordWithId = { id: input.local.recordId, ...fieldResult.mergedData }
			const violations = await checkConstraints(
				recordWithId,
				input.local.recordId,
				input.local.collection,
				input.collectionDef,
				constraintContext,
			)

			let mergedData = fieldResult.mergedData
			const allTraces = [...fieldResult.traces]

			for (const violation of violations) {
				const resolution = resolveConstraintViolation(
					violation,
					mergedData,
					input.local,
					input.remote,
					input.baseState,
				)
				mergedData = resolution.resolvedRecord
				allTraces.push(resolution.trace)
			}

			return {
				mergedData,
				traces: allTraces,
				appliedOperation: determineAppliedOperation(allTraces),
			}
		}

		return fieldResult
	}

	/**
	 * Synchronous field-level merge (Tier 1 + Tier 3 only).
	 *
	 * Useful when constraint context is unavailable or not needed.
	 * Skips Tier 2 constraint checking entirely.
	 *
	 * @param input - The two operations, base state, and collection definition
	 * @returns The merged data and traces for DevTools
	 */
	mergeFields(input: MergeInput): MergeResult {
		const { local, remote, baseState, collectionDef } = input

		// Collect all field names that either operation touches
		const allFields = collectAffectedFields(local, remote, baseState, collectionDef)

		const mergedData: Record<string, unknown> = {}
		const traces: MergeTrace[] = []

		for (const fieldName of allFields) {
			const fieldDef = collectionDef.fields[fieldName]
			if (fieldDef === undefined) {
				// Field not in schema — skip (could be a removed field from migration)
				continue
			}

			const resolver = collectionDef.resolvers[fieldName]
			const result = mergeField(fieldName, local, remote, baseState, fieldDef, resolver)

			mergedData[fieldName] = result.value

			// Only include traces for actual conflicts (not no-conflict cases)
			if (
				result.trace.strategy !== 'no-conflict-local' &&
				result.trace.strategy !== 'no-conflict-remote' &&
				result.trace.strategy !== 'no-conflict-unchanged'
			) {
				traces.push(result.trace)
			}
		}

		return {
			mergedData,
			traces,
			appliedOperation: determineAppliedOperation(traces),
		}
	}

	/**
	 * Handle merge when one operation is a delete.
	 * Default: delete wins (LWW on the record level).
	 */
	private mergeWithDelete(input: MergeInput): MergeResult {
		const { local, remote } = input

		// LWW at the record level: later operation wins
		const comparison = HybridLogicalClock.compare(local.timestamp, remote.timestamp)

		if (comparison >= 0) {
			// Local is later
			if (local.type === 'delete') {
				return { mergedData: {}, traces: [], appliedOperation: 'local' }
			}
			// Local is an update that's later than remote delete → local wins
			return {
				mergedData: { ...input.baseState, ...(local.data ?? {}) },
				traces: [],
				appliedOperation: 'local',
			}
		}

		// Remote is later
		if (remote.type === 'delete') {
			return { mergedData: {}, traces: [], appliedOperation: 'remote' }
		}
		// Remote is an update that's later than local delete → remote wins
		return {
			mergedData: { ...input.baseState, ...(remote.data ?? {}) },
			traces: [],
			appliedOperation: 'remote',
		}
	}
}

/**
 * Collect all field names affected by either operation or present in the base state.
 */
function collectAffectedFields(
	local: Operation,
	remote: Operation,
	baseState: Record<string, unknown>,
	collectionDef: { fields: Record<string, unknown> },
): Set<string> {
	const fields = new Set<string>()

	// Fields from the schema definition
	for (const fieldName of Object.keys(collectionDef.fields)) {
		fields.add(fieldName)
	}

	// Fields from local operation
	if (local.data !== null) {
		for (const fieldName of Object.keys(local.data)) {
			fields.add(fieldName)
		}
	}

	// Fields from remote operation
	if (remote.data !== null) {
		for (const fieldName of Object.keys(remote.data)) {
			fields.add(fieldName)
		}
	}

	// Fields from base state
	for (const fieldName of Object.keys(baseState)) {
		fields.add(fieldName)
	}

	return fields
}

/**
 * Determine which operation's values dominate overall.
 * If all conflict traces went the same way, report that side.
 * Otherwise, report 'merged'.
 */
function determineAppliedOperation(traces: MergeTrace[]): 'local' | 'remote' | 'merged' {
	if (traces.length === 0) {
		return 'merged'
	}

	let allLocal = true
	let allRemote = true

	for (const trace of traces) {
		if (trace.strategy === 'lww' || trace.strategy === 'constraint-lww') {
			// Check if local or remote value was the output
			if (trace.output === trace.inputA) {
				allRemote = false
			} else if (trace.output === trace.inputB) {
				allLocal = false
			} else {
				allLocal = false
				allRemote = false
			}
		} else {
			// For non-LWW strategies (add-wins-set, custom, etc.), it's a merge
			allLocal = false
			allRemote = false
		}
	}

	if (allLocal) return 'local'
	if (allRemote) return 'remote'
	return 'merged'
}
