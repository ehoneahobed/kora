import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { operationMatchesScopes } from './server-scope-filter'

function createOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { ownerId: 'user-1', title: 'Test' },
		previousData: null,
		timestamp: { wallTime: 1, logical: 0, nodeId: 'node-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('operationMatchesScopes', () => {
	test('returns true when scopes are undefined', () => {
		const op = createOp()
		expect(operationMatchesScopes(op, undefined)).toBe(true)
	})

	test('returns false when collection is not scoped', () => {
		const op = createOp({ collection: 'projects' })
		expect(operationMatchesScopes(op, { todos: { ownerId: 'user-1' } })).toBe(false)
	})

	test('matches scoped fields in operation data', () => {
		const op = createOp()
		expect(operationMatchesScopes(op, { todos: { ownerId: 'user-1' } })).toBe(true)
	})

	test('rejects mismatched scoped fields', () => {
		const op = createOp()
		expect(operationMatchesScopes(op, { todos: { ownerId: 'user-2' } })).toBe(false)
	})

	test('matches update scope using merged previousData and data', () => {
		const op = createOp({
			type: 'update',
			data: { title: 'Renamed' },
			previousData: { ownerId: 'user-1', title: 'Old' },
		})
		expect(operationMatchesScopes(op, { todos: { ownerId: 'user-1' } })).toBe(true)
	})

	test('matches delete scope using previousData', () => {
		const op = createOp({
			type: 'delete',
			data: null,
			previousData: { ownerId: 'user-1', title: 'Old' },
		})
		expect(operationMatchesScopes(op, { todos: { ownerId: 'user-1' } })).toBe(true)
	})
})
