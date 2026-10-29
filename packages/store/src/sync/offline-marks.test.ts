import type { OfflineCompletion, OfflineCompletionMark } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import {
	clearOfflineMarks,
	deleteOfflineViewMarks,
	loadOfflineMarks,
	openOfflineUnit,
} from './offline-marks'
import { saveUnappliedOperations } from './sync-durability'
import { deleteDeliveryWatermark, loadDeliveryWatermark, saveDeliveryWatermark } from './sync-state'

async function openAdapter(): Promise<BetterSqlite3Adapter> {
	const adapter = new BetterSqlite3Adapter(':memory:')
	await adapter.open(minimalSchema)
	return adapter
}

function mark(overrides: Partial<OfflineCompletionMark> = {}): OfflineCompletionMark {
	return {
		signature: '',
		watermark: 10,
		scopeKey: 'none',
		subsets: [],
		rulesKey: null,
		principal: null,
		collectionsKey: 'notes',
		at: 1_000,
		...overrides,
	}
}

function completion(
	overrides: Partial<OfflineCompletionMark> = {},
	unitId: string | null = null,
): OfflineCompletion {
	return { mark: mark(overrides), unitId }
}

describe('completion marks (_kora_meta)', () => {
	test('a mark is stored with the watermark in one transaction', async () => {
		const adapter = await openAdapter()
		await saveDeliveryWatermark(adapter, '', 10, completion())
		expect(await loadDeliveryWatermark(adapter, '')).toBe(10)
		expect((await loadOfflineMarks(adapter)).marks).toEqual([mark()])
	})

	test('a failing transaction leaves neither the watermark nor the mark', async () => {
		const adapter = await openAdapter()
		await expect(
			adapter.transaction(async (tx) => {
				await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', ['x', '1'])
				throw new Error('rollback')
			}),
		).rejects.toThrow('rollback')
		await saveDeliveryWatermark(adapter, '', 3)
		expect((await loadOfflineMarks(adapter)).marks).toEqual([])
	})

	test('marks never go backward within one view', async () => {
		const adapter = await openAdapter()
		await saveDeliveryWatermark(adapter, '', 20, completion({ watermark: 20, at: 2_000 }))
		await saveDeliveryWatermark(adapter, '', 20, completion({ watermark: 10, at: 3_000 }))
		const { marks } = await loadOfflineMarks(adapter)
		expect(marks).toHaveLength(1)
		expect(marks[0]?.watermark).toBe(20)
	})

	test('a lower final under other rules replaces the mark', async () => {
		const adapter = await openAdapter()
		await saveDeliveryWatermark(adapter, '', 20, completion({ watermark: 20 }))
		await saveDeliveryWatermark(adapter, '', 5, completion({ watermark: 5, rulesKey: 'k2' }))
		expect((await loadOfflineMarks(adapter)).marks[0]?.rulesKey).toBe('k2')
	})

	test('views with signatures containing separators keep separate marks and unit keys', async () => {
		const adapter = await openAdapter()
		const a = '{"scope":null,"subsets":["todos:{\\"a\\":1}"]}'
		const b = '{"scope":null,"subsets":["todos:{\\"a\\":2}"]}'
		await saveDeliveryWatermark(adapter, a, 4, completion({ signature: a, watermark: 4 }))
		await saveDeliveryWatermark(adapter, b, 6, completion({ signature: b, watermark: 6 }))
		await openOfflineUnit(adapter, { signature: a, unitId: 's.4', base: 4, upTo: 9 })
		const snapshot = await loadOfflineMarks(adapter)
		expect(snapshot.marks.map((m) => m.signature).sort()).toEqual([a, b].sort())
		expect(snapshot.units).toEqual([{ signature: a, unitId: 's.4', base: 4, upTo: 9 }])
	})

	test('clearOfflineMarks removes marks only', async () => {
		const adapter = await openAdapter()
		await saveDeliveryWatermark(adapter, '', 10, completion())
		await openOfflineUnit(adapter, { signature: '', unitId: 's.0', base: 0, upTo: 30 })
		await clearOfflineMarks(adapter)
		const snapshot = await loadOfflineMarks(adapter)
		expect(snapshot.marks).toEqual([])
		expect(snapshot.units).toHaveLength(1)
		expect(await loadDeliveryWatermark(adapter, '')).toBe(10)
	})

	test('the final batch closes its own unit key and every key it covers, and no other', async () => {
		const adapter = await openAdapter()
		await openOfflineUnit(adapter, { signature: '', unitId: 'a.0', base: 0, upTo: 10 })
		await openOfflineUnit(adapter, { signature: '', unitId: 'b.5', base: 5, upTo: 12 })
		await openOfflineUnit(adapter, { signature: '', unitId: 'c.5', base: 5, upTo: 40 })
		await openOfflineUnit(adapter, { signature: 'other', unitId: 'd.0', base: 0, upTo: 5 })
		await saveDeliveryWatermark(adapter, '', 12, completion({ watermark: 12 }, 'b.5'))
		const ids = (await loadOfflineMarks(adapter)).units.map((u) => u.unitId).sort()
		expect(ids).toEqual(['c.5', 'd.0'])
	})

	test('a stalled unit above the final watermark keeps its key (the view stays open)', async () => {
		const adapter = await openAdapter()
		await openOfflineUnit(adapter, { signature: '', unitId: 'newer.0', base: 0, upTo: 20 })
		await saveDeliveryWatermark(adapter, '', 10, completion({ watermark: 10 }, 'older.0'))
		const snapshot = await loadOfflineMarks(adapter)
		expect(snapshot.units.map((u) => u.unitId)).toEqual(['newer.0'])
		expect(snapshot.marks[0]?.watermark).toBe(10)
	})

	test('an unreadable unit key blocks every view (infinite frontier)', async () => {
		const adapter = await openAdapter()
		await adapter.execute('INSERT INTO _kora_meta (key, value) VALUES (?, ?)', [
			'offline_unit_open:view:garbage',
			'not json',
		])
		const [unit] = (await loadOfflineMarks(adapter)).units
		expect(unit?.upTo).toBe(Number.POSITIVE_INFINITY)
		// It is never deleted by a completion.
		await saveDeliveryWatermark(adapter, '', 10, completion())
		expect((await loadOfflineMarks(adapter)).units).toHaveLength(1)
	})

	test('evicting a view watermark deletes its mark and unit keys', async () => {
		const adapter = await openAdapter()
		await saveDeliveryWatermark(adapter, 'v1', 5, completion({ signature: 'v1', watermark: 5 }))
		await saveDeliveryWatermark(adapter, 'v2', 6, completion({ signature: 'v2', watermark: 6 }))
		await openOfflineUnit(adapter, { signature: 'v1', unitId: 'x.0', base: 0, upTo: 9 })
		await deleteDeliveryWatermark(adapter, 'v1')
		await deleteOfflineViewMarks(adapter, 'v1')
		const snapshot = await loadOfflineMarks(adapter)
		expect(snapshot.marks.map((m) => m.signature)).toEqual(['v2'])
		expect(snapshot.units).toEqual([])
	})

	test('a quarantine write with a final completion sets the mark in the same transaction', async () => {
		const adapter = await openAdapter()
		await saveUnappliedOperations(adapter, [], {
			signature: '',
			watermark: 8,
			completion: completion({ watermark: 8 }),
		})
		expect(await loadDeliveryWatermark(adapter, '')).toBe(8)
		expect((await loadOfflineMarks(adapter)).marks[0]?.watermark).toBe(8)
	})
})
