import { HybridLogicalClock, createOperation, generateUUIDv7 } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import { appendAuditTrace, readAuditTraces } from './audit-trace-store'
import { decodeAuditExport, exportAudit, verifyAuditExportChecksum } from './export-audit'
import type { PersistedAuditTrace } from './types'

const clock = new HybridLogicalClock('audit-test-node')

async function sampleTrace(): Promise<PersistedAuditTrace> {
	const recordId = generateUUIDv7()
	const opA = await createOperation(
		{
			nodeId: 'audit-test-node',
			type: 'update',
			collection: 'todos',
			recordId,
			data: { title: 'local' },
			previousData: { title: 'base' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		},
		clock,
	)
	const opB = await createOperation(
		{
			nodeId: 'remote-node',
			type: 'update',
			collection: 'todos',
			recordId,
			data: { title: 'remote' },
			previousData: { title: 'base' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		},
		clock,
	)

	return {
		id: generateUUIDv7(),
		recordedAt: Date.now(),
		eventType: 'merge:conflict',
		trace: {
			operationA: opA,
			operationB: opB,
			field: 'title',
			strategy: 'lww',
			inputA: 'local',
			inputB: 'remote',
			base: 'base',
			output: 'remote',
			tier: 1,
			constraintViolated: null,
			duration: 1,
		},
	}
}

describe('audit export', () => {
	let store: Store
	let adapter: BetterSqlite3Adapter

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema: minimalSchema, adapter, nodeId: 'audit-test-node' })
		await store.open()
	})

	afterEach(async () => {
		await store.close()
	})

	test('persists and reads audit traces', async () => {
		const trace = await sampleTrace()
		await appendAuditTrace(adapter, trace)

		const rows = await readAuditTraces(adapter)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.eventType).toBe('merge:conflict')
		expect(rows[0]?.trace.field).toBe('title')
	})

	test('exports operations and merge traces with valid checksum', async () => {
		await store.collection('todos').insert({ title: 'Audit me' })
		await appendAuditTrace(adapter, await sampleTrace())

		const exported = await exportAudit(adapter, minimalSchema, 'audit-test-node', 1)
		expect(await verifyAuditExportChecksum(exported)).toBe(true)

		const decoded = decodeAuditExport(exported)
		expect(decoded.manifest.operationCount).toBeGreaterThan(0)
		expect(decoded.manifest.mergeTraceCount).toBe(1)
		expect(decoded.mergeTraces[0]?.trace.strategy).toBe('lww')
	})
})
