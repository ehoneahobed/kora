import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HybridLogicalClock, defineSchema, t } from '@korajs/core'
import type { KoraEvent } from '@korajs/core'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { afterAll, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'

// NEW-STORE-12 (W8 step 0, acceptance): a database whose operation log was damaged by
// beta.12's backup restore (JSON-encoded timestamps, read back as wallTime NaN/null) or
// holds unreadable rows must be repaired or quarantined on open, before anything folds
// the log, and the store must expose a log-integrity report for W7's re-materialization.
const dir = mkdtempSync(join(tmpdir(), 'new-store-12-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

test('a beta.12-restored log is repaired on open and reported', async () => {
	const path = join(dir, 'restored.db')
	const ts = { wallTime: 1_700_000_000_000, logical: 2, nodeId: 'device-a' }
	const raw = new BetterSqlite3Adapter(path)
	await raw.open(schema)
	const insert =
		'INSERT INTO _kora_ops_todos (id, node_id, type, record_id, data, previous_data, timestamp, sequence_number, causal_deps, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
	// Exactly what beta.12's restoreBackup wrote: JSON.stringify(op.timestamp).
	await raw.execute(insert, [
		'op-restored',
		'device-a',
		'insert',
		'rec-1',
		'{"title":"x"}',
		null,
		JSON.stringify(ts),
		1,
		'[]',
		1,
	])
	await raw.execute(insert, [
		'op-garbage',
		'device-a',
		'update',
		'rec-1',
		'{"title":"y"}',
		'{"title":"x"}',
		'garbage',
		2,
		'[]',
		1,
	])
	await raw.close()

	const events: KoraEvent[] = []
	const app = createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: path },
	})
	app.events.on('store:log-integrity', (event) => events.push(event))
	await app.ready
	try {
		const ops = await app.getStore().getAllOperations()
		expect(ops.map((op) => op.id)).toEqual(['op-restored'])
		expect(ops[0]?.timestamp).toEqual(ts)
		expect(HybridLogicalClock.compare(ops[0]?.timestamp ?? ts, ts)).toBe(0)

		const report = await app.getStore().verifyLogIntegrity()
		expect(report.quarantined.map((row) => row.operationId)).toEqual(['op-garbage'])
		expect(report.clean).toBe(false)
	} finally {
		await app.close()
	}
	// The open itself reported the change on the app's event stream.
	expect(events).toHaveLength(1)
	expect(events[0]).toMatchObject({ repaired: 1, quarantined: 1, clean: false })
})
