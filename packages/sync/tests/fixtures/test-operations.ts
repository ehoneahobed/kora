import { fc } from '@fast-check/vitest'
import type { Operation, VersionVector } from '@korajs/core'
import type { SyncMessage } from '../../src/protocol/messages'

/**
 * Arbitrary for generating valid HLC timestamps.
 */
const hlcTimestampArb = fc.record({
	wallTime: fc.integer({ min: 1000, max: 2000000000000 }),
	logical: fc.integer({ min: 0, max: 1000 }),
	nodeId: fc.stringMatching(/^node-[a-z0-9]{4}$/),
})

/**
 * Arbitrary for generating valid Operations.
 */
export const operationArb: fc.Arbitrary<Operation> = fc
	.record({
		nodeId: fc.stringMatching(/^node-[a-z0-9]{4}$/),
		type: fc.constantFrom('insert' as const, 'update' as const, 'delete' as const),
		collection: fc.constantFrom('todos', 'projects', 'users'),
		recordId: fc.stringMatching(/^rec-[a-z0-9]{8}$/),
		timestamp: hlcTimestampArb,
		sequenceNumber: fc.integer({ min: 1, max: 10000 }),
		schemaVersion: fc.constantFrom(1, 2),
	})
	.chain((base) => {
		const dataArb =
			base.type === 'delete'
				? fc.constant(null)
				: fc.dictionary(
						fc.constantFrom('title', 'completed', 'priority', 'assignee'),
						fc.oneof(fc.string(), fc.boolean(), fc.integer()),
						{ minKeys: 1, maxKeys: 3 },
					)

		const previousDataArb =
			base.type === 'update'
				? fc.dictionary(
						fc.constantFrom('title', 'completed', 'priority', 'assignee'),
						fc.oneof(fc.string(), fc.boolean(), fc.integer()),
						{ minKeys: 1, maxKeys: 3 },
					)
				: fc.constant(null)

		return fc
			.record({
				data: dataArb,
				previousData: previousDataArb,
			})
			.map(({ data, previousData }) => ({
				id: `op-${base.nodeId}-${base.sequenceNumber}`,
				nodeId: base.nodeId,
				type: base.type,
				collection: base.collection,
				recordId: base.recordId,
				data,
				previousData,
				timestamp: { ...base.timestamp, nodeId: base.nodeId },
				sequenceNumber: base.sequenceNumber,
				causalDeps: [] as string[],
				schemaVersion: base.schemaVersion,
			}))
	})

/**
 * Arbitrary for generating version vectors.
 */
export const versionVectorArb: fc.Arbitrary<VersionVector> = fc
	.array(fc.tuple(fc.stringMatching(/^node-[a-z0-9]{4}$/), fc.integer({ min: 0, max: 1000 })), {
		minLength: 0,
		maxLength: 10,
	})
	.map((entries) => new Map(entries))

/**
 * Arbitrary for a pair of version vectors where neither dominates the other
 * (representing a divergent state requiring delta sync).
 */
export const divergentVectorPairArb: fc.Arbitrary<{
	local: VersionVector
	remote: VersionVector
}> = fc
	.record({
		sharedNodeId: fc.stringMatching(/^node-[a-z0-9]{4}$/),
		localOnly: fc.stringMatching(/^node-[a-z0-9]{4}$/),
		remoteOnly: fc.stringMatching(/^node-[a-z0-9]{4}$/),
		sharedLocalSeq: fc.integer({ min: 1, max: 100 }),
		sharedRemoteSeq: fc.integer({ min: 1, max: 100 }),
		localOnlySeq: fc.integer({ min: 1, max: 100 }),
		remoteOnlySeq: fc.integer({ min: 1, max: 100 }),
	})
	.filter(
		(v) =>
			v.localOnly !== v.remoteOnly &&
			v.localOnly !== v.sharedNodeId &&
			v.remoteOnly !== v.sharedNodeId,
	)
	.map((v) => ({
		local: new Map([
			[v.sharedNodeId, v.sharedLocalSeq],
			[v.localOnly, v.localOnlySeq],
		]),
		remote: new Map([
			[v.sharedNodeId, v.sharedRemoteSeq],
			[v.remoteOnly, v.remoteOnlySeq],
		]),
	}))

/**
 * Arbitrary for generating valid SyncMessages.
 */
export const syncMessageArb: fc.Arbitrary<SyncMessage> = fc.oneof(
	// Handshake
	fc.record({
		type: fc.constant('handshake' as const),
		messageId: fc.stringMatching(/^msg-[a-z0-9]{8}$/),
		nodeId: fc.stringMatching(/^node-[a-z0-9]{4}$/),
		versionVector: fc.dictionary(
			fc.stringMatching(/^node-[a-z0-9]{4}$/),
			fc.integer({ min: 0, max: 1000 }),
			{ minKeys: 0, maxKeys: 5 },
		),
		schemaVersion: fc.integer({ min: 1, max: 10 }),
	}),
	// Handshake response
	fc.record({
		type: fc.constant('handshake-response' as const),
		messageId: fc.stringMatching(/^msg-[a-z0-9]{8}$/),
		nodeId: fc.stringMatching(/^node-[a-z0-9]{4}$/),
		versionVector: fc.dictionary(
			fc.stringMatching(/^node-[a-z0-9]{4}$/),
			fc.integer({ min: 0, max: 1000 }),
			{ minKeys: 0, maxKeys: 5 },
		),
		schemaVersion: fc.integer({ min: 1, max: 10 }),
		accepted: fc.boolean(),
	}),
	// Acknowledgment
	fc.record({
		type: fc.constant('acknowledgment' as const),
		messageId: fc.stringMatching(/^msg-[a-z0-9]{8}$/),
		acknowledgedMessageId: fc.stringMatching(/^msg-[a-z0-9]{8}$/),
		lastSequenceNumber: fc.integer({ min: 0, max: 10000 }),
	}),
	// Error
	fc.record({
		type: fc.constant('error' as const),
		messageId: fc.stringMatching(/^msg-[a-z0-9]{8}$/),
		code: fc.constantFrom('AUTH_FAILED', 'SCHEMA_MISMATCH', 'INTERNAL_ERROR'),
		message: fc.string({ minLength: 1, maxLength: 100 }),
		retriable: fc.boolean(),
	}),
)
