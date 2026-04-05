import { HybridLogicalClock } from '@korajs/core'
import type { CollectionDefinition, Operation } from '@korajs/core'
import type { MergeTrace } from '@korajs/core'
import type { ConstraintViolation } from '../types'

/**
 * Result of resolving a constraint violation.
 */
export interface ConstraintResolution {
	/** The updated record after constraint resolution */
	resolvedRecord: Record<string, unknown>
	/** Trace of the resolution decision for DevTools */
	trace: MergeTrace
}

/**
 * Resolves a constraint violation by applying the constraint's onConflict strategy.
 *
 * Strategies:
 * - `last-write-wins`: The operation with the later HLC timestamp wins entirely
 * - `first-write-wins`: The operation with the earlier HLC timestamp wins entirely
 * - `priority-field`: Compares a designated priority field to determine the winner
 * - `server-decides`: Returns a marker indicating deferred server resolution
 * - `custom`: Calls the constraint's resolve function
 *
 * @param violation - The constraint violation to resolve
 * @param mergedRecord - The current candidate record state
 * @param localOp - The local operation
 * @param remoteOp - The remote operation
 * @param baseState - The record state before either operation
 * @returns The resolved record and a trace
 */
export function resolveConstraintViolation(
	violation: ConstraintViolation,
	mergedRecord: Record<string, unknown>,
	localOp: Operation,
	remoteOp: Operation,
	baseState: Record<string, unknown>,
): ConstraintResolution {
	const startTime = Date.now()
	const { constraint } = violation

	switch (constraint.onConflict) {
		case 'last-write-wins': {
			const comparison = HybridLogicalClock.compare(localOp.timestamp, remoteOp.timestamp)
			const winner = comparison >= 0 ? localOp : remoteOp
			const resolvedRecord = applyWinnerFields(mergedRecord, winner, violation.fields)
			return createResolution(
				resolvedRecord,
				violation,
				localOp,
				remoteOp,
				baseState,
				'constraint-lww',
				startTime,
			)
		}

		case 'first-write-wins': {
			const comparison = HybridLogicalClock.compare(localOp.timestamp, remoteOp.timestamp)
			const winner = comparison <= 0 ? localOp : remoteOp
			const resolvedRecord = applyWinnerFields(mergedRecord, winner, violation.fields)
			return createResolution(
				resolvedRecord,
				violation,
				localOp,
				remoteOp,
				baseState,
				'constraint-fww',
				startTime,
			)
		}

		case 'priority-field': {
			const priorityField = constraint.priorityField
			if (priorityField === undefined) {
				// Fallback to LWW if no priority field specified
				const comparison = HybridLogicalClock.compare(localOp.timestamp, remoteOp.timestamp)
				const winner = comparison >= 0 ? localOp : remoteOp
				const resolvedRecord = applyWinnerFields(mergedRecord, winner, violation.fields)
				return createResolution(
					resolvedRecord,
					violation,
					localOp,
					remoteOp,
					baseState,
					'constraint-priority-fallback-lww',
					startTime,
				)
			}

			const localPriority = getFieldValue(localOp, priorityField, mergedRecord)
			const remotePriority = getFieldValue(remoteOp, priorityField, mergedRecord)

			// Higher priority value wins (numeric or string comparison)
			const winner = comparePriority(localPriority, remotePriority) >= 0 ? localOp : remoteOp
			const resolvedRecord = applyWinnerFields(mergedRecord, winner, violation.fields)
			return createResolution(
				resolvedRecord,
				violation,
				localOp,
				remoteOp,
				baseState,
				'constraint-priority',
				startTime,
			)
		}

		case 'server-decides': {
			// Mark the record for server-side resolution. The sync layer handles this.
			// We keep the current merged record but flag it.
			const resolvedRecord = {
				...mergedRecord,
				_pendingServerResolution: true,
			}
			return createResolution(
				resolvedRecord,
				violation,
				localOp,
				remoteOp,
				baseState,
				'constraint-server-decides',
				startTime,
			)
		}

		case 'custom': {
			if (constraint.resolve === undefined) {
				// No custom resolver provided — fallback to LWW
				const comparison = HybridLogicalClock.compare(localOp.timestamp, remoteOp.timestamp)
				const winner = comparison >= 0 ? localOp : remoteOp
				const resolvedRecord = applyWinnerFields(mergedRecord, winner, violation.fields)
				return createResolution(
					resolvedRecord,
					violation,
					localOp,
					remoteOp,
					baseState,
					'constraint-custom-fallback-lww',
					startTime,
				)
			}

			// For each violated field, call the custom resolver with the local, remote, and base values
			const resolvedRecord = { ...mergedRecord }
			for (const field of violation.fields) {
				const localVal = getFieldValue(localOp, field, mergedRecord)
				const remoteVal = getFieldValue(remoteOp, field, mergedRecord)
				const baseVal = baseState[field]
				resolvedRecord[field] = constraint.resolve(localVal, remoteVal, baseVal)
			}
			return createResolution(
				resolvedRecord,
				violation,
				localOp,
				remoteOp,
				baseState,
				'constraint-custom',
				startTime,
			)
		}
	}
}

/**
 * Apply the winning operation's field values to the merged record
 * for the specific fields involved in the constraint violation.
 */
function applyWinnerFields(
	mergedRecord: Record<string, unknown>,
	winner: Operation,
	fields: string[],
): Record<string, unknown> {
	const result = { ...mergedRecord }
	const winnerData = winner.data ?? {}
	for (const field of fields) {
		if (field in winnerData) {
			result[field] = winnerData[field]
		}
	}
	return result
}

/**
 * Get a field value from an operation's data, falling back to the merged record.
 */
function getFieldValue(
	op: Operation,
	field: string,
	mergedRecord: Record<string, unknown>,
): unknown {
	const data = op.data ?? {}
	if (field in data) {
		return data[field]
	}
	return mergedRecord[field]
}

/**
 * Compare two priority values. Supports numbers and strings.
 * Returns positive if a > b, negative if a < b, zero if equal.
 */
function comparePriority(a: unknown, b: unknown): number {
	if (typeof a === 'number' && typeof b === 'number') {
		return a - b
	}
	if (typeof a === 'string' && typeof b === 'string') {
		return a < b ? -1 : a > b ? 1 : 0
	}
	// Mixed types: convert to string for comparison
	return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

function createResolution(
	resolvedRecord: Record<string, unknown>,
	violation: ConstraintViolation,
	localOp: Operation,
	remoteOp: Operation,
	baseState: Record<string, unknown>,
	strategy: string,
	startTime: number,
): ConstraintResolution {
	const field = violation.fields.join(', ')
	const trace: MergeTrace = {
		operationA: localOp,
		operationB: remoteOp,
		field,
		strategy,
		inputA: extractFieldValues(localOp, violation.fields),
		inputB: extractFieldValues(remoteOp, violation.fields),
		base: extractFields(baseState, violation.fields),
		output: extractFields(resolvedRecord, violation.fields),
		tier: 2,
		constraintViolated: violation.message,
		duration: Date.now() - startTime,
	}
	return { resolvedRecord, trace }
}

function extractFieldValues(op: Operation, fields: string[]): Record<string, unknown> {
	const data = op.data ?? {}
	const result: Record<string, unknown> = {}
	for (const field of fields) {
		result[field] = data[field]
	}
	return result
}

function extractFields(record: Record<string, unknown>, fields: string[]): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	for (const field of fields) {
		result[field] = record[field]
	}
	return result
}
