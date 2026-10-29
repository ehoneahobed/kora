import { HybridLogicalClock, createOperation, generateUUIDv7 } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import { readAuditTraces } from './audit-trace-store'
import type { PersistedAuditTrace } from './types'

/**
 * C3b: `Store.appendAuditTrace` calls made in the same turn (a delivery batch publishes
 * every merge trace together after its commit) are written in one transaction, in call
 * order. A group that cannot be written as one is written trace by trace, so one bad row
 * never costs the others.
 */

const clock = new HybridLogicalClock('audit-queue-node')

async function traceFor(field: string, id = generateUUIDv7()): Promise<PersistedAuditTrace> {
	const operation = await createOperation(
		{
			nodeId: 'audit-queue-node',
			type: 'update',
			collection: 'todos',
			recordId: generateUUIDv7(),
			data: { title: field },
			previousData: { title: 'base' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		},
		clock,
	)
	return {
		id,
		recordedAt: Date.now(),
		eventType: 'merge:conflict',
		trace: {
			operationA: operation,
			operationB: operation,
			field,
			strategy: 'lww',
			inputA: 'a',
			inputB: 'b',
			base: 'base',
			output: 'b',
			tier: 1,
			constraintViolated: null,
			duration: 1,
		},
	}
}

class CountingAdapter extends BetterSqlite3Adapter {
	transactions = 0
	executes = 0
	override async transaction(
		fn: Parameters<BetterSqlite3Adapter['transaction']>[0],
	): Promise<void> {
		this.transactions++
		return super.transaction(fn)
	}
	override async execute(sql: string, params?: unknown[]): Promise<void> {
		if (sql.includes('_kora_audit_traces')) this.executes++
		return super.execute(sql, params)
	}
}

describe('Store.appendAuditTrace grouping', () => {
	let adapter: CountingAdapter
	let store: Store

	beforeEach(async () => {
		adapter = new CountingAdapter(':memory:')
		store = new Store({ schema: minimalSchema, adapter, nodeId: 'audit-queue-node' })
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	test('traces appended in one turn land in one transaction, each promise settles', async () => {
		const traces = await Promise.all(['a', 'b', 'c', 'd'].map((field) => traceFor(field)))
		const before = adapter.transactions
		await Promise.all(traces.map((trace) => store.appendAuditTrace(trace)))
		expect(adapter.transactions - before).toBe(1)
		expect(adapter.executes).toBe(0)
		const stored = await readAuditTraces(adapter)
		expect(stored.map((row) => row.trace.field).sort()).toEqual(['a', 'b', 'c', 'd'])
	})

	test('a single trace is written on its own, as before', async () => {
		await store.appendAuditTrace(await traceFor('solo'))
		expect(adapter.executes).toBe(1)
		expect((await readAuditTraces(adapter)).map((row) => row.trace.field)).toEqual(['solo'])
	})

	test('a trace that cannot be written costs only itself', async () => {
		const duplicateId = generateUUIDv7()
		const first = await traceFor('first', duplicateId)
		const clash = await traceFor('clash', duplicateId)
		const last = await traceFor('last')
		const outcomes = await Promise.allSettled([
			store.appendAuditTrace(first),
			store.appendAuditTrace(clash),
			store.appendAuditTrace(last),
		])
		expect(outcomes.map((outcome) => outcome.status)).toEqual([
			'fulfilled',
			'rejected',
			'fulfilled',
		])
		expect((await readAuditTraces(adapter)).map((row) => row.trace.field).sort()).toEqual([
			'first',
			'last',
		])
	})
})
