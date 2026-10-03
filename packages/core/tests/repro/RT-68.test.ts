/**
 * RT-68 repro (Phase 3 red team, 2026-10-02): a row-based base snapshot drops every
 * late concurrent write older than the row's field version.
 *
 * A device re-materializes with row snapshots (`createSnapshotState`) when its log
 * was compacted before W7 ('snapshot+log') or holds ANY quarantined row ('kept': then
 * every record of the database becomes a snapshot). The snapshot stamps each field at
 * its version with a sentinel id that dominates every operation of that HLC, and
 * clears / resets older history. A concurrent operation that was offline (HLC older
 * than the field version) and arrives afterwards is folded by every other replica
 * (counters add the delta, arrays add the element, richtext merges the Yjs update)
 * but is ignored by the snapshot replica: permanent divergence on that device for
 * exactly the offline-concurrent writes Kora exists to merge. The same applies to
 * server stores that keep pre-fold rows of an unclean log.
 *
 * Asserts the CORRECT behaviour (fails at 959b791): the snapshot replica folds the
 * late operation like every other replica.
 */
import { describe, expect, test } from 'vitest'
import { HybridLogicalClock } from '../../src/clock/hlc'
import { foldRecord, getFoldFieldVersions, materialize, mergeOp } from '../../src/fold/fold'
import { createSnapshotState } from '../../src/fold/snapshot'
import { defineSchema } from '../../src/schema/define'
import { t } from '../../src/schema/types'
import type { HLCTimestamp, Operation } from '../../src/types'

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
})

const ts = (wallTime: number, nodeId: string): HLCTimestamp => ({ wallTime, logical: 0, nodeId })
function op(p: Partial<Operation> & Pick<Operation, 'id' | 'nodeId' | 'timestamp'>): Operation {
	return {
		type: 'update',
		collection: 'items',
		recordId: 'r1',
		data: null,
		previousData: null,
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...p,
	}
}

describe('RT-68: row snapshot vs a late concurrent operation', () => {
	test('a late older increment and a late older array add are kept', () => {
		const insert = op({
			id: 'i',
			nodeId: 'a',
			type: 'insert',
			timestamp: ts(100, 'a'),
			data: { stock: 10, tags: ['x'] },
		})
		const restock = op({
			id: 'u',
			nodeId: 'a',
			timestamp: ts(300, 'a'),
			data: { stock: 15, tags: ['x', 'y'] },
			previousData: { stock: 10, tags: ['x'] },
		})
		// Written offline on device b at t=200, uploaded after device c's snapshot.
		const late = op({
			id: 'late',
			nodeId: 'b',
			timestamp: ts(200, 'b'),
			data: { stock: 9, tags: ['x', 'z'] },
			previousData: { stock: 10, tags: ['x'] },
		})

		const full = foldRecord([insert, restock, late], schema).state
		expect(full).not.toBeNull()
		const expected = materialize(full as NonNullable<typeof full>)
		expect(expected).toEqual({ stock: 14, tags: ['x', 'z', 'y'] })

		// Device c held insert + restock; its row becomes the base snapshot.
		const known = foldRecord([insert, restock], schema).state
		const versions = getFoldFieldVersions(known as NonNullable<typeof known>)
		const row = materialize(known as NonNullable<typeof known>) as Record<string, unknown>
		const snapshot = createSnapshotState(
			{
				collection: 'items',
				recordId: 'r1',
				values: row,
				fieldVersions: versions?.fields ?? {},
				created: versions?.created ?? ts(0, 'x'),
				latest: versions?.latest ?? ts(0, 'x'),
				deleted: false,
			},
			schema,
		)
		const after = mergeOp(snapshot, late, schema).state
		expect(materialize(after)).toEqual(expected)
		expect(HybridLogicalClock.compare(late.timestamp, restock.timestamp)).toBeLessThan(0)
	})
})
