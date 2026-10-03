/**
 * RT-68 repro, store half (Phase 3 red team, 2026-10-02): the documented residual of a
 * row-ONLY snapshot converges.
 *
 * A database compacted before W7 is re-materialized with row snapshots
 * ('snapshot+log'): the row alone cannot tell whether an older concurrent write is
 * already in its value, so a late, older counter delta / array add is not folded by
 * the snapshot (it stays dominant, so that the operations it reflects are never
 * counted twice). The store tracks such records as approximate and asks the server
 * for a full resync; once the record's history is back (the resync re-delivers its
 * compacted operations) the snapshot is dropped and the record is re-folded from its
 * operations: it converges to the state every other replica holds. A scope entry
 * carrying the server's fold state replaces the snapshot the same way (see
 * `src/fold/phase3-fold-fixes.test.ts`).
 *
 * Asserts the CORRECT behaviour (fails at 827adc9: no snapshot tracking, no settle).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	HybridLogicalClock,
	createOperation,
	createVersionVector,
	defineSchema,
	foldRecord,
	materialize,
	t,
} from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { afterAll, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				stock: t.number().default(0).merge('counter'),
				tags: t.array(t.string()).default([]),
			},
		},
	},
}) as unknown as SchemaDefinition

const dir = mkdtempSync(join(tmpdir(), 'rt-68-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const T0 = Date.now() - 60_000
let seq = 0
function remote(
	node: string,
	wall: number,
	type: Operation['type'],
	data: Record<string, unknown>,
	previousData: Record<string, unknown> | null,
): Promise<Operation> {
	seq += 1
	return createOperation(
		{
			nodeId: node,
			type,
			collection: 'items',
			recordId: 'r1',
			data,
			previousData,
			sequenceNumber: seq,
			causalDeps: [],
			schemaVersion: 1,
		},
		new HybridLogicalClock(node, { now: () => wall } as never),
	)
}

describe('RT-68: a row-only snapshot converges after a full resync', () => {
	test('the late older increment and array add are folded once the history is back', async () => {
		const insert = await remote('a', T0, 'insert', { stock: 10, tags: ['x'] }, null)
		const restock = await remote(
			'a',
			T0 + 300,
			'update',
			{ stock: 15, tags: ['x', 'y'] },
			{ stock: 10, tags: ['x'] },
		)
		const late = await remote(
			'b',
			T0 + 200,
			'update',
			{ stock: 9, tags: ['x', 'z'] },
			{ stock: 10, tags: ['x'] },
		)
		const expected = materialize(
			foldRecord([insert, restock, late], schema).state as NonNullable<
				ReturnType<typeof foldRecord>['state']
			>,
		)
		expect(expected).toEqual({ stock: 14, tags: ['x', 'z', 'y'] })

		// A beta.12 (or older) device: legacy materialization, then a pre-W7 compaction of the
		// acknowledged history.
		const path = join(dir, 'device.db')
		const legacy = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(path),
			nodeId: 'c',
			materialization: 'legacy',
		})
		await legacy.open()
		await legacy.applyRemoteOperation(insert)
		await legacy.applyRemoteOperation(restock)
		const acked = createVersionVector()
		acked.set('a', seq)
		await legacy.compact({ mode: 'after-ack', serverVector: acked })
		await legacy.close()

		// Upgrade: the compacted log re-materializes on row snapshots.
		const device = new Store({ schema, adapter: new BetterSqlite3Adapter(path), nodeId: 'c' })
		await device.open()
		try {
			expect(await device.getSnapshotRecords()).toEqual([{ collection: 'items', recordId: 'r1' }])
			await device.applyRemoteOperation(late)

			// The full resync the store asked for re-delivers the record's history...
			for (const op of [insert, restock, late]) await device.applyRemoteOperation(op)
			// ...and once the stream has caught up, the snapshot gives way to the history.
			await device.settleAfterCatchUp()
			expect(await device.getSnapshotRecords()).toEqual([])
			const { id: _id, ...row } = (await device.collection('items').findById('r1')) as Record<
				string,
				unknown
			>
			expect({ stock: row.stock, tags: row.tags }).toEqual(expected)
		} finally {
			await device.close()
		}
	})
})
