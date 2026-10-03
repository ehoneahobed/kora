/**
 * RT-83 repro (Phase 3 red team round 3, 2026-10-03): upgrading a beta.12 (or older) database to
 * beta.13 brings back every field the user cleared with `undefined`.
 *
 * beta.12 applied `update(id, { assignee: undefined })` to the row (NULL) and logged
 * the operation as JSON, which drops the member: the log holds `data` without
 * `assignee` (or `null` data), `previousData: { assignee: 'bob' }`, no hash version.
 * beta.13's one-time fold materialization (`ensureMaterialization`, mode 'log') rebuilds
 * every row from the log, so the clear is lost and `assignee` is 'bob' again. The
 * server, since the RT-71 fix, stores the same operation with `assignee: null`; the
 * device already holds that id, so it never re-applies the server's copy: the upgraded
 * device diverges from the server and every peer for good.
 *
 * Confirmed against the unreleased Phase 1 build (33bca46) with
 * `scripts/remediation/rt3-upgrade-clear-probe.mjs` (both top-level cases revert; the
 * nested-member case keeps its value). This repro builds the beta.12 database shape with
 * the legacy materialization mode and the logged JSON beta.12 wrote.
 *
 * Asserts the CORRECT behaviour (fails at 97981a7): the cleared field stays cleared
 * after the upgrade.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { afterAll, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { title: t.string(), assignee: t.string().optional() } },
	},
}) as unknown as SchemaDefinition

const dir = mkdtempSync(join(tmpdir(), 'rt-83-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('RT-83: a beta.12 undefined-clear is lost by the upgrade re-fold', () => {
	test('a field cleared with undefined under beta.12 stays cleared after the upgrade', async () => {
		const file = join(dir, 'app.db')
		// beta.12: rows are written directly (no fold).
		const legacy = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(file),
			nodeId: 'dev',
			materialization: 'legacy',
		})
		await legacy.open()
		const row = await legacy.collection('notes').insert({ title: 'x', assignee: 'bob' })
		const id = String(row.id)
		await legacy.collection('notes').update(id, { assignee: null, title: 'y' })
		expect(await legacy.collection('notes').findById(id)).toMatchObject({ assignee: null })
		// The op log as beta.12 wrote it: JSON.stringify dropped the undefined member, and
		// beta.12 declared no hash version.
		const adapter = (legacy as unknown as { adapter: BetterSqlite3Adapter }).adapter
		await adapter.execute(
			`UPDATE _kora_ops_notes SET data = ? WHERE type = 'update' AND record_id = ?`,
			[JSON.stringify({ title: 'y' }), id],
		)
		await legacy.close()

		// beta.13 opens the same database.
		const upgraded = new Store({ schema, adapter: new BetterSqlite3Adapter(file), nodeId: 'dev' })
		await upgraded.open()
		try {
			const after = await upgraded.collection('notes').findById(id)
			expect(after).toMatchObject({ title: 'y' })
			// Correct: still cleared (fails: 'bob' is back).
			expect(after?.assignee ?? null).toBeNull()
		} finally {
			await upgraded.close()
		}
	})
})
