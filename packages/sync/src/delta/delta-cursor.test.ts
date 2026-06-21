import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	createDeltaCursorFromBatch,
	decodeDeltaCursor,
	encodeDeltaCursor,
	sliceOperationsAfterCursor,
} from './delta-cursor'

function makeOp(id: string): Operation {
	return {
		id,
		nodeId: 'node-a',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: id },
		previousData: null,
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('delta cursor', () => {
	test('round-trips encode/decode', () => {
		const cursor = { lastOperationId: 'op-99', batchIndex: 2 }
		expect(decodeDeltaCursor(encodeDeltaCursor(cursor))).toEqual(cursor)
	})

	test('sliceOperationsAfterCursor resumes after last applied op', () => {
		const ops = [makeOp('op-1'), makeOp('op-2'), makeOp('op-3')]
		const sliced = sliceOperationsAfterCursor(ops, {
			lastOperationId: 'op-2',
			batchIndex: 1,
		})
		expect(sliced.map((op) => op.id)).toEqual(['op-3'])
	})

	test('createDeltaCursorFromBatch uses last operation id', () => {
		expect(createDeltaCursorFromBatch([makeOp('a'), makeOp('b')], 1)).toEqual({
			lastOperationId: 'b',
			batchIndex: 1,
		})
	})
})
