import { describe, expect, test } from 'vitest'
import { HybridLogicalClock } from '../clock/hlc'
import type { Operation, OperationInput } from '../types'
import {
	DEFAULT_OPERATION_HASH_VERSION,
	type HashableOperation,
	computeOperationId,
} from './content-hash'
import { createOperation, verifyOperationId, verifyOperationIntegrity } from './operation'

const input: OperationInput = {
	nodeId: 'node-a',
	type: 'update',
	collection: 'tickets',
	recordId: 'r1',
	data: { tags: [] },
	previousData: { tags: ['urgent'] },
	sequenceNumber: 2,
	causalDeps: ['dep-1', 'dep-2'],
	schemaVersion: 1,
}

const hashable: HashableOperation = {
	...input,
	timestamp: { wallTime: 1_000, logical: 3, nodeId: 'node-a' },
}

describe('content hash versions', () => {
	test('version 2 is the default (protocol v2); version 1 is unchanged', async () => {
		expect(DEFAULT_OPERATION_HASH_VERSION).toBe(2)
		const legacy = await computeOperationId(input, HybridLogicalClock.serialize(hashable.timestamp))
		expect(await computeOperationId(hashable, 1)).toBe(legacy)
		const op = await createOperation(input, new HybridLogicalClock('node-a'))
		expect(op.hashVersion).toBe(2)
		expect(await verifyOperationId(op)).toBe(true)
		const v1 = await createOperation(input, new HybridLogicalClock('node-a'), { hashVersion: 1 })
		expect(v1.hashVersion).toBeUndefined()
		expect(await verifyOperationId(v1)).toBe(true)
	})

	test('version 2 differs from version 1 and is deterministic', async () => {
		const v2 = await computeOperationId(hashable, 2)
		expect(v2).toMatch(/^[0-9a-f]{64}$/)
		expect(v2).not.toBe(await computeOperationId(hashable, 1))
		expect(await computeOperationId({ ...hashable }, 2)).toBe(v2)
	})

	const tampers: Array<[string, (op: HashableOperation) => HashableOperation]> = [
		['previousData', (op) => ({ ...op, previousData: { tags: ['urgent', 'vip'] } })],
		['sequenceNumber', (op) => ({ ...op, sequenceNumber: 1_000_000 })],
		['causalDeps', (op) => ({ ...op, causalDeps: [] })],
		['schemaVersion', (op) => ({ ...op, schemaVersion: 99 })],
		['data', (op) => ({ ...op, data: { tags: ['x'] } })],
		['timestamp', (op) => ({ ...op, timestamp: { ...op.timestamp, logical: 4 } })],
		['nodeId', (op) => ({ ...op, nodeId: 'node-b' })],
		['atomicOps', (op) => ({ ...op, atomicOps: { tags: { type: 'append', value: 'x' } } })],
	]
	for (const [field, tamper] of tampers) {
		test(`version 2 covers ${field}`, async () => {
			expect(await computeOperationId(tamper(hashable), 2)).not.toBe(
				await computeOperationId(hashable, 2),
			)
		})
	}

	test('version 2 treats causalDeps as a set and binary in canonical form', async () => {
		const reordered = { ...hashable, causalDeps: ['dep-2', 'dep-1'] }
		expect(await computeOperationId(reordered, 2)).toBe(await computeOperationId(hashable, 2))
		const raw = { ...hashable, data: { body: new Uint8Array([1, 2]) } }
		const tagged = { ...hashable, data: { body: { $koraBytes: 'AQI=' } } }
		expect(await computeOperationId(raw, 2)).toBe(await computeOperationId(tagged, 2))
	})

	test('createOperation with hashVersion 2 produces a verifiable v2 op', async () => {
		const op = await createOperation(input, new HybridLogicalClock('node-a'), { hashVersion: 2 })
		expect(op.hashVersion).toBe(2)
		expect(op.id).toBe(await computeOperationId(op, 2))
		expect(await verifyOperationId(op)).toBe(true)
		expect(await verifyOperationIntegrity(op)).toBe(true)
	})

	test('a v2 op cannot be downgraded to v1 or given an unknown version', async () => {
		const op = await createOperation(input, new HybridLogicalClock('node-a'), { hashVersion: 2 })
		expect(await verifyOperationId({ ...op, hashVersion: 1 })).toBe(false)
		expect(await verifyOperationId({ ...op, hashVersion: 3 } as unknown as Operation)).toBe(false)
	})
})
