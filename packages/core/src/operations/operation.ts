import { HybridLogicalClock } from '../clock/hlc'
import { OperationError } from '../errors/errors'
import type { HLCTimestamp, Operation, OperationInput } from '../types'
import { computeOperationId } from './content-hash'

/**
 * Creates an immutable, content-addressed Operation from the given parameters.
 * The operation is deep-frozen after creation — it cannot be modified.
 *
 * @param input - The operation parameters (without id, which is computed)
 * @param clock - The HLC clock to generate the timestamp
 * @returns A frozen Operation with a content-addressed id
 *
 * @example
 * ```typescript
 * const op = await createOperation({
 *   nodeId: 'device-1',
 *   type: 'insert',
 *   collection: 'todos',
 *   recordId: 'rec-1',
 *   data: { title: 'Ship it' },
 *   previousData: null,
 *   sequenceNumber: 1,
 *   causalDeps: [],
 *   schemaVersion: 1,
 * }, clock)
 * ```
 */
export async function createOperation(
	input: OperationInput,
	clock: HybridLogicalClock,
): Promise<Operation> {
	validateOperationParams(input)

	const timestamp = clock.now()
	const serializedTs = HybridLogicalClock.serialize(timestamp)
	const id = await computeOperationId(input, serializedTs)

	const operation: Operation = {
		id,
		nodeId: input.nodeId,
		type: input.type,
		collection: input.collection,
		recordId: input.recordId,
		data: input.data ? { ...input.data } : null,
		previousData: input.previousData ? { ...input.previousData } : null,
		timestamp,
		sequenceNumber: input.sequenceNumber,
		causalDeps: [...input.causalDeps],
		schemaVersion: input.schemaVersion,
	}

	return deepFreeze(operation)
}

/**
 * Validates operation input parameters. Throws OperationError with
 * contextual information on validation failure.
 */
export function validateOperationParams(input: OperationInput): void {
	if (!input.nodeId || typeof input.nodeId !== 'string') {
		throw new OperationError('nodeId is required and must be a non-empty string', {
			received: input.nodeId,
		})
	}

	if (!input.type || !['insert', 'update', 'delete'].includes(input.type)) {
		throw new OperationError('type must be "insert", "update", or "delete"', {
			received: input.type,
		})
	}

	if (!input.collection || typeof input.collection !== 'string') {
		throw new OperationError('collection is required and must be a non-empty string', {
			received: input.collection,
		})
	}

	if (!input.recordId || typeof input.recordId !== 'string') {
		throw new OperationError('recordId is required and must be a non-empty string', {
			received: input.recordId,
		})
	}

	if (input.type === 'insert' && input.data === null) {
		throw new OperationError('insert operations must include data', {
			type: input.type,
			collection: input.collection,
		})
	}

	if (input.type === 'update' && input.data === null) {
		throw new OperationError('update operations must include data with changed fields', {
			type: input.type,
			collection: input.collection,
		})
	}

	if (input.type === 'update' && input.previousData === null) {
		throw new OperationError(
			'update operations must include previousData for 3-way merge support',
			{
				type: input.type,
				collection: input.collection,
			},
		)
	}

	if (input.type === 'delete' && input.data !== null) {
		throw new OperationError('delete operations must have null data', {
			type: input.type,
			collection: input.collection,
		})
	}

	if (typeof input.sequenceNumber !== 'number' || input.sequenceNumber < 0) {
		throw new OperationError('sequenceNumber must be a non-negative number', {
			received: input.sequenceNumber,
		})
	}

	if (!Array.isArray(input.causalDeps)) {
		throw new OperationError('causalDeps must be an array of operation IDs', {
			received: typeof input.causalDeps,
		})
	}

	if (typeof input.schemaVersion !== 'number' || input.schemaVersion < 1) {
		throw new OperationError('schemaVersion must be a positive number', {
			received: input.schemaVersion,
		})
	}
}

/**
 * Verify the integrity of an operation by recomputing its content hash.
 * Returns true if the id matches the recomputed hash.
 */
export async function verifyOperationIntegrity(op: Operation): Promise<boolean> {
	const input: OperationInput = {
		nodeId: op.nodeId,
		type: op.type,
		collection: op.collection,
		recordId: op.recordId,
		data: op.data,
		previousData: op.previousData,
		sequenceNumber: op.sequenceNumber,
		causalDeps: op.causalDeps,
		schemaVersion: op.schemaVersion,
	}
	const serializedTs = HybridLogicalClock.serialize(op.timestamp)
	const expectedId = await computeOperationId(input, serializedTs)
	return op.id === expectedId
}

/**
 * Type guard for Operation interface.
 */
export function isValidOperation(value: unknown): value is Operation {
	if (typeof value !== 'object' || value === null) return false
	const op = value as Record<string, unknown>
	return (
		typeof op.id === 'string' &&
		typeof op.nodeId === 'string' &&
		(op.type === 'insert' || op.type === 'update' || op.type === 'delete') &&
		typeof op.collection === 'string' &&
		typeof op.recordId === 'string' &&
		typeof op.sequenceNumber === 'number' &&
		Array.isArray(op.causalDeps) &&
		typeof op.schemaVersion === 'number' &&
		typeof op.timestamp === 'object' &&
		op.timestamp !== null
	)
}

function deepFreeze<T>(obj: T): T {
	if (typeof obj !== 'object' || obj === null) return obj
	Object.freeze(obj)
	for (const value of Object.values(obj)) {
		if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
			deepFreeze(value)
		}
	}
	return obj
}
