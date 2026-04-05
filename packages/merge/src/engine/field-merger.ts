import type { CustomResolver, FieldDescriptor, HLCTimestamp, Operation } from '@kora/core'
import type { MergeTrace } from '@kora/core'
import { addWinsSet } from '../strategies/add-wins-set'
import { lastWriteWins } from '../strategies/lww'
import { mergeRichtext } from '../strategies/yjs-richtext'
import type { RichtextValue } from '../strategies/yjs-richtext'
import type { FieldMergeResult } from '../types'

/**
 * Merges a single field from two concurrent operations.
 *
 * Dispatches to the appropriate strategy based on field kind:
 * - string, number, boolean, enum, timestamp → LWW (Last-Write-Wins via HLC)
 * - array → add-wins set (union of additions, only mutual removals)
 * - richtext → Yjs CRDT merge
 *
 * If a custom resolver (Tier 3) is provided, it overrides the default strategy.
 *
 * Handles non-conflict cases where only one side modified the field:
 * - Only local changed → take local value
 * - Only remote changed → take remote value
 * - Neither changed → keep base value
 *
 * @param fieldName - Name of the field being merged
 * @param localOp - The local operation
 * @param remoteOp - The remote operation
 * @param baseState - Full record state before either operation
 * @param fieldDescriptor - Schema descriptor for this field
 * @param resolver - Optional Tier 3 custom resolver for this field
 * @returns The merged field value and a trace for DevTools
 */
export function mergeField(
	fieldName: string,
	localOp: Operation,
	remoteOp: Operation,
	baseState: Record<string, unknown>,
	fieldDescriptor: FieldDescriptor,
	resolver?: CustomResolver,
): FieldMergeResult {
	const startTime = Date.now()

	const localData = localOp.data ?? {}
	const remoteData = remoteOp.data ?? {}
	const localPrevious = localOp.previousData ?? {}
	const remotePrevious = remoteOp.previousData ?? {}

	const localChanged = fieldName in localData
	const remoteChanged = fieldName in remoteData
	const baseValue = baseState[fieldName]

	// Non-conflict: only one side changed
	if (localChanged && !remoteChanged) {
		return createResult(
			localData[fieldName],
			fieldName,
			localOp,
			remoteOp,
			localData[fieldName],
			baseValue,
			baseValue,
			'no-conflict-local',
			1,
			startTime,
		)
	}

	if (!localChanged && remoteChanged) {
		return createResult(
			remoteData[fieldName],
			fieldName,
			localOp,
			remoteOp,
			baseValue,
			remoteData[fieldName],
			baseValue,
			'no-conflict-remote',
			1,
			startTime,
		)
	}

	if (!localChanged && !remoteChanged) {
		return createResult(
			baseValue,
			fieldName,
			localOp,
			remoteOp,
			baseValue,
			baseValue,
			baseValue,
			'no-conflict-unchanged',
			1,
			startTime,
		)
	}

	// Both sides changed this field — conflict resolution needed

	const localValue = localData[fieldName]
	const remoteValue = remoteData[fieldName]

	// Tier 3: Custom resolver takes precedence
	if (resolver !== undefined) {
		const resolved = resolver(localValue, remoteValue, baseValue)
		return createResult(
			resolved,
			fieldName,
			localOp,
			remoteOp,
			localValue,
			remoteValue,
			baseValue,
			'custom',
			3,
			startTime,
		)
	}

	// Tier 1: Auto-merge based on field kind
	return autoMerge(
		fieldName,
		localOp,
		remoteOp,
		localValue,
		remoteValue,
		baseValue,
		fieldDescriptor,
		startTime,
	)
}

function autoMerge(
	fieldName: string,
	localOp: Operation,
	remoteOp: Operation,
	localValue: unknown,
	remoteValue: unknown,
	baseValue: unknown,
	fieldDescriptor: FieldDescriptor,
	startTime: number,
): FieldMergeResult {
	switch (fieldDescriptor.kind) {
		case 'string':
		case 'number':
		case 'boolean':
		case 'enum':
		case 'timestamp': {
			const lwwResult = lastWriteWins(
				localValue,
				remoteValue,
				localOp.timestamp,
				remoteOp.timestamp,
			)
			return createResult(
				lwwResult.value,
				fieldName,
				localOp,
				remoteOp,
				localValue,
				remoteValue,
				baseValue,
				'lww',
				1,
				startTime,
			)
		}

		case 'array': {
			const baseArr = Array.isArray(baseValue) ? baseValue : []
			const localArr = Array.isArray(localValue) ? localValue : []
			const remoteArr = Array.isArray(remoteValue) ? remoteValue : []

			const merged = addWinsSet(localArr, remoteArr, baseArr)
			return createResult(
				merged,
				fieldName,
				localOp,
				remoteOp,
				localValue,
				remoteValue,
				baseValue,
				'add-wins-set',
				1,
				startTime,
			)
		}

		case 'richtext': {
			const merged = mergeRichtext(
				localValue as RichtextValue,
				remoteValue as RichtextValue,
				baseValue as RichtextValue,
			)
			return createResult(
				merged,
				fieldName,
				localOp,
				remoteOp,
				localValue,
				remoteValue,
				baseValue,
				'crdt-text',
				1,
				startTime,
			)
		}
	}
}

function createResult(
	value: unknown,
	field: string,
	operationA: Operation,
	operationB: Operation,
	inputA: unknown,
	inputB: unknown,
	base: unknown | null,
	strategy: string,
	tier: 1 | 2 | 3,
	startTime: number,
): FieldMergeResult {
	const trace: MergeTrace = {
		operationA,
		operationB,
		field,
		strategy,
		inputA,
		inputB,
		base,
		output: value,
		tier,
		constraintViolated: null,
		duration: Date.now() - startTime,
	}
	return { value, trace }
}
