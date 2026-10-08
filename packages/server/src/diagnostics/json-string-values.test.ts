import { type Operation, defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { withContentId } from '../../tests/fixtures/content-id'
import { MemoryServerStore } from '../store/memory-server-store'
import { createSqliteServerStore } from '../store/sqlite-server-store'
import { findJsonStringValues } from './json-string-values'

const schema = defineSchema({
	version: 1,
	collections: {
		forms: { fields: { title: t.string(), fields: t.json(), settings: t.json().optional() } },
		notes: { fields: { title: t.string() } },
	},
})

let seq = 0
function insert(recordId: string, data: Record<string, unknown>): Operation {
	seq += 1
	return withContentId({
		id: '',
		nodeId: 'legacy-client',
		type: 'insert',
		collection: 'forms',
		recordId,
		data,
		previousData: null,
		timestamp: { wallTime: 1000 + seq, logical: 0, nodeId: 'legacy-client' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	})
}

describe.each([
	['memory', () => new MemoryServerStore('server-1')],
	['sqlite', () => createSqliteServerStore({ nodeId: 'server-1' })],
])('findJsonStringValues (F14, %s)', (_name, make) => {
	test('reports json fields holding encoded JSON strings, not real values', async () => {
		const store = make()
		await store.setSchema(schema)
		await store.applyRemoteOperation(insert('f-ok', { title: 'ok', fields: [{ id: 'q1' }] }))
		await store.applyRemoteOperation(insert('f-string', { title: 's', fields: '[{"id":"q1"}]' }))
		await store.applyRemoteOperation(
			insert('f-double', { title: 'd', fields: '"[]"', settings: '{"theme":"dark"}' }),
		)
		await store.applyRemoteOperation(insert('f-plain', { title: 'p', fields: 'just text' }))
		const reports = await findJsonStringValues(store, { pageSize: 2 })
		expect(reports).toEqual([
			{ collection: 'forms', field: 'fields', count: 2, sampleIds: ['f-double', 'f-string'] },
			{ collection: 'forms', field: 'settings', count: 1, sampleIds: ['f-double'] },
		])
		await store.close()
	})

	test('refuses a page or sample size that is not a positive integer', async () => {
		const store = make()
		await store.setSchema(schema)
		for (const options of [
			{ pageSize: 0 },
			{ pageSize: -1 },
			{ pageSize: 1.5 },
			{ sampleSize: -1 },
		]) {
			await expect(findJsonStringValues(store, options)).rejects.toMatchObject({
				code: 'INVALID_DIAGNOSTIC_OPTIONS',
			})
		}
		expect(await findJsonStringValues(store, { sampleSize: 0 })).toEqual([])
		await store.close()
	})
})
