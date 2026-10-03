/**
 * RT-68 repro (Phase 3 red team, 2026-10-02): a row-based base snapshot drops every
 * late concurrent write older than the row's field version.
 *
 * A device re-materializes with row snapshots (`createSnapshotState`) when its log
 * was compacted before W7 ('snapshot+log') or a record owns a quarantined row
 * ('kept'). The snapshot stamps each field at its version with a sentinel id that
 * dominates every operation of that HLC. A concurrent operation that was offline
 * (HLC older than the field version) and arrives afterwards is folded by every other
 * replica but ignored by the snapshot replica.
 *
 * Resolution (Phase 3 fix, see tracker RT-68):
 * - A snapshot is seeded from the record's stored fold state wherever the replica
 *   still has one (a `kept` record of a W7 database, a plan change): exact. Test 1.
 * - A server-authoritative field keeps the authority class of its version's writer, so
 *   a device write the server's decision beat cannot overturn it when re-merged. Test 2.
 * - A row-ONLY snapshot (no fold state left: a pre-W7 compaction, or a backup from an
 *   earlier release) cannot know whether an older write is already in the row's value,
 *   so it stays dominant (re-merging a reflected write must not double count). That
 *   residual is bounded: such records are tracked as approximate, the store requests a
 *   full resync, and the server's fold state (scope entry) or the record's restored
 *   history replaces the snapshot. Convergence is proven in
 *   `packages/store/tests/repro/RT-68.test.ts`.
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
				owner: t.string().optional().merge('server-authoritative'),
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

		// Device c held insert + restock; its row becomes the base snapshot, seeded from
		// the fold state device c still holds for the record.
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
			{ seed: known },
		)
		const after = mergeOp(snapshot, late, schema).state
		expect(materialize(after)).toEqual(expected)
		expect(HybridLogicalClock.compare(late.timestamp, restock.timestamp)).toBeLessThan(0)
	})

	test('a snapshot keeps the authority of a server-written value', () => {
		// The server's decision (t=200) beat a device write (t=250): the row shows it.
		const snapshot = createSnapshotState(
			{
				collection: 'items',
				recordId: 'r1',
				values: { stock: 1, tags: [], owner: 'approved' },
				fieldVersions: { owner: ts(200, 'kora:server:main') },
				created: ts(100, 'a'),
				latest: ts(250, 'device'),
				deleted: false,
			},
			schema,
		)
		const deviceWrite = op({
			id: 'dev',
			nodeId: 'device',
			timestamp: ts(250, 'device'),
			data: { owner: 'client' },
			previousData: { owner: null },
		})
		expect(materialize(mergeOp(snapshot, deviceWrite, schema).state)?.owner).toBe('approved')
	})
})
