import { describe, expect, test } from 'vitest'
import type { OperationInput } from '../types'
import { canonicalize, computeOperationId } from './content-hash'

describe('canonicalize', () => {
	test('sorts object keys', () => {
		const a = canonicalize({ z: 1, a: 2, m: 3 })
		const b = canonicalize({ a: 2, m: 3, z: 1 })
		expect(a).toBe(b)
		expect(a).toBe('{"a":2,"m":3,"z":1}')
	})

	test('handles nested objects with sorted keys', () => {
		const result = canonicalize({ b: { d: 1, c: 2 }, a: 3 })
		expect(result).toBe('{"a":3,"b":{"c":2,"d":1}}')
	})

	test('handles arrays preserving order', () => {
		const result = canonicalize([3, 1, 2])
		expect(result).toBe('[3,1,2]')
	})

	test('handles null', () => {
		expect(canonicalize(null)).toBe('null')
	})

	test('handles undefined', () => {
		expect(canonicalize(undefined)).toBe(undefined)
	})

	test('handles primitives', () => {
		expect(canonicalize('hello')).toBe('"hello"')
		expect(canonicalize(42)).toBe('42')
		expect(canonicalize(true)).toBe('true')
	})

	test('handles nested arrays and objects', () => {
		const result = canonicalize({ items: [{ z: 1, a: 2 }] })
		expect(result).toBe('{"items":[{"a":2,"z":1}]}')
	})

	test('produces identical output for same data regardless of property order', () => {
		const obj1 = JSON.parse('{"name":"test","value":42,"tags":["a","b"]}') as unknown
		const obj2 = JSON.parse('{"tags":["a","b"],"name":"test","value":42}') as unknown
		expect(canonicalize(obj1)).toBe(canonicalize(obj2))
	})
})

describe('computeOperationId', () => {
	const baseInput: OperationInput = {
		nodeId: 'node-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'test' },
		previousData: null,
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}

	test('produces a hex string', async () => {
		const id = await computeOperationId(baseInput, '000001000000000:00000:node-1')
		expect(id).toMatch(/^[0-9a-f]{64}$/)
	})

	test('is deterministic — same input produces same hash', async () => {
		const ts = '000001000000000:00000:node-1'
		const id1 = await computeOperationId(baseInput, ts)
		const id2 = await computeOperationId(baseInput, ts)
		expect(id1).toBe(id2)
	})

	test('different data produces different hash', async () => {
		const ts = '000001000000000:00000:node-1'
		const id1 = await computeOperationId(baseInput, ts)
		const modified = { ...baseInput, data: { title: 'different' } }
		const id2 = await computeOperationId(modified, ts)
		expect(id1).not.toBe(id2)
	})

	test('different timestamp produces different hash', async () => {
		const id1 = await computeOperationId(baseInput, '000001000000000:00000:node-1')
		const id2 = await computeOperationId(baseInput, '000001000000001:00000:node-1')
		expect(id1).not.toBe(id2)
	})

	test('property order in data does not affect hash', async () => {
		const ts = '000001000000000:00000:node-1'
		const input1 = { ...baseInput, data: { a: 1, b: 2 } }
		const input2 = { ...baseInput, data: { b: 2, a: 1 } }
		const id1 = await computeOperationId(input1, ts)
		const id2 = await computeOperationId(input2, ts)
		expect(id1).toBe(id2)
	})

	test('handles null data (delete operations)', async () => {
		const ts = '000001000000000:00000:node-1'
		const deleteInput = { ...baseInput, type: 'delete' as const, data: null }
		const id = await computeOperationId(deleteInput, ts)
		expect(id).toMatch(/^[0-9a-f]{64}$/)
	})
})
