import { HybridLogicalClock, createOperation } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { isSameStoredOperation } from './duplicate-identity'

async function op(overrides: Partial<Parameters<typeof createOperation>[0]> = {}) {
	return createOperation(
		{
			nodeId: 'dev',
			type: 'update',
			collection: 'notes',
			recordId: 'r1',
			data: { title: 'y' },
			previousData: { title: 'x' },
			sequenceNumber: 3,
			causalDeps: ['b', 'a'],
			schemaVersion: 1,
			...overrides,
		},
		new HybridLogicalClock('dev'),
	)
}

describe('isSameStoredOperation (RT-77)', () => {
	test('the same operation, through JSON and with causalDeps reordered, is the same', async () => {
		const stored = await op()
		const upload = JSON.parse(JSON.stringify(stored)) as Operation
		expect(isSameStoredOperation(upload, stored)).toBe(true)
		expect(isSameStoredOperation({ ...upload, causalDeps: ['a', 'b'] }, stored)).toBe(true)
	})

	test('any covered field changed under the same id is not the same', async () => {
		const stored = await op()
		const changes: Array<Partial<Operation>> = [
			{ type: 'delete', data: null, previousData: null },
			{ collection: 'posts' },
			{ recordId: 'r2' },
			{ data: { title: 'z' } },
			{ previousData: { title: 'w' } },
			{ sequenceNumber: 4 },
			{ causalDeps: ['a'] },
			{ schemaVersion: 2 },
			{ timestamp: { ...stored.timestamp, logical: stored.timestamp.logical + 1 } },
			{ hashVersion: 1 },
		]
		for (const change of changes) {
			expect(isSameStoredOperation({ ...stored, ...change }, stored)).toBe(false)
		}
		expect(isSameStoredOperation({ ...stored, id: 'other' }, stored)).toBe(false)
	})

	test('version 1: the fields a beta.13 id covers; a renumbered own op and restored nulls match', async () => {
		const base = await op({ previousData: { title: 'x', assignee: 'bob' } })
		const { hashVersion: _v, ...legacy } = base
		// The server stored the beta.13 clear with the field null and declared version 1.
		const stored: Operation = { ...legacy, data: { title: 'y', assignee: null }, hashVersion: 1 }
		expect(isSameStoredOperation(legacy, stored)).toBe(true)
		expect(isSameStoredOperation({ ...legacy, sequenceNumber: 9 }, stored)).toBe(true)
		expect(isSameStoredOperation({ ...legacy, type: 'delete', data: null }, stored)).toBe(false)
		expect(isSameStoredOperation({ ...legacy, data: { title: 'z' } }, stored)).toBe(false)
	})

	test('an envelope matches on its header, whatever ciphertext a re-upload carries', async () => {
		const stored = {
			...(await op()),
			data: null,
			previousData: null,
			encrypted: { v: 2, ct: 'AAA' },
		} as unknown as Operation
		const upload = { ...stored, encrypted: { v: 2, ct: 'BBB' } } as unknown as Operation
		expect(isSameStoredOperation(upload, stored)).toBe(true)
		expect(isSameStoredOperation({ ...upload, recordId: 'r9' }, stored)).toBe(false)
		expect(isSameStoredOperation({ ...upload, encrypted: undefined }, stored)).toBe(false)
	})
})
