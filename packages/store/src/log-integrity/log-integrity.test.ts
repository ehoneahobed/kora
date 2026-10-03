import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HybridLogicalClock } from '@korajs/core'
import type { KoraEvent } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { createTestAdapter } from '../../tests/fixtures/test-adapter'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import {
	LOG_QUARANTINE_TABLE,
	checkOperationRow,
	recoverTimestamp,
	scanLogIntegrity,
} from './log-integrity'

const TS = { wallTime: 1_700_000_000_123, logical: 4, nodeId: 'node-a' }
const CANONICAL = HybridLogicalClock.serialize(TS)

/** What beta.12's restore wrote: the HLC object as JSON. */
const ONCE = JSON.stringify(TS)
/** A beta.12 database restored, re-exported and restored again. */
const TWICE = JSON.stringify(
	(() => {
		const misread = HybridLogicalClock.deserialize(ONCE)
		return JSON.parse(JSON.stringify(misread))
	})(),
)

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'op-1',
		node_id: 'node-a',
		type: 'insert',
		record_id: 'rec-1',
		data: JSON.stringify({ title: 'x', completed: false }),
		previous_data: null,
		timestamp: CANONICAL,
		sequence_number: 1,
		causal_deps: '[]',
		schema_version: 1,
		...overrides,
	}
}

