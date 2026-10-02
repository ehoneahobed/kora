import { HybridLogicalClock } from '../clock/hlc'
import { OperationError } from '../errors/errors'
import type { HLCTimestamp, Operation, OperationInput } from '../types'
import {
	DEFAULT_OPERATION_HASH_VERSION,
	type OperationHashVersion,
	computeOperationId,
} from './content-hash'

/** Options for {@link createOperation}. */
export interface CreateOperationOptions {
	/**
	 * Content-hash version of the new operation's id. Defaults to 2 (protocol v2),
	 * which commits the id to every semantic field (CORE-1); 1 is the legacy hash.
	 */
	hashVersion?: OperationHashVersion
}

/**
 * Creates an immutable, content-addressed Operation from the given parameters.
 * The operation is deep-frozen after creation — it cannot be modified.
 *
 * @param input - The operation parameters (without id, which is computed)
 * @param clock - The HLC clock to generate the timestamp
 * @param options - Optional hash version (default 2)
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
	options: CreateOperationOptions = {},
): Promise<Operation> {
	validateOperationParams(input)
	const hashVersion = options.hashVersion ?? DEFAULT_OPERATION_HASH_VERSION

	const timestamp = clock.now()
	const id =
		hashVersion === 1
			? await computeOperationId(input, HybridLogicalClock.serialize(timestamp))
			: await computeOperationId({ ...input, timestamp }, hashVersion)

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
		...(input.atomicOps !== undefined && Object.keys(input.atomicOps).length > 0
			? { atomicOps: { ...input.atomicOps } }
			: {}),
		...(input.transactionId !== undefined ? { transactionId: input.transactionId } : {}),
		...(input.mutationName !== undefined ? { mutationName: input.mutationName } : {}),
		...(hashVersion !== 1 ? { hashVersion } : {}),
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
 * Verify an operation's id against its content, using the hash version the
 * operation declares (`hashVersion`, absent = 1). A version-1 id does not cover
 * previousData, sequenceNumber, causalDeps or schemaVersion (CORE-1), so only a
 * version-2 operation is protected against rewriting those.
 *
 * Returns false for an unknown hash version.
 *
 * @param op - The operation to verify
 * @returns true when `op.id` is the content hash of `op`
 */
export async function verifyOperationId(op: Operation): Promise<boolean> {
	const version = op.hashVersion ?? 1
	if (version !== 1 && version !== 2) return false
	const expectedId = await computeOperationId(
		{
			nodeId: op.nodeId,
			type: op.type,
			collection: op.collection,
			recordId: op.recordId,
			data: op.data,
			previousData: op.previousData,
			timestamp: op.timestamp,
			sequenceNumber: op.sequenceNumber,
			causalDeps: op.causalDeps,
			schemaVersion: op.schemaVersion,
			...(op.atomicOps !== undefined ? { atomicOps: op.atomicOps } : {}),
		},
		version,
	)
	return op.id === expectedId
}

/**
 * Verify the integrity of an operation by recomputing its content hash.
 * Returns true if the id matches the recomputed hash. Same as
 * {@link verifyOperationId}.
 */
export async function verifyOperationIntegrity(op: Operation): Promise<boolean> {
	return verifyOperationId(op)
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
	// Typed arrays (e.g. richtext Yjs blobs) cannot be frozen in JS engines.
	if (ArrayBuffer.isView(obj)) return obj
	Object.freeze(obj)
	for (const value of Object.values(obj)) {
		if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
			deepFreeze(value)
		}
	}
	return obj
}
