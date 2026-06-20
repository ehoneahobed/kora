import { HybridLogicalClock, createOperation, generateUUIDv7 } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { OperationError } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { buildReplaySnapshot, collectCausalClosure } from './replay-to'

const clock = new HybridLogicalClock('replay-test-node')

async function makeOp(
	input: Partial<Parameters<typeof createOperation>[0]> & {
		type: Operation['type']
		collection: string
		recordId: string
	},
): Promise<Operation> {
	return createOperation(
		{
			nodeId: 'replay-test-node',
			type: input.type,
			collection: input.collection,
			recordId: input.recordId,
			data: input.data ?? null,
			previousData: input.previousData ?? null,
			sequenceNumber: input.sequenceNumber ?? 1,
			causalDeps: input.causalDeps ?? [],
			schemaVersion: 1,
		},
		clock,
	)
}

describe('collectCausalClosure', () => {
	test('includes target and causal ancestors only', async () => {
		const recordId = generateUUIDv7()
		const insert = await makeOp({
			type: 'insert',
			collection: 'todos',
			recordId,
			data: { title: 'A', completed: false },
			sequenceNumber: 1,
		})
		const update = await makeOp({
			type: 'update',
			collection: 'todos',
			recordId,
			data: { completed: true },
			previousData: { completed: false },
			sequenceNumber: 2,
			causalDeps: [insert.id],
		})
		const unrelated = await makeOp({
			type: 'insert',
			collection: 'todos',
			recordId: generateUUIDv7(),
			data: { title: 'Other', completed: false },
			sequenceNumber: 3,
		})

		const closure = collectCausalClosure([insert, update, unrelated], update.id)
		expect(closure.map((op) => op.id)).toEqual([insert.id, update.id])
	})

	test('throws when target operation is missing', async () => {
		const insert = await makeOp({
			type: 'insert',
			collection: 'todos',
			recordId: generateUUIDv7(),
			data: { title: 'A', completed: false },
		})
		expect(() => collectCausalClosure([insert], 'missing-op-id')).toThrow(OperationError)
	})
})

describe('buildReplaySnapshot', () => {
	test('replays state at update without concurrent ops', async () => {
		const recordId = generateUUIDv7()
		const insert = await makeOp({
			type: 'insert',
			collection: 'todos',
			recordId,
			data: { title: 'Hello', completed: false },
			sequenceNumber: 1,
		})
		const update = await makeOp({
			type: 'update',
			collection: 'todos',
			recordId,
			data: { title: 'Hello world' },
			previousData: { title: 'Hello' },
			sequenceNumber: 2,
			causalDeps: [insert.id],
		})

		const atInsert = buildReplaySnapshot(minimalSchema, [insert, update], insert.id)
		const todosAtInsert = atInsert.collections.todos ?? []
		expect(todosAtInsert).toHaveLength(1)
		expect(todosAtInsert[0]?.title).toBe('Hello')
		expect(todosAtInsert[0]?.completed).toBe(false)

		const atUpdate = buildReplaySnapshot(minimalSchema, [insert, update], update.id)
		const todosAtUpdate = atUpdate.collections.todos ?? []
		expect(todosAtUpdate[0]?.title).toBe('Hello world')
		expect(atUpdate.findRecord('todos', recordId)?.title).toBe('Hello world')
	})

	test('excludes concurrent branch from causal cut', async () => {
		const recordA = generateUUIDv7()
		const recordB = generateUUIDv7()
		const insertA = await makeOp({
			type: 'insert',
			collection: 'todos',
			recordId: recordA,
			data: { title: 'A', completed: false },
			sequenceNumber: 1,
		})
		const insertB = await makeOp({
			type: 'insert',
			collection: 'todos',
			recordId: recordB,
			data: { title: 'B', completed: false },
			sequenceNumber: 2,
		})

		const snapshot = buildReplaySnapshot(minimalSchema, [insertA, insertB], insertA.id)
		const todosSnapshot = snapshot.collections.todos ?? []
		expect(todosSnapshot).toHaveLength(1)
		expect(todosSnapshot[0]?.title).toBe('A')
		expect(snapshot.findRecord('todos', recordB)).toBeNull()
	})

	test('reflects delete in causal past', async () => {
		const recordId = generateUUIDv7()
		const insert = await makeOp({
			type: 'insert',
			collection: 'todos',
			recordId,
			data: { title: 'Gone', completed: false },
			sequenceNumber: 1,
		})
		const del = await makeOp({
			type: 'delete',
			collection: 'todos',
			recordId,
			sequenceNumber: 2,
			causalDeps: [insert.id],
		})

		const snapshot = buildReplaySnapshot(minimalSchema, [insert, del], del.id)
		expect(snapshot.collections.todos).toHaveLength(0)
		expect(snapshot.findRecord('todos', recordId)).toBeNull()
	})
})
