/**
 * RT-70 repro (Phase 3 red team, 2026-10-02): on a server whose log-integrity scan
 * quarantined a row, the first write to an affected record after the upgrade
 * re-folds it from the REMAINING log and silently drops the quarantined operation's
 * effect. When that operation was the record's insert, the record vanishes from the
 * server (and from every device that later enters it through a scope entry).
 *
 * The startup migration deliberately keeps pre-fold rows of an unclean log ("their rows
 * keep their pre-fold values until their next write"), but the next write takes the
 * "no fold state" path and re-folds from the log; nothing turns the kept row into a
 * base state the way the client's 'kept' mode does.
 *
 * Asserts the CORRECT behaviour (fails at 959b791): the kept row survives the next write.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), body: t.string().optional() } } },
})

function op(seq: number, partial: Partial<Operation>): Operation {
	return {
		id: `rt70-${seq}`,
		nodeId: 'device-a',
		type: 'insert',
		collection: 'notes',
		recordId: 'r1',
		data: {},
		previousData: null,
		timestamp: { wallTime: 1_790_000_000_000 + seq, logical: 0, nodeId: 'device-a' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	}
}

describe('RT-70: server unclean log, next write after the upgrade', () => {
	test('a record whose insert was quarantined keeps its row after an update', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rt70-'))
		const filename = join(dir, 'server.db')
		try {
			const first = createSqliteServerStore({ filename, nodeId: 'server' })
			await first.setSchema(schema)
			await first.applyRemoteOperation(op(1, { data: { title: 'kept title', body: 'b0' } }))
			expect(await first.findRecord('notes', 'r1')).toMatchObject({ title: 'kept title' })
			await first.close()

			// The database as an older release left it: one unreadable op row (here its data
			// column), no fold states, the one-time scan and the fold migration not yet run.
			const Database = createRequire(import.meta.url)('better-sqlite3')
			const raw = new Database(filename)
			raw.prepare("UPDATE operations SET data = '{broken' WHERE id = 'rt70-1'").run()
			raw.prepare('DELETE FROM kora_fold_state').run()
			raw
				.prepare(
					"DELETE FROM kora_server_meta WHERE key IN ('log_integrity_scan_v1', 'fold_plan_fingerprint')",
				)
				.run()
			raw.close()

			const upgraded = createSqliteServerStore({ filename, nodeId: 'server' })
			await upgraded.setSchema(schema)
			// The migration keeps the row (documented).
			expect(await upgraded.findRecord('notes', 'r1')).toMatchObject({ title: 'kept title' })
			await upgraded.applyRemoteOperation(
				op(2, { type: 'update', data: { body: 'b1' }, previousData: { body: 'b0' } }),
			)
			expect(await upgraded.findRecord('notes', 'r1')).toMatchObject({
				title: 'kept title',
				body: 'b1',
			})
			await upgraded.close()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
