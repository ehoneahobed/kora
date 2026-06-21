import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { validateIncomingOperationConstraints } from './operation-constraint-validator'

const schema = defineSchema({
	version: 1,
	collections: {
		tags: {
			fields: {
				name: t.string(),
			},
			constraints: [
				{
					type: 'unique',
					fields: ['name'],
					onConflict: 'last-write-wins',
				},
			],
		},
	},
})

function makeInsertOp(recordId: string, name: string): Operation {
	return {
		id: `op-${recordId}`,
		nodeId: 'node-a',
		type: 'insert',
		collection: 'tags',
		recordId,
		data: { name },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('validateIncomingOperationConstraints', () => {
	test('rejects duplicate unique constraint values', async () => {
		const store = new MemoryServerStore()
		await store.setSchema(schema)

		const first = makeInsertOp('tag-1', 'kora')
		const second = makeInsertOp('tag-2', 'kora')

		const firstCheck = await validateIncomingOperationConstraints(store, first, schema)
		expect(firstCheck.valid).toBe(true)
		await store.applyRemoteOperation(first)

		const secondCheck = await validateIncomingOperationConstraints(store, second, schema)
		expect(secondCheck.valid).toBe(false)
		expect(secondCheck.code).toBe('CONSTRAINT_VIOLATION')

		await store.close()
	})

	test('allows operations when schema has no constraints', async () => {
		const store = new MemoryServerStore()

		const op = makeInsertOp('tag-3', 'solo')
		const result = await validateIncomingOperationConstraints(store, op, null)
		expect(result.valid).toBe(true)

		await store.close()
	})
})
