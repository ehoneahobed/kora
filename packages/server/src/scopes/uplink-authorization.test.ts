import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	authorizeRecordWrite,
	authorizeUplinkWrite,
	missingScopeFields,
	operationMatchesScopes,
	recordMatchesScopes,
	splitScopeForQuery,
} from './server-scope-filter'

function op(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-1',
		nodeId: 'alice-node',
		type: 'update',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'x' },
		previousData: null,
		timestamp: { wallTime: 1, logical: 0, nodeId: 'alice-node' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

const alice = { todos: { userId: 'alice' } }
const bobRow = { id: 'rec-1', userId: 'bob', title: 'bob secret' }
const aliceRow = { id: 'rec-1', userId: 'alice', title: 'mine' }

describe('authorizeUplinkWrite', () => {
	test('without scopes, well-formed writes are allowed', () => {
		expect(authorizeUplinkWrite(op(), bobRow, undefined)).toEqual({ allowed: true })
	})

	test('an op whose data or previousData names another id is refused even without scopes', () => {
		const viaData = authorizeUplinkWrite(op({ data: { id: 'other' } }), null, undefined)
		expect(viaData).toMatchObject({ allowed: false, code: 'INVALID_OPERATION' })
		const viaPrevious = authorizeUplinkWrite(op({ previousData: { id: 'other' } }), null, undefined)
		expect(viaPrevious).toMatchObject({ allowed: false, code: 'INVALID_OPERATION' })
	})

	test('an id equal to recordId is not a forgery', () => {
		const result = authorizeUplinkWrite(op({ previousData: { id: 'rec-1' } }), aliceRow, alice)
		expect(result.allowed).toBe(true)
	})

	test('forged previousData cannot authorize an update to a record stored out of scope', () => {
		const forged = op({ data: { title: 'hacked' }, previousData: { userId: 'alice' } })
		expect(authorizeUplinkWrite(forged, bobRow, alice)).toMatchObject({
			allowed: false,
			code: 'SCOPE_VIOLATION',
		})
	})

	test('forged previousData cannot authorize a delete of a record stored out of scope', () => {
		const forged = op({ type: 'delete', data: null, previousData: { userId: 'alice' } })
		expect(authorizeUplinkWrite(forged, bobRow, alice).allowed).toBe(false)
	})

	test('data cannot take ownership of a record stored out of scope', () => {
		expect(authorizeUplinkWrite(op({ data: { userId: 'alice' } }), bobRow, alice).allowed).toBe(
			false,
		)
	})

	test('an insert cannot overwrite a record stored out of scope', () => {
		const insert = op({ type: 'insert', data: { userId: 'alice', title: 'mine now' } })
		expect(authorizeUplinkWrite(insert, bobRow, alice).allowed).toBe(false)
	})

	test('a soft-deleted stored row is still authoritative', () => {
		const insert = op({ type: 'insert', data: { userId: 'alice', title: 'revive' } })
		expect(authorizeUplinkWrite(insert, { ...bobRow, _deleted: 1 }, alice).allowed).toBe(false)
	})

	test('a record cannot be moved out of the writer scope (no client ownership transfer)', () => {
		expect(authorizeUplinkWrite(op({ data: { userId: 'bob' } }), aliceRow, alice)).toMatchObject({
			allowed: false,
			code: 'SCOPE_VIOLATION',
		})
	})

	test('a partial update to an in-scope record is allowed (stored row fills the scope field)', () => {
		expect(authorizeUplinkWrite(op({ data: { title: 'edit' } }), aliceRow, alice).allowed).toBe(
			true,
		)
	})

	test('a delete of an in-scope record is allowed', () => {
		const del = op({ type: 'delete', data: null, previousData: null })
		expect(authorizeUplinkWrite(del, aliceRow, alice).allowed).toBe(true)
	})

	test('a new insert is judged on its own data', () => {
		const insert = op({ type: 'insert', data: { userId: 'alice', title: 'new' } })
		expect(authorizeUplinkWrite(insert, null, alice).allowed).toBe(true)
		const foreign = op({ type: 'insert', data: { userId: 'bob', title: 'new' } })
		expect(authorizeUplinkWrite(foreign, null, alice).allowed).toBe(false)
	})

	test('an update with no stored row and no scope field in data is refused', () => {
		expect(authorizeUplinkWrite(op({ data: { title: 'x' } }), null, alice).allowed).toBe(false)
	})

	test('id-scoped uplink: identity is the recordId, never an op field', () => {
		const idScope = { todos: { id: { $in: ['allowed'] } } }
		const victim = { id: 'victim', title: 'orig' }
		const forgedPrev = op({ recordId: 'victim', previousData: { id: 'allowed' } })
		expect(authorizeUplinkWrite(forgedPrev, victim, idScope).allowed).toBe(false)
		const forgedDelete = op({
			recordId: 'victim',
			type: 'delete',
			data: null,
			previousData: { id: 'allowed' },
		})
		expect(authorizeUplinkWrite(forgedDelete, victim, idScope).allowed).toBe(false)
		const legitInsert = op({ recordId: 'allowed', type: 'insert', data: { title: 'new' } })
		expect(authorizeUplinkWrite(legitInsert, null, idScope).allowed).toBe(true)
	})

	test('an unscoped collection is refused and an empty collection scope admits everything', () => {
		expect(authorizeUplinkWrite(op({ collection: 'projects' }), null, alice).allowed).toBe(false)
		expect(authorizeUplinkWrite(op(), bobRow, { todos: {} }).allowed).toBe(true)
	})

	test('$in scopes are honoured for both images', () => {
		const orgs = { todos: { orgId: { $in: ['a', 'b'] } } }
		const stored = { id: 'rec-1', orgId: 'a' }
		expect(authorizeUplinkWrite(op({ data: { orgId: 'b' } }), stored, orgs).allowed).toBe(true)
		expect(authorizeUplinkWrite(op({ data: { orgId: 'c' } }), stored, orgs).allowed).toBe(false)
	})
})

describe('authorizeRecordWrite', () => {
	test('requires the stored record in scope', () => {
		expect(authorizeRecordWrite('todos', 'rec-1', aliceRow, alice).allowed).toBe(true)
		expect(authorizeRecordWrite('todos', 'rec-1', bobRow, alice).allowed).toBe(false)
	})

	test('an unknown record only passes id or empty scopes', () => {
		expect(authorizeRecordWrite('todos', 'rec-1', null, alice).allowed).toBe(false)
		expect(authorizeRecordWrite('todos', 'rec-1', null, { todos: {} }).allowed).toBe(true)
		expect(
			authorizeRecordWrite('todos', 'rec-1', null, { todos: { id: { $in: ['rec-1'] } } }).allowed,
		).toBe(true)
		expect(authorizeRecordWrite('todos', 'rec-1', null, undefined).allowed).toBe(true)
	})
})

describe('recordMatchesScopes / splitScopeForQuery', () => {
	test('recordMatchesScopes supports $in and hides unscoped collections', () => {
		const scope = { notes: { orgId: { $in: ['a', 'b'] } } }
		expect(recordMatchesScopes('notes', { id: 'n', orgId: 'a' }, scope)).toBe(true)
		expect(recordMatchesScopes('notes', { id: 'n', orgId: 'z' }, scope)).toBe(false)
		expect(recordMatchesScopes('todos', { id: 'n' }, scope)).toBe(false)
		expect(recordMatchesScopes('todos', { id: 'n' }, undefined)).toBe(true)
	})

	test('splitScopeForQuery separates equality from $in predicates', () => {
		expect(splitScopeForQuery({ userId: 'a', orgId: { $in: ['x'] } })).toEqual({
			equality: { userId: 'a' },
			hasNonEquality: true,
		})
		expect(splitScopeForQuery({ userId: 'a' })).toEqual({
			equality: { userId: 'a' },
			hasNonEquality: false,
		})
	})
})

describe('visibility helpers use the recordId as identity', () => {
	test('operationMatchesScopes ignores an id carried in op fields', () => {
		const idScope = { todos: { id: { $in: ['allowed'] } } }
		expect(
			operationMatchesScopes(op({ recordId: 'victim', previousData: { id: 'allowed' } }), idScope, {
				id: 'victim',
			}),
		).toBe(false)
	})

	test('missingScopeFields never reports id as missing', () => {
		const del = op({ type: 'delete', data: null })
		expect(missingScopeFields(del, { todos: { id: 'rec-1', userId: 'a' } })).toEqual(['userId'])
	})
})
