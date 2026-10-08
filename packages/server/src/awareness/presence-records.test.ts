import { describe, expect, test } from 'vitest'
import type { MaterializedRecord, ServerStore } from '../store/server-store'
import { PresenceRecords, presenceRecordKey } from './presence-records'

/** A store whose reads resolve only when the test releases them, in any order. */
function controlledStore(): {
	store: ServerStore
	rows: Map<string, MaterializedRecord>
	pending: Array<{ recordId: string; release: () => void; fail: (error: Error) => void }>
	running: () => number
	maxRunning: () => number
} {
	const rows = new Map<string, MaterializedRecord>()
	const pending: Array<{ recordId: string; release: () => void; fail: (error: Error) => void }> = []
	let running = 0
	let maxRunning = 0
	const store = {
		async queryCollection(
			_collection: string,
			options: { where?: { id?: string } },
		): Promise<MaterializedRecord[]> {
			const recordId = options.where?.id ?? ''
			// The row is read when the query runs; only its answer is held.
			const row = rows.get(recordId)
			running += 1
			maxRunning = Math.max(maxRunning, running)
			try {
				await new Promise<void>((release, fail) => pending.push({ recordId, release, fail }))
			} finally {
				running -= 1
			}
			return row ? [row] : []
		},
	} as unknown as ServerStore
	return { store, rows, pending, running: () => running, maxRunning: () => maxRunning }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('PresenceRecords', () => {
	test('reads of one record share a store read while no write touched it', async () => {
		const { store, rows, pending } = controlledStore()
		rows.set('r1', { id: 'r1', space: 'a' })
		const records = new PresenceRecords(store)
		const first = records.read('docs', 'r1')
		const second = records.read('docs', 'r1')
		await flush()
		expect(pending).toHaveLength(1)
		pending[0]?.release()
		expect((await first).stored).toEqual({ id: 'r1', space: 'a' })
		expect((await second).stored).toEqual({ id: 'r1', space: 'a' })
	})

	test('a read requested after a write never joins a read that began before it', async () => {
		const { store, rows, pending } = controlledStore()
		rows.set('r1', { id: 'r1', space: 'a' })
		const records = new PresenceRecords(store)
		const before = records.read('docs', 'r1')
		await flush()
		rows.set('r1', { id: 'r1', space: 'b' })
		records.touch([presenceRecordKey('docs', 'r1')])
		const after = records.read('docs', 'r1')
		await flush()
		expect(pending).toHaveLength(2)
		// The newer read answers first, the older one last.
		pending[1]?.release()
		pending[0]?.release()
		const older = await before
		const newer = await after
		expect(newer.stored).toEqual({ id: 'r1', space: 'b' })
		expect(records.touchedSince(presenceRecordKey('docs', 'r1'), older.asOf)).toBe(true)
		expect(records.touchedSince(presenceRecordKey('docs', 'r1'), newer.asOf)).toBe(false)
		// Only the current read is reused.
		expect(records.peek('docs', 'r1')?.stored).toEqual({ id: 'r1', space: 'b' })
	})

	test('a write to the record ends reuse of its read; writes to other records do not', async () => {
		const { store, rows, pending } = controlledStore()
		rows.set('r1', { id: 'r1', space: 'a' })
		const records = new PresenceRecords(store)
		const read = records.read('docs', 'r1')
		await flush()
		pending[0]?.release()
		await read
		expect(records.peek('docs', 'r1')).toBeDefined()
		records.touch([presenceRecordKey('docs', 'other')])
		expect(records.peek('docs', 'r1')).toBeDefined()
		records.touch([presenceRecordKey('docs', 'r1')])
		expect(records.peek('docs', 'r1')).toBeUndefined()
	})

	test('a touch of every record ends reuse and marks every earlier read', async () => {
		const { store, pending } = controlledStore()
		const records = new PresenceRecords(store)
		const read = records.read('docs', 'r1')
		await flush()
		pending[0]?.release()
		const { asOf } = await read
		records.touch(null)
		expect(records.peek('docs', 'r1')).toBeUndefined()
		expect(records.touchedSince(presenceRecordKey('docs', 'r1'), asOf)).toBe(true)
		expect(records.touchedSince(presenceRecordKey('docs', 'never-read'), asOf)).toBe(true)
	})

	test('reuse expires after a second even without writes', async () => {
		const { store, pending } = controlledStore()
		let now = 1_000
		const records = new PresenceRecords(store, () => now)
		const read = records.read('docs', 'r1')
		await flush()
		pending[0]?.release()
		await read
		expect(records.peek('docs', 'r1')).toBeDefined()
		now += 1_000
		expect(records.peek('docs', 'r1')).toBeUndefined()
	})

	test('forgetting old touches to bound memory errs on the side of "touched"', async () => {
		const { store } = controlledStore()
		const records = new PresenceRecords(store)
		const readBegan = 0
		records.touch([presenceRecordKey('docs', 'r0')])
		for (let i = 1; i <= 10_001; i++) records.touch([presenceRecordKey('docs', `r${i}`)])
		// r0's touch was forgotten; a read that began before it must still look stale.
		expect(records.touchedSince(presenceRecordKey('docs', 'r0'), readBegan)).toBe(true)
	})

	test('a failed read rejects and is not reused', async () => {
		const { store, pending } = controlledStore()
		const records = new PresenceRecords(store)
		const read = records.read('docs', 'r1')
		await flush()
		pending[0]?.fail(new Error('store unavailable'))
		await expect(read).rejects.toThrow('store unavailable')
		expect(records.peek('docs', 'r1')).toBeUndefined()
		const again = records.read('docs', 'r1')
		await flush()
		expect(pending).toHaveLength(2)
		pending[1]?.release()
		await again
	})

	test('at most 16 store reads run at once, and every queued read completes', async () => {
		const { store, pending, maxRunning } = controlledStore()
		const records = new PresenceRecords(store)
		const reads = Array.from({ length: 40 }, (_, i) => records.read('docs', `r${i}`))
		await flush()
		expect(pending).toHaveLength(16)
		for (let released = 0; released < 40; released++) {
			await flush()
			pending[released]?.release()
		}
		const results = await Promise.all(reads)
		expect(results).toHaveLength(40)
		expect(maxRunning()).toBe(16)
	})
})
