import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import type { AuthContext } from '../types'
import { type OperationsCommittedContext, OperationsCommittedHooks } from './operations-committed'

const operation: Operation = {
	id: 'op-1',
	nodeId: 'device',
	type: 'insert',
	collection: 'todos',
	recordId: 'r1',
	data: { title: 'a' },
	previousData: null,
	timestamp: { wallTime: 1, logical: 0, nodeId: 'device' },
	sequenceNumber: 1,
	causalDeps: [],
	schemaVersion: 1,
}

class Plan {
	constructor(readonly tier: string) {}
}

/** The context one handler receives for `auth`. */
function received(auth: AuthContext): OperationsCommittedContext {
	const hooks = new OperationsCommittedHooks((failure) => {
		throw failure.error
	})
	let seen: OperationsCommittedContext | null = null
	hooks.add((_operations, context) => {
		seen = context
	})
	hooks.dispatch([operation], { source: 'sync', auth, sessionId: 's1' })
	if (seen === null) throw new Error('the handler was not called')
	return seen
}

describe('the context copy when auth is not structured-cloneable', () => {
	test('an own __proto__ key stays an own data key, never a prototype', () => {
		const metadata = JSON.parse('{"__proto__":{"admin":true},"role":"viewer"}') as Record<
			string,
			unknown
		>
		metadata.refresh = () => 'token'
		const copy = received({ userId: 'u1', metadata }).auth
		if (copy === null) throw new Error('auth was dropped')
		const meta = copy.metadata ?? {}
		expect(Object.hasOwn(meta, '__proto__')).toBe(true)
		expect(Object.getPrototypeOf(meta)).toBe(Object.prototype)
		expect((meta as { admin?: unknown }).admin).toBeUndefined()
		expect(Object.getOwnPropertyDescriptor(meta, '__proto__')?.value).toEqual({ admin: true })
		expect(meta.role).toBe('viewer')
		expect('refresh' in meta).toBe(false)
	})

	test('keeps every cloneable value and drops only what cannot be cloned', () => {
		const since = new Date(5)
		const roles = new Set<unknown>(['admin', () => 'dropped'])
		const limits = new Map<unknown, unknown>([
			['daily', { max: 3, at: new Date(7) }],
			['hook', () => 'dropped'],
		])
		const metadata: Record<string, unknown> = {
			refresh: () => 'token',
			since,
			roles,
			limits,
			plan: new Plan('pro'),
			bytes: new Uint8Array([1, 2]),
			list: [1, () => 'dropped', new Date(9)],
			nested: { when: new Date(11), callback() {} },
		}
		const auth: AuthContext = { userId: 'u1', metadata }
		const copy = received(auth).auth
		if (copy === null) throw new Error('auth was dropped')
		const meta = copy.metadata ?? {}

		expect('refresh' in meta).toBe(false)
		expect(meta.since).toBeInstanceOf(Date)
		expect((meta.since as Date).getTime()).toBe(5)
		expect(meta.since).not.toBe(since)
		expect(meta.roles).toBeInstanceOf(Set)
		expect([...(meta.roles as Set<unknown>)]).toEqual(['admin'])
		expect(meta.limits).toBeInstanceOf(Map)
		const limitsCopy = meta.limits as Map<string, { max: number; at: Date }>
		expect([...limitsCopy.keys()]).toEqual(['daily'])
		expect(limitsCopy.get('daily')?.at).toBeInstanceOf(Date)
		expect(limitsCopy.get('daily')?.at.getTime()).toBe(7)
		// As structuredClone does: a class instance's own data, without its prototype.
		expect(meta.plan).toEqual({ tier: 'pro' })
		expect(meta.bytes).toBeInstanceOf(Uint8Array)
		expect([...(meta.bytes as Uint8Array)]).toEqual([1, 2])
		// An array keeps its positions: an element that cannot be cloned reads undefined.
		const list = meta.list as unknown[]
		expect(list).toHaveLength(3)
		expect(list[0]).toBe(1)
		expect(list[1]).toBeUndefined()
		expect((list[2] as Date).getTime()).toBe(9)
		const nested = meta.nested as Record<string, unknown>
		expect((nested.when as Date).getTime()).toBe(11)
		expect('callback' in nested).toBe(false)

		// Frozen, Map and Set contents included; the original is untouched.
		expect(Object.isFrozen(copy)).toBe(true)
		expect(Object.isFrozen(meta)).toBe(true)
		expect(Object.isFrozen(limitsCopy.get('daily'))).toBe(true)
		expect(Object.isFrozen(list)).toBe(true)
		expect(typeof metadata.refresh).toBe('function')
		expect(roles.size).toBe(2)
		expect(limits.size).toBe(2)
	})

	test('keeps shared references and cycles', () => {
		const shared: Record<string, unknown> = { at: new Date(1) }
		const metadata: Record<string, unknown> = { a: shared, b: shared, fn: () => 0 }
		metadata.self = metadata
		const meta = received({ userId: 'u1', metadata }).auth?.metadata ?? {}
		expect(meta.a).toBe(meta.b)
		expect(meta.self).toBe(meta)
		expect(((meta.a as Record<string, unknown>).at as Date).getTime()).toBe(1)
	})
})
