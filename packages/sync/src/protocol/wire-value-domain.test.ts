import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import type { SyncMessage } from './messages'
import { JsonMessageSerializer, ProtobufMessageSerializer } from './serializer'
import type { MessageSerializer } from './serializer'

/**
 * The wire carries every value the local API accepts unchanged (value domain, RT-86).
 * Before, an object field value whose keys were all integers with number values (even
 * `{ " ": 0 }`) was decoded as a legacy byte record (a `Uint8Array`), and an object that
 * contained `__kora_bytes__` lost its other members.
 */
function op(data: Record<string, unknown>): Operation {
	return {
		id: 'op-1',
		nodeId: 'n',
		type: 'insert',
		collection: 'notes',
		recordId: 'r',
		data,
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'n' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function roundTrip(serializer: MessageSerializer, operation: Operation): Operation {
	const message: SyncMessage = {
		type: 'operation-batch',
		messageId: 'm',
		operations: [serializer.encodeOperation(operation)],
		isFinal: true,
		batchIndex: 0,
	}
	const decoded = serializer.decode(serializer.encode(message))
	if (decoded.type !== 'operation-batch' || !decoded.operations[0]) throw new Error('no batch')
	return serializer.decodeOperation(decoded.operations[0])
}

describe.each([
	['json', new JsonMessageSerializer()],
	['protobuf', new ProtobufMessageSerializer()],
] as const)('%s wire: object values are data', (_name, serializer) => {
	test('integer-keyed objects and objects containing __kora_bytes__ arrive unchanged', () => {
		const data = {
			a: { '1': 2 },
			b: { ' ': 0 },
			c: { '0': 1, '1': 255 },
			d: { __kora_bytes__: 'AAEC', other: 1 },
			e: { $koraBytes: 'AAEC' },
		}
		expect(roundTrip(serializer, op(data)).data).toEqual(data)
	})

	test('bytes still travel as bytes', () => {
		const bytes = new Uint8Array([0, 1, 2, 255])
		expect(roundTrip(serializer, op({ body: bytes })).data?.body).toEqual(bytes)
	})
})
