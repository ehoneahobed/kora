import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { InvalidScopePredicateError, ScopePredicateLimitError } from './scope-predicate-errors'
import {
	missingScopeFields,
	normalizeScopeMap,
	operationMatchesScopes,
	snapshotExitsScopes,
} from './server-scope-filter'

describe('normalizeScopeMap fails closed on missing predicate values (RT-8)', () => {
	test.each([undefined, null])('rejects a %s value with InvalidScopePredicateError', (bad) => {
		expect(() => normalizeScopeMap({ todos: { ownerId: bad } })).toThrow(InvalidScopePredicateError)
		expect(() => normalizeScopeMap({ todos: { ownerId: { $in: ['a', bad] } } })).toThrow(
			InvalidScopePredicateError,
		)
	})

	test('an oversized $in is a typed ScopePredicateLimitError', () => {
		const values = ['v0', 'v1', 'v2']
		expect(() => normalizeScopeMap({ todos: { ownerId: { $in: values } } }, 2)).toThrow(
			ScopePredicateLimitError,
		)
	})

	test('a null or undefined predicate never matches a record lacking the field', () => {
		const op = createOp({ data: { title: 'no owner' } })
		expect(operationMatchesScopes(op, { todos: { ownerId: null } })).toBe(false)
		expect(operationMatchesScopes(op, { todos: { ownerId: undefined } })).toBe(false)
	})
})

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

	// RT-3: previousData is writer-supplied and never steers download visibility.
	// Visibility is judged on the server's stored row plus op.data only.
	test('an update is judged on the stored row plus data, never previousData', () => {
		const op = createOp({
			type: 'update',
			data: { title: 'Renamed' },
			previousData: { ownerId: 'user-1', title: 'Old' },
		})
		const scope = { todos: { ownerId: 'user-1' } }
		expect(operationMatchesScopes(op, scope)).toBe(false)
		expect(operationMatchesScopes(op, scope, { ownerId: 'user-1' })).toBe(true)
		// A forged previousData cannot pull another tenant's update into this scope...
		expect(operationMatchesScopes(op, scope, { ownerId: 'user-2' })).toBe(false)
		// ...nor hide an in-scope update from its own tenant.
		const hiding = createOp({
			type: 'update',
			data: { title: 'x' },
			previousData: { ownerId: 'z' },
		})
		expect(operationMatchesScopes(hiding, scope, { ownerId: 'user-1' })).toBe(true)
		expect(missingScopeFields(op, scope)).toEqual(['ownerId'])
	})

	test('a delete is judged on the stored row, never previousData', () => {
		const op = createOp({
			type: 'delete',
			data: null,
			previousData: { ownerId: 'user-1', title: 'Old' },
		})
		const scope = { todos: { ownerId: 'user-1' } }
		expect(operationMatchesScopes(op, scope)).toBe(false)
		expect(operationMatchesScopes(op, scope, { ownerId: 'user-1', _deleted: 1 })).toBe(true)
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

describe('snapshotExitsScopes judges exits on server values only (RT-15)', () => {
	const scopes = { todos: { owner: 'alice' } }
	const update = {
		id: 'u',
		nodeId: 'n',
		type: 'update',
		collection: 'todos',
		recordId: 'r1',
		data: { title: 'x' },
		// Forged: never consulted.
		previousData: { owner: 'alice' },
		timestamp: { wallTime: 1, logical: 0, nodeId: 'n' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	} as Operation

	test('an update from inside to outside the scope exits it', () => {
		expect(
			snapshotExitsScopes(update, { pre: { owner: 'alice' }, post: { owner: 'bob' } }, scopes),
		).toBe(true)
	})

	test("the writer's previousData cannot fake a pre-image", () => {
		expect(
			snapshotExitsScopes(update, { pre: { owner: 'bob' }, post: { owner: 'bob' } }, scopes),
		).toBe(false)
	})

	test('inserts, deletes, missing pre-images and unscoped sessions never exit', () => {
		const exit = { pre: { owner: 'alice' }, post: { owner: 'bob' } }
		expect(snapshotExitsScopes({ ...update, type: 'insert' }, exit, scopes)).toBe(false)
		expect(snapshotExitsScopes({ ...update, type: 'delete' }, exit, scopes)).toBe(false)
		expect(snapshotExitsScopes(update, { pre: null, post: { owner: 'bob' } }, scopes)).toBe(false)
		expect(snapshotExitsScopes(update, exit, undefined)).toBe(false)
	})
})
