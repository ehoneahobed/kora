import { createVersionVector } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	collectOperationsAheadOfServer,
	deserializeVersionVectorFromMeta,
	mergeVersionVectors,
	serializeVersionVectorToMeta,
} from './sync-state'

describe('sync-state', () => {
	test('serialize and deserialize version vector', () => {
		const vector = createVersionVector()
		vector.set('node-a', 5)
		vector.set('node-b', 10)
		const json = serializeVersionVectorToMeta(vector)
		const restored = deserializeVersionVectorFromMeta(json)
		expect(restored.get('node-a')).toBe(5)
		expect(restored.get('node-b')).toBe(10)
	})

	test('mergeVersionVectors keeps max per node', () => {
		const a = createVersionVector()
		a.set('node-a', 5)
		a.set('node-b', 3)
		const b = createVersionVector()
		b.set('node-a', 2)
		b.set('node-c', 7)
		const merged = mergeVersionVectors(a, b)
		expect(merged.get('node-a')).toBe(5)
		expect(merged.get('node-b')).toBe(3)
		expect(merged.get('node-c')).toBe(7)
	})

	test('collectOperationsAheadOfServer returns missing local ops', async () => {
		const local = createVersionVector()
		local.set('local-node', 2)
		const server = createVersionVector()
		server.set('local-node', 1)

		const ops = await collectOperationsAheadOfServer(local, server, async (nodeId, from, to) => {
			expect(nodeId).toBe('local-node')
			expect(from).toBe(2)
			expect(to).toBe(2)
			return [
				{
					id: 'op-2',
					nodeId: 'local-node',
					type: 'insert',
					collection: 'todos',
					recordId: 'r2',
					data: { title: 'b' },
					previousData: null,
					timestamp: { wallTime: 2, logical: 0, nodeId: 'local-node' },
					sequenceNumber: 2,
					causalDeps: [],
					schemaVersion: 1,
				},
			]
		})

		expect(ops).toHaveLength(1)
		expect(ops[0]?.sequenceNumber).toBe(2)
	})
})
