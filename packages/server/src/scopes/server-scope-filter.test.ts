import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	missingScopeFields,
	normalizeScopeMap,
	operationMatchesScopes,
} from './server-scope-filter'

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

	test('supports canonical, explicit-deny $in predicates', () => {
		expect(
			operationMatchesScopes(createOp(), { todos: { ownerId: { $in: ['user-2', 'user-1'] } } }),
		).toBe(true)
		expect(operationMatchesScopes(createOp(), { todos: { ownerId: { $in: [] } } })).toBe(false)
		expect(
			normalizeScopeMap({ todos: { ownerId: { $in: ['user-2', 'user-1', 'user-2'] } } }),
		).toEqual({ todos: { ownerId: { $in: ['user-1', 'user-2'] } } })
	})

	test('rejects excessive predicate values', () => {
		expect(() => normalizeScopeMap({ todos: { ownerId: { $in: ['a', 'b'] } } }, 1)).toThrow(/limit/)
	})

	test('empty collection scope allows all operations in that collection', () => {
		const insert = createOp()
		const update = createOp({
			type: 'update',
			data: { title: 'Renamed' },
			previousData: { title: 'Old' },
		})
		const deletion = createOp({
			type: 'delete',
			data: null,
			previousData: null,
		})

		expect(operationMatchesScopes(insert, { todos: {} })).toBe(true)
		expect(operationMatchesScopes(update, { todos: {} })).toBe(true)
		expect(operationMatchesScopes(deletion, { todos: {} })).toBe(true)
		expect(missingScopeFields(deletion, { todos: {} })).toEqual([])
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

	// A real partial update carries ONLY the changed field in data/previousData, not
	// the scope field. Without the record backfill it is wrongly judged out of scope
	// and dropped from relay/delta — the multi-tenant divergence this fix closes.
	test('a partial update not restating the scope field needs a record backfill', () => {
		const op = createOp({
			type: 'update',
			data: { title: 'Renamed' },
			previousData: { title: 'Old' },
		})
		// Bare op: the scope field is absent, so it does not match (the old bug).
		expect(operationMatchesScopes(op, { todos: { ownerId: 'user-1' } })).toBe(false)
		expect(missingScopeFields(op, { todos: { ownerId: 'user-1' } })).toEqual(['ownerId'])
		// Backfilled from the materialized record: judged correctly by the record's owner.
		expect(
			operationMatchesScopes(op, { todos: { ownerId: 'user-1' } }, { ownerId: 'user-1' }),
		).toBe(true)
		expect(
			operationMatchesScopes(op, { todos: { ownerId: 'user-2' } }, { ownerId: 'user-1' }),
		).toBe(false)
	})

	test('data overrides the backfilled record when the scope field itself changes', () => {
		const op = createOp({
			type: 'update',
			data: { ownerId: 'user-2' },
			previousData: { ownerId: 'user-1' },
		})
		// Record still shows user-1, but the op reassigns to user-2: the resulting
		// record leaves user-1's scope and enters user-2's.
		expect(
			operationMatchesScopes(op, { todos: { ownerId: 'user-1' } }, { ownerId: 'user-1' }),
		).toBe(false)
		expect(
			operationMatchesScopes(op, { todos: { ownerId: 'user-2' } }, { ownerId: 'user-1' }),
		).toBe(true)
	})

	test('missingScopeFields is empty when the op carries the scope field', () => {
		const insert = createOp()
		expect(missingScopeFields(insert, { todos: { ownerId: 'user-1' } })).toEqual([])
		expect(missingScopeFields(insert, undefined)).toEqual([])
	})
})
