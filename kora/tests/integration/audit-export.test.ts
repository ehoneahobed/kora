import { defineSchema, t } from '@korajs/core'
import type { KoraEvent, MergeTrace, Operation } from '@korajs/core'
import { decodeAuditExport } from '@korajs/store'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

function sampleMergeTrace(opA: Operation, opB: Operation): MergeTrace {
	return {
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
	}
}

describe('app.exportAudit', () => {
	let app: KoraApp

	afterEach(async () => {
		if (app) await app.close()
	})

	test('includes persisted merge traces from the event bus', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready

		const todos = app.todos as {
			insert: (data: { title: string }) => Promise<{ id: string }>
		}

		let insertOp: Operation | null = null
		const off = app.events.on('operation:created', (event: KoraEvent) => {
			if (event.type === 'operation:created' && event.operation.type === 'insert') {
				insertOp = event.operation
			}
		})

		await todos.insert({ title: 'Audit export' })
		off()

		if (!insertOp) {
			throw new Error('expected insert operation')
		}
		const op = insertOp as Operation

		const remoteOp = {
			...op,
			id: `${op.id}-remote`,
			nodeId: 'remote-node',
			data: { title: 'remote title' },
		}

		app.events.emit({
			type: 'merge:conflict',
			trace: sampleMergeTrace(op, remoteOp),
		})

		await expect
			.poll(async () => {
				const exported = await app.exportAudit()
				return decodeAuditExport(exported).manifest.mergeTraceCount
			})
			.toBe(1)

		const exported = await app.exportAudit()
		const decoded = decodeAuditExport(exported)
		expect(decoded.mergeTraces[0]?.eventType).toBe('merge:conflict')
		expect(decoded.operations.length).toBeGreaterThan(0)
	})
})
