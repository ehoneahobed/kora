/**
 * NEW-SRV-1: the memory store's write cost must be O(record), not O(log). Before Phase 3
 * every write rebuilt the record by filtering the ENTIRE operation log. The fold (SRV-7,
 * RT-84) merges the one new operation into the record's stored fold state, and the only
 * re-fold fallback reads the record's own operations.
 *
 * Deterministic (no timing): the fold functions are wrapped and every operation they are
 * handed while writing to one record is checked to belong to that record, with a large
 * history on OTHER records in the log.
 */
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { beforeAll, describe, expect, test, vi } from 'vitest'

const seen = vi.hoisted(() => ({ ops: [] as { recordId: string }[][] }))

vi.mock('../../src/store/record-fold', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/store/record-fold')>()
	return {
		...actual,
		refoldRecord: (ops: readonly Operation[], ...rest: unknown[]) => {
			seen.ops.push([...ops])
			return (actual.refoldRecord as (...args: unknown[]) => unknown)(ops, ...rest)
		},
		mergeIntoFoldState: (state: unknown, ops: readonly Operation[], ...rest: unknown[]) => {
			seen.ops.push([...ops])
			return (actual.mergeIntoFoldState as (...args: unknown[]) => unknown)(state, ops, ...rest)
		},
	}
})

const { MemoryServerStore } = await import('../../src/store/memory-server-store')

const schema = defineSchema({
	version: 1,
	collections: { items: { fields: { label: t.string(), n: t.number() } } },
})

let seq = 0
function op(recordId: string, i: number, type: Operation['type'] = 'update'): Operation {
	seq += 1
	return {
		id: `new-srv-1-${seq}`,
		nodeId: 'w',
		type,
		collection: 'items',
		recordId,
		data: type === 'insert' ? { label: recordId, n: 0 } : { n: i },
		previousData: type === 'insert' ? null : { n: i - 1 },
		timestamp: { wallTime: 1_700_000_000_000 + seq, logical: 0, nodeId: 'w' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('NEW-SRV-1: memory store writes fold only the written record', () => {
	const store = new MemoryServerStore('srv')

	beforeAll(async () => {
		await store.setSchema(schema)
		// 2,000 operations of history on 500 OTHER records.
		for (let r = 0; r < 500; r++) {
			await store.applyRemoteOperation(op(`other-${r}`, 0, 'insert'))
			for (let i = 1; i < 4; i++) await store.applyRemoteOperation(op(`other-${r}`, i))
		}
		await store.applyRemoteOperation(op('hot', 0, 'insert'))
	})

	test('a write hands the fold only that operation (or that record history)', async () => {
		seen.ops = []
		for (let i = 1; i <= 20; i++) await store.applyRemoteOperation(op('hot', i))
		const handed = seen.ops.flat()
		expect(handed.length).toBeGreaterThan(0)
		expect(handed.every((o) => o.recordId === 'hot')).toBe(true)
		// Incremental: each write merges exactly the one new operation.
		expect(Math.max(...seen.ops.map((batch) => batch.length))).toBeLessThanOrEqual(21)
		expect(await store.findRecord('items', 'hot')).toMatchObject({ n: 20 })
	})

	test('previewing an operation reads only that record', async () => {
		seen.ops = []
		await store.previewOperation(op('hot', 21))
		expect(seen.ops.flat().every((o) => o.recordId === 'hot')).toBe(true)
	})

	test('the record operation index holds only that record', async () => {
		const ops = await store.getRecordOperations('items', 'hot')
		expect(ops).toHaveLength(21)
		expect(ops.every((o) => o.recordId === 'hot')).toBe(true)
	})
})