async function insertRow(adapter: BetterSqlite3Adapter, values: Record<string, unknown>) {
	const cols = Object.keys(values)
	await adapter.execute(
		`INSERT INTO _kora_ops_todos (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
		cols.map((c) => values[c]),
	)
}

describe('recoverTimestamp', () => {
	test('reads a JSON-encoded HLC (one beta.12 restore)', () => {
		expect(recoverTimestamp(ONCE)).toBe(CANONICAL)
	})

	test('undoes a nested restore (restore, export, restore)', () => {
		expect(JSON.parse(TWICE).wallTime).toBeNull()
		expect(recoverTimestamp(TWICE)).toBe(CANONICAL)
	})

	test('returns null for anything else', () => {
		expect(recoverTimestamp('garbage')).toBeNull()
		expect(recoverTimestamp('{"wallTime":null,"logical":1,"nodeId":"x"}')).toBeNull()
		expect(recoverTimestamp(null)).toBeNull()
	})
})

describe('checkOperationRow', () => {
	test('a canonical row is ok', () => {
		expect(checkOperationRow(row() as never).kind).toBe('ok')
	})

	test('a JSON timestamp is repairable', () => {
		const verdict = checkOperationRow(row({ timestamp: ONCE }) as never)
		expect(verdict).toMatchObject({
			kind: 'repair',
			problem: 'timestamp-json',
			timestamp: CANONICAL,
		})
	})

	test.each([
		[{ timestamp: 'not-a-timestamp' }, 'timestamp-malformed'],
		[{ timestamp: '000000000000001:00000' }, 'timestamp-malformed'],
		[{ causal_deps: 'nope' }, 'causal-deps-malformed'],
		[{ causal_deps: '[1]' }, 'causal-deps-malformed'],
		[{ data: '[1,2]' }, 'data-malformed'],
		[{ previous_data: '{' }, 'data-malformed'],
		[{ type: 'upsert' }, 'type-invalid'],
		[{ sequence_number: 0 }, 'sequence-invalid'],
		[{ node_id: null }, 'identity-malformed'],
	])('%o is quarantined as %s', (overrides, problem) => {
		expect(checkOperationRow(row(overrides) as never)).toMatchObject({
			kind: 'quarantine',
			problem,
		})
	})
})

describe('scanLogIntegrity', () => {
	let adapter: BetterSqlite3Adapter
	afterEach(async () => {
		await adapter?.close()
	})

	test.each(['full', 'quick'] as const)('%s mode repairs and quarantines', async (mode) => {
		adapter = await createTestAdapter()
		await insertRow(adapter, row({ id: 'good', sequence_number: 1 }))
		await insertRow(adapter, row({ id: 'json', sequence_number: 2, timestamp: ONCE }))
		await insertRow(adapter, row({ id: 'nested', sequence_number: 3, timestamp: TWICE }))
		await insertRow(adapter, row({ id: 'bad', sequence_number: 4, timestamp: 'x:y' }))

		const report = await scanLogIntegrity(adapter, minimalSchema, {
			mode,
			localNodeIds: ['node-a'],
		})
		expect(report.repaired.map((r) => r.operationId).sort()).toEqual(['json', 'nested'])
		expect(report.newlyQuarantined.map((r) => r.operationId)).toEqual(['bad'])
		expect(report.quarantined.map((r) => r.operationId)).toEqual(['bad'])
		// The quarantined row was the highest number: no hole below the highest stored one.
		expect(report.gaps).toEqual([])
		expect(report.clean).toBe(false)

		const rows = await adapter.query<{ id: string; timestamp: string }>(
			'SELECT id, timestamp FROM _kora_ops_todos ORDER BY sequence_number',
		)
		expect(rows).toEqual([
			{ id: 'good', timestamp: CANONICAL },
			{ id: 'json', timestamp: CANONICAL },
			{ id: 'nested', timestamp: CANONICAL },
		])
		const kept = await adapter.query<{ row_json: string; problem: string }>(
			`SELECT row_json, problem FROM ${LOG_QUARANTINE_TABLE}`,
		)
		expect(kept).toHaveLength(1)
		expect(JSON.parse(kept[0]?.row_json ?? '{}').timestamp).toBe('x:y')

		// A second scan finds nothing new but still reports the quarantine.
		const again = await scanLogIntegrity(adapter, minimalSchema, {
			mode,
			localNodeIds: ['node-a'],
		})
		expect(again.repaired).toEqual([])
		expect(again.newlyQuarantined).toEqual([])
		expect(again.quarantined).toHaveLength(1)
		expect(again.clean).toBe(false)
	})

	test('repair: false only reports', async () => {
		adapter = await createTestAdapter()
		await insertRow(adapter, row({ timestamp: ONCE }))
		const report = await scanLogIntegrity(adapter, minimalSchema, {
			repair: false,
			localNodeIds: [],
		})
		expect(report.repaired).toHaveLength(1)
		expect(report.repairApplied).toBe(false)
		const [stored] = await adapter.query<{ timestamp: string }>(
			'SELECT timestamp FROM _kora_ops_todos',
		)
		expect(stored?.timestamp).toBe(ONCE)
	})

	test('reports gaps in own nodes only (compaction), never in remote nodes', async () => {
		adapter = await createTestAdapter()
		for (const seq of [1, 4, 5, 8]) {
			await insertRow(adapter, row({ id: `own-${seq}`, sequence_number: seq }))
			await insertRow(
				adapter,
				row({ id: `remote-${seq}`, node_id: 'node-b', sequence_number: seq }),
			)
		}
		const report = await scanLogIntegrity(adapter, minimalSchema, { localNodeIds: ['node-a'] })
		expect(report.gaps).toEqual([
			{ nodeId: 'node-a', from: 2, to: 3 },
			{ nodeId: 'node-a', from: 6, to: 7 },
		])
		expect(report.clean).toBe(false)
		expect(report.quarantined).toEqual([])
	})

	test('a canonical log is clean', async () => {
		adapter = await createTestAdapter()
		await insertRow(adapter, row({ id: 'a', sequence_number: 1 }))
		await insertRow(adapter, row({ id: 'b', sequence_number: 2 }))
		const report = await scanLogIntegrity(adapter, minimalSchema, { localNodeIds: ['node-a'] })
		expect(report).toMatchObject({ clean: true, checkedRows: 2, gaps: [], compactedAt: null })
	})
})

describe('Store log integrity', () => {
	const stores: Store[] = []
	const dir = mkdtempSync(join(tmpdir(), 'kora-log-integrity-'))
	afterEach(async () => {
		for (const store of stores.splice(0)) await store.close()
	})
	afterAll(() => rmSync(dir, { recursive: true, force: true }))

	test('open repairs a damaged log and emits store:log-integrity; verifyLogIntegrity reports', async () => {
		const path = join(dir, 'damaged.db')
		const seed = new BetterSqlite3Adapter(path)
		await seed.open(minimalSchema)
		await insertRow(seed, row({ id: 'json', timestamp: ONCE }))
		await insertRow(seed, row({ id: 'bad', sequence_number: 2, causal_deps: '{' }))
		await seed.close()
		const adapter = new BetterSqlite3Adapter(path)
		const emitter = new SimpleEventEmitter()
		const events: KoraEvent[] = []
		emitter.on('store:log-integrity', (event) => events.push(event))
		const store = new Store({ schema: minimalSchema, adapter, emitter })
		stores.push(store)
		await store.open()

		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({ repaired: 1, quarantined: 1, clean: false })
		const ops = await store.getAllOperations()
		expect(ops.map((op) => op.id)).toEqual(['json'])
		expect(ops[0]?.timestamp).toEqual(TS)

		const report = await store.verifyLogIntegrity()
		expect(report.mode).toBe('full')
		expect(report.repaired).toEqual([])
		expect(report.quarantined.map((r) => r.operationId)).toEqual(['bad'])
		expect(report.clean).toBe(false)
		expect(events).toHaveLength(1)
	})

	test('a fresh store is clean and emits nothing', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const emitter = new SimpleEventEmitter()
		const events: KoraEvent[] = []
		emitter.on('store:log-integrity', (event) => events.push(event))
		const store = new Store({ schema: minimalSchema, adapter, emitter })
		stores.push(store)
		await store.open()
		await store.collection('todos').insert({ title: 'a' })
		await store.collection('todos').insert({ title: 'b' })
		const report = await store.verifyLogIntegrity()
		expect(report.clean).toBe(true)
		expect(report.checkedRows).toBe(2)
		expect(events).toEqual([])
	})
})
