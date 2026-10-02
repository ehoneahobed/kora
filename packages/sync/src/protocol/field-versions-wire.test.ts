import { fc, test as propTest } from '@fast-check/vitest'
import type { HLCTimestamp, Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import type { OperationBatchMessage, SerializedOperation } from './messages'
import {
	JsonMessageSerializer,
	type MessageSerializer,
	ProtobufMessageSerializer,
	normalizeFieldVersions,
} from './serializer'

/**
 * Per-field versions of a server scope-entry insert (RT-27) survive every wire
 * format: JSON and protobuf. (The schema-driven DynamicProtobufSerializer carries them
 * the same way, but it is unused and cannot encode an envelope today, so it is not
 * exercised here.)
 */
const serializers: [string, MessageSerializer][] = [
	['json', new JsonMessageSerializer()],
	['protobuf', new ProtobufMessageSerializer()],
]

function entry(fieldVersions: Record<string, HLCTimestamp> | undefined): Operation {
	return {
		id: 'scope-entry-abc',
		nodeId: 'kora:scope-entry',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'a', body: 'b', owner: 'alice' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 0,
		causalDeps: [],
		schemaVersion: 1,
		...(fieldVersions ? { fieldVersions } : {}),
	}
}

function roundTrip(serializer: MessageSerializer, op: Operation): Operation {
	const batch: OperationBatchMessage = {
		type: 'operation-batch',
		messageId: 'm-1',
		operations: [serializer.encodeOperation(op)],
		isFinal: true,
		batchIndex: 0,
	}
	const decoded = serializer.decode(serializer.encode(batch)) as OperationBatchMessage
	const wire = decoded.operations[0] as SerializedOperation
	return serializer.decodeOperation(wire)
}

const hlcArb = fc.record({
	wallTime: fc.integer({ min: 0, max: 2 ** 47 }),
	logical: fc.integer({ min: 0, max: 65_535 }),
	nodeId: fc.string({ minLength: 1, maxLength: 24 }),
})

describe('fieldVersions on the wire (RT-27)', () => {
	test.each(serializers)('%s: carries per-field versions and keeps data clean', (_n, s) => {
		const versions = {
			title: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			body: { wallTime: 7000, logical: 2, nodeId: 'node-b' },
			owner: { wallTime: 8000, logical: 0, nodeId: 'server' },
		}
		const decoded = roundTrip(s, entry(versions))
		expect(decoded.fieldVersions).toEqual(versions)
		expect(decoded.data).toEqual({ title: 'a', body: 'b', owner: 'alice' })
		// An ordinary operation never grows the field.
		expect(roundTrip(s, entry(undefined)).fieldVersions).toBeUndefined()
	})

	for (const [name, s] of serializers) {
		propTest.prop([fc.dictionary(fc.constantFrom('title', 'body', 'owner'), hlcArb)])(
			`${name}: round-trips any per-field version map`,
			(versions) => {
				const decoded = roundTrip(s, entry(versions))
				expect(decoded.fieldVersions).toEqual(versions)
				expect(decoded.data).toEqual({ title: 'a', body: 'b', owner: 'alice' })
			},
		)
	}

	test('malformed versions from a peer are dropped, never half-applied', () => {
		expect(normalizeFieldVersions({ title: { wallTime: 1, logical: 0, nodeId: 'n' } })).toEqual({
			title: { wallTime: 1, logical: 0, nodeId: 'n' },
		})
		expect(normalizeFieldVersions({ title: { wallTime: '1', logical: 0, nodeId: 'n' } })).toBe(
			undefined,
		)
		expect(normalizeFieldVersions({ title: null })).toBeUndefined()
		expect(normalizeFieldVersions([])).toBeUndefined()
		expect(normalizeFieldVersions('x')).toBeUndefined()
		const json = new JsonMessageSerializer()
		const forged = {
			...json.encodeOperation(entry(undefined)),
			fieldVersions: { title: 'nope' },
		} as unknown as SerializedOperation
		expect(json.decodeOperation(forged).fieldVersions).toBeUndefined()
	})
})
