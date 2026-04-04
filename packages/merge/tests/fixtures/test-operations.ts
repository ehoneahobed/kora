import { fc } from '@fast-check/vitest'
import type { HLCTimestamp, Operation, OperationType } from '@kora/core'

/**
 * Create a test operation with sensible defaults. Override any field as needed.
 */
export function createTestOperation(overrides: Partial<Operation> = {}): Operation {
	return {
		id: overrides.id ?? 'op-test-1',
		nodeId: overrides.nodeId ?? 'node-a',
		type: overrides.type ?? 'update',
		collection: overrides.collection ?? 'todos',
		recordId: overrides.recordId ?? 'rec-1',
		data: overrides.data ?? {},
		previousData: overrides.previousData ?? {},
		timestamp: overrides.timestamp ?? {
			wallTime: 1000,
			logical: 0,
			nodeId: overrides.nodeId ?? 'node-a',
		},
		sequenceNumber: overrides.sequenceNumber ?? 1,
		causalDeps: overrides.causalDeps ?? [],
		schemaVersion: overrides.schemaVersion ?? 1,
	}
}

/**
 * Create a pair of conflicting operations on the same record with concurrent timestamps.
 */
export function createConflictingPair(
	localFields: Record<string, unknown>,
	remoteFields: Record<string, unknown>,
	baseFields: Record<string, unknown>,
): { local: Operation; remote: Operation; baseState: Record<string, unknown> } {
	const local = createTestOperation({
		id: 'op-local',
		nodeId: 'node-a',
		data: localFields,
		previousData: baseFields,
		timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
	})
	const remote = createTestOperation({
		id: 'op-remote',
		nodeId: 'node-b',
		data: remoteFields,
		previousData: baseFields,
		timestamp: { wallTime: 1500, logical: 0, nodeId: 'node-b' },
	})
	return { local, remote, baseState: baseFields }
}

// --- fast-check arbitraries ---

/** Arbitrary for HLC timestamps */
export const hlcTimestampArb: fc.Arbitrary<HLCTimestamp> = fc.record({
	wallTime: fc.integer({ min: 1, max: 2_000_000_000_000 }),
	logical: fc.integer({ min: 0, max: 10_000 }),
	nodeId: fc.constantFrom(
		'node-1',
		'node-2',
		'node-3',
		'node-4',
		'node-5',
		'node-6',
		'node-7',
		'node-8',
	),
})

/** Arbitrary for simple field values (primitives) */
export const fieldValueArb: fc.Arbitrary<unknown> = fc.oneof(
	fc.string(),
	fc.integer(),
	fc.double({ noNaN: true, noDefaultInfinity: true }),
	fc.boolean(),
	fc.constant(null),
)

/** Arbitrary for string field values */
export const stringFieldValueArb: fc.Arbitrary<string> = fc.string({ minLength: 0, maxLength: 50 })

/** Arbitrary for number field values */
export const numberFieldValueArb: fc.Arbitrary<number> = fc.integer({ min: -10000, max: 10000 })

/** Arbitrary for boolean field values */
export const booleanFieldValueArb: fc.Arbitrary<boolean> = fc.boolean()

/**
 * Generate a pair of concurrent update operations that both modify the same field.
 * Uses distinct nodeIds to ensure different HLC tiebreakers.
 */
export function concurrentUpdatePairArb(
	fieldName: string,
	valueArb: fc.Arbitrary<unknown>,
): fc.Arbitrary<{ local: Operation; remote: Operation; baseValue: unknown }> {
	return fc
		.record({
			localValue: valueArb,
			remoteValue: valueArb,
			baseValue: valueArb,
			localTs: hlcTimestampArb,
			remoteTs: hlcTimestampArb,
		})
		.map(({ localValue, remoteValue, baseValue, localTs, remoteTs }) => {
			// Ensure different nodeIds for proper tiebreaking
			const adjustedLocalTs = { ...localTs, nodeId: `local-${localTs.nodeId}` }
			const adjustedRemoteTs = { ...remoteTs, nodeId: `remote-${remoteTs.nodeId}` }

			const local = createTestOperation({
				id: `op-local-${adjustedLocalTs.wallTime}`,
				nodeId: adjustedLocalTs.nodeId,
				data: { [fieldName]: localValue },
				previousData: { [fieldName]: baseValue },
				timestamp: adjustedLocalTs,
			})
			const remote = createTestOperation({
				id: `op-remote-${adjustedRemoteTs.wallTime}`,
				nodeId: adjustedRemoteTs.nodeId,
				data: { [fieldName]: remoteValue },
				previousData: { [fieldName]: baseValue },
				timestamp: adjustedRemoteTs,
			})

			return { local, remote, baseValue }
		})
}
