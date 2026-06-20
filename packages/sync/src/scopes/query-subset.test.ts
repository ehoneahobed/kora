import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { dedupeQuerySubsets, operationMatchesQuerySubsets } from './query-subset'

function makeOp(
	data: Record<string, unknown>,
	previousData: Record<string, unknown> | null = null,
): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-a',
		type: 'update',
		collection: 'todos',
		recordId: 'rec-1',
		data,
		previousData,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('operationMatchesQuerySubsets', () => {
	test('passes through when no subsets are configured', () => {
		const op = makeOp({ completed: true })
		expect(operationMatchesQuerySubsets(op, undefined)).toBe(true)
	})

	test('matches when snapshot satisfies where clause', () => {
		const op = makeOp({ completed: false }, { completed: true, title: 'A' })
		expect(
			operationMatchesQuerySubsets(op, [{ collection: 'todos', where: { completed: false } }]),
		).toBe(true)
	})

	test('rejects when snapshot does not satisfy where clause', () => {
		const op = makeOp({ completed: true })
		expect(
			operationMatchesQuerySubsets(op, [{ collection: 'todos', where: { completed: false } }]),
		).toBe(false)
	})

	test('ignores subsets for other collections', () => {
		const op = makeOp({ completed: true })
		expect(
			operationMatchesQuerySubsets(op, [{ collection: 'notes', where: { published: true } }]),
		).toBe(true)
	})
})

describe('dedupeQuerySubsets', () => {
	test('removes duplicate collection/where pairs', () => {
		const input = [
			{ collection: 'todos', where: { completed: false } },
			{ collection: 'todos', where: { completed: false } },
		]
		expect(dedupeQuerySubsets(input)).toHaveLength(1)
	})
})
