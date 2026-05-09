import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import type { SyncScopeMap } from '../types'
import { filterOperationsByScope, operationMatchesScope } from './scope-filter'

function createOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { userId: 'user-1', title: 'Test' },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('operationMatchesScope', () => {
	test('returns true when scopeMap is undefined', () => {
		const op = createOp()
		expect(operationMatchesScope(op, undefined)).toBe(true)
	})

	test('returns false when collection is not in scope map', () => {
		const op = createOp({ collection: 'projects' })
		const scope: SyncScopeMap = { todos: { userId: 'user-1' } }
		expect(operationMatchesScope(op, scope)).toBe(false)
	})

	test('returns true when collection scope is empty (no restrictions)', () => {
		const op = createOp()
		const scope: SyncScopeMap = { todos: {} }
		expect(operationMatchesScope(op, scope)).toBe(true)
	})

	test('returns true when all scope fields match in data', () => {
		const op = createOp({ data: { userId: 'user-1', title: 'Test' } })
		const scope: SyncScopeMap = { todos: { userId: 'user-1' } }
		expect(operationMatchesScope(op, scope)).toBe(true)
	})

	test('returns false when scope field does not match', () => {
		const op = createOp({ data: { userId: 'user-2', title: 'Test' } })
		const scope: SyncScopeMap = { todos: { userId: 'user-1' } }
		expect(operationMatchesScope(op, scope)).toBe(false)
	})

	test('matches multiple scope fields (all must match)', () => {
		const op = createOp({ data: { userId: 'user-1', orgId: 'org-1', title: 'Test' } })
		const scope: SyncScopeMap = { todos: { userId: 'user-1', orgId: 'org-1' } }
		expect(operationMatchesScope(op, scope)).toBe(true)
	})

	test('rejects when one of multiple scope fields does not match', () => {
		const op = createOp({ data: { userId: 'user-1', orgId: 'org-2', title: 'Test' } })
		const scope: SyncScopeMap = { todos: { userId: 'user-1', orgId: 'org-1' } }
		expect(operationMatchesScope(op, scope)).toBe(false)
	})

	test('matches update operation using merged previousData and data', () => {
		const op = createOp({
			type: 'update',
			data: { title: 'Updated' },
			previousData: { userId: 'user-1', title: 'Old' },
		})
		const scope: SyncScopeMap = { todos: { userId: 'user-1' } }
		expect(operationMatchesScope(op, scope)).toBe(true)
	})

	test('data fields override previousData in snapshot', () => {
		const op = createOp({
			type: 'update',
			data: { userId: 'user-2' },
			previousData: { userId: 'user-1', title: 'Old' },
		})
		const scope: SyncScopeMap = { todos: { userId: 'user-1' } }
		// After merge, userId is 'user-2' (from data), so it should NOT match
		expect(operationMatchesScope(op, scope)).toBe(false)
	})

	test('matches delete operation using previousData', () => {
		const op = createOp({
			type: 'delete',
			data: null,
			previousData: { userId: 'user-1', title: 'Deleted' },
		})
		const scope: SyncScopeMap = { todos: { userId: 'user-1' } }
		expect(operationMatchesScope(op, scope)).toBe(true)
	})

	test('returns false when operation has null data and null previousData', () => {
		const op = createOp({ data: null, previousData: null })
		const scope: SyncScopeMap = { todos: { userId: 'user-1' } }
		expect(operationMatchesScope(op, scope)).toBe(false)
	})

	test('handles scope with multiple collections', () => {
		const todoOp = createOp({ collection: 'todos', data: { userId: 'user-1' } })
		const projectOp = createOp({ collection: 'projects', data: { orgId: 'org-1' } })
		const settingsOp = createOp({ collection: 'settings', data: { key: 'theme' } })

		const scope: SyncScopeMap = {
			todos: { userId: 'user-1' },
			projects: { orgId: 'org-1' },
			settings: {},
		}

		expect(operationMatchesScope(todoOp, scope)).toBe(true)
		expect(operationMatchesScope(projectOp, scope)).toBe(true)
		expect(operationMatchesScope(settingsOp, scope)).toBe(true)
	})

	test('rejects operation for collection not in scope map', () => {
		const op = createOp({ collection: 'audit_logs' })
		const scope: SyncScopeMap = { todos: { userId: 'user-1' } }
		expect(operationMatchesScope(op, scope)).toBe(false)
	})
})

describe('filterOperationsByScope', () => {
	test('returns all operations when scope is undefined', () => {
		const ops = [createOp({ id: 'op-1' }), createOp({ id: 'op-2', collection: 'projects' })]
		expect(filterOperationsByScope(ops, undefined)).toHaveLength(2)
	})

	test('filters operations based on scope', () => {
		const ops = [
			createOp({ id: 'op-1', data: { userId: 'user-1' } }),
			createOp({ id: 'op-2', data: { userId: 'user-2' } }),
			createOp({ id: 'op-3', data: { userId: 'user-1' } }),
		]
		const scope: SyncScopeMap = { todos: { userId: 'user-1' } }
		const filtered = filterOperationsByScope(ops, scope)
		expect(filtered).toHaveLength(2)
		expect(filtered.map((o) => o.id)).toEqual(['op-1', 'op-3'])
	})

	test('returns empty array when no operations match', () => {
		const ops = [createOp({ id: 'op-1', data: { userId: 'user-2' } })]
		const scope: SyncScopeMap = { todos: { userId: 'user-1' } }
		expect(filterOperationsByScope(ops, scope)).toHaveLength(0)
	})

	test('filters operations across multiple collections', () => {
		const ops = [
			createOp({ id: 'op-1', collection: 'todos', data: { userId: 'user-1' } }),
			createOp({ id: 'op-2', collection: 'projects', data: { orgId: 'org-1' } }),
			createOp({ id: 'op-3', collection: 'hidden', data: { x: 1 } }),
		]
		const scope: SyncScopeMap = {
			todos: { userId: 'user-1' },
			projects: { orgId: 'org-1' },
			// 'hidden' collection not in scope
		}
		const filtered = filterOperationsByScope(ops, scope)
		expect(filtered).toHaveLength(2)
		expect(filtered.map((o) => o.id)).toEqual(['op-1', 'op-2'])
	})
})
