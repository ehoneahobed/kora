/**
 * SEC-6 repro: the route-context (request.kora) scope check inspects only the built
 * operation, not the stored record, so a scoped route can take over another tenant's
 * record; and query() applies limit/offset before the scope filter. Asserts CORRECT
 * behavior (fails today).
 */
import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { createRouteContext } from '../../src/server/route-context'
import { MemoryServerStore } from '../../src/store/memory-server-store'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { text: t.string(), userId: t.string() } } },
})

async function setup() {
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	const server = new KoraSyncServer({ store })
	const kora = createRouteContext(server, store)
	// Bob's records created through the same route API, unscoped (e.g. admin seed).
	for (let i = 0; i < 5; i++) {
		await kora.apply({ collection: 'notes', type: 'insert', recordId: `bob-${i}`, data: { text: `bob ${i}`, userId: 'bob' } })
	}
	await kora.apply({ collection: 'notes', type: 'insert', recordId: 'alice-1', data: { text: 'alice 1', userId: 'alice' } })
	return { store, kora }
}

const aliceScope = { scope: { notes: { userId: 'alice' } } }

describe('SEC-6: route-context scope enforcement', () => {
	test("update that sets userId to the caller's value must not take over another tenant's record", async () => {
		const { store, kora } = await setup()
		const res = await kora.apply(
			{ collection: 'notes', type: 'update', recordId: 'bob-0', data: { userId: 'alice', text: 'mine' } },
			aliceScope,
		)
		expect.soft(res.ok).toBe(false)
		expect((await store.findRecord('notes', 'bob-0'))?.userId).toBe('bob')
	})

	test("insert reusing another tenant's recordId must not overwrite it", async () => {
		const { store, kora } = await setup()
		await kora.apply(
			{ collection: 'notes', type: 'insert', recordId: 'bob-1', data: { text: 'mine', userId: 'alice' } },
			aliceScope,
		)
		expect((await store.findRecord('notes', 'bob-1'))?.userId).toBe('bob')
	})

	test('scoped query applies limit after the scope filter', async () => {
		const { kora } = await setup()
		const rows = await kora.query('notes', { limit: 1, ...aliceScope })
		expect(rows.map((r) => r.id)).toEqual(['alice-1'])
	})
})
