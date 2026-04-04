import { test } from '@fast-check/vitest'
import { fc } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { MemoryQueueStorage } from '../../src/engine/memory-queue-storage'
import { OutboundQueue } from '../../src/engine/outbound-queue'
import { JsonMessageSerializer } from '../../src/protocol/serializer'
import { versionVectorToWire, wireToVersionVector } from '../../src/protocol/serializer'
import { operationArb, syncMessageArb, versionVectorArb } from '../fixtures/test-operations'

const serializer = new JsonMessageSerializer()

describe('Protocol Correctness Properties', () => {
	test.prop([syncMessageArb])('message encode/decode roundtrip is identity', (msg) => {
		const encoded = serializer.encode(msg)
		const decoded = serializer.decode(encoded)
		expect(decoded).toEqual(msg)
	})

	test.prop([operationArb])('operation encode/decode roundtrip is identity', (op) => {
		const encoded = serializer.encodeOperation(op)
		const decoded = serializer.decodeOperation(encoded)
		expect(decoded).toEqual(op)
	})

	test.prop([versionVectorArb])('version vector wire roundtrip is identity', (vector) => {
		const wire = versionVectorToWire(vector)
		const roundtripped = wireToVersionVector(wire)
		expect(roundtripped).toEqual(vector)
	})

	test.prop([versionVectorArb])('version vector wire format has no Map instances', (vector) => {
		const wire = versionVectorToWire(vector)
		expect(wire).not.toBeInstanceOf(Map)
		expect(typeof wire).toBe('object')
		for (const value of Object.values(wire)) {
			expect(typeof value).toBe('number')
		}
	})
})

describe('Outbound Queue Properties', () => {
	test.prop([
		fc.array(operationArb, { minLength: 1, maxLength: 20 }).map((ops) =>
			// Ensure unique IDs and sequence numbers
			ops.map((op, i) => ({
				...op,
				id: `unique-op-${i}`,
				sequenceNumber: i + 1,
				timestamp: { ...op.timestamp, wallTime: 1000 + i },
				causalDeps: [], // No deps for this property test
			})),
		),
	])('applying operations is idempotent', async (ops) => {
		const store1 = new MemoryQueueStorage()
		const store2 = new MemoryQueueStorage()
		const queue1 = new OutboundQueue(store1)
		const queue2 = new OutboundQueue(store2)

		await queue1.initialize()
		await queue2.initialize()

		// Queue 1: enqueue each op once
		for (const op of ops) {
			await queue1.enqueue(op)
		}

		// Queue 2: enqueue each op twice (dedup should kick in)
		for (const op of ops) {
			await queue2.enqueue(op)
			await queue2.enqueue(op)
		}

		expect(queue1.size).toBe(queue2.size)
	})

	test.prop([
		fc.array(operationArb, { minLength: 2, maxLength: 10 }).map((ops) =>
			// Build a causal chain
			ops.map((op, i) => ({
				...op,
				id: `chain-op-${i}`,
				sequenceNumber: i + 1,
				timestamp: { ...op.timestamp, wallTime: 1000 + i },
				causalDeps: i > 0 ? [`chain-op-${i - 1}`] : [],
			})),
		),
	])('outbound queue preserves causal order', async (ops) => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()

		// Enqueue in reverse order
		for (let i = ops.length - 1; i >= 0; i--) {
			const op = ops[i]
			if (op) await queue.enqueue(op)
		}

		// Peek should return in causal order
		const peeked = queue.peek(ops.length)

		for (let i = 1; i < peeked.length; i++) {
			const current = peeked[i]
			if (!current) continue
			// Every causal dependency should appear earlier in the list
			for (const depId of current.causalDeps) {
				const depIndex = peeked.findIndex((op) => op.id === depId)
				if (depIndex !== -1) {
					expect(depIndex).toBeLessThan(i)
				}
			}
		}
	})
})

describe('Serialization Properties', () => {
	test.prop([operationArb])('encoded operation is valid JSON', (op) => {
		const encoded = serializer.encodeOperation(op)
		const json = JSON.stringify(encoded)
		expect(() => JSON.parse(json)).not.toThrow()
	})

	test.prop([syncMessageArb])('encoded message is valid JSON string', (msg) => {
		const encoded = serializer.encode(msg)
		expect(typeof encoded).toBe('string')
		expect(() => JSON.parse(encoded)).not.toThrow()
	})

	test.prop([operationArb])('operation fields are preserved through serialization', (op) => {
		const serialized = serializer.encodeOperation(op)
		expect(serialized.id).toBe(op.id)
		expect(serialized.nodeId).toBe(op.nodeId)
		expect(serialized.type).toBe(op.type)
		expect(serialized.collection).toBe(op.collection)
		expect(serialized.recordId).toBe(op.recordId)
		expect(serialized.sequenceNumber).toBe(op.sequenceNumber)
		expect(serialized.schemaVersion).toBe(op.schemaVersion)
		expect(serialized.timestamp.wallTime).toBe(op.timestamp.wallTime)
		expect(serialized.timestamp.logical).toBe(op.timestamp.logical)
		expect(serialized.timestamp.nodeId).toBe(op.timestamp.nodeId)
	})
})
