import type { Operation, OperationTransform } from '@korajs/core'
import { applyOperationTransforms } from '@korajs/core'
import { describe, expect, test } from 'vitest'

/**
 * Unit-level transform wiring. End-to-end v1 client + v2 server convergence lives in
 * `@korajs/test` (`schema-version-convergence.test.ts`).
 */
describe('schema version operation transforms', () => {
	test('v1 insert transforms to v2 shape for server apply', () => {
		const v1Op: Operation = {
			id: 'legacy-1',
			nodeId: 'client',
			type: 'insert',
			collection: 'todos',
			recordId: 'todo-1',
			data: { title: 'Task', done: false },
			previousData: null,
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'client' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		}

		const transforms: OperationTransform[] = [
			{
				fromVersion: 1,
				toVersion: 2,
				transform(op) {
					const data = op.data ?? {}
					const { done, ...rest } = data as { done?: boolean; title?: string }
					return {
						...op,
						schemaVersion: 2,
						data: { ...rest, completed: done ?? false },
					}
				},
			},
		]

		const v2Op = applyOperationTransforms(v1Op, 2, transforms)
		expect(v2Op?.schemaVersion).toBe(2)
		expect(v2Op?.data).toEqual({ title: 'Task', completed: false })
	})
})
