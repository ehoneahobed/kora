import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { KoraSyncServer } from './kora-sync-server'
import { createRouteContext } from './route-context'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { text: t.string(), orgId: t.string(), rank: t.number() } } },
})

async function setup() {
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	const kora = createRouteContext(new KoraSyncServer({ store }), store)
	const rows: Array<[string, string, number]> = [
		['a1', 'org-a', 1],
		['z1', 'org-z', 2],
		['a2', 'org-a', 3],
		['b1', 'org-b', 4],
		['z2', 'org-z', 5],
		['a3', 'org-a', 6],
	]
	for (const [id, orgId, rank] of rows) {
		await kora.apply({
			collection: 'notes',
			type: 'insert',
			recordId: id,
			data: { text: id, orgId, rank },
		})
	}
	return { store, kora }
}

describe('route-context scoped reads (SEC-6, NEW-SEC-1)', () => {
	test('equality scopes paginate over in-scope records only', async () => {
		const { kora } = await setup()
		const scope = { notes: { orgId: 'org-a' } }
		const page = await kora.query('notes', { scope, orderBy: 'rank', limit: 2, offset: 1 })
		expect(page.map((r) => r.id)).toEqual(['a2', 'a3'])
	})

	test('$in scopes filter before offset/limit', async () => {
		const { kora } = await setup()
		const scope = { notes: { orgId: { $in: ['org-a', 'org-b'] } } }
		const page = await kora.query('notes', { scope, orderBy: 'rank', limit: 2, offset: 2 })
		expect(page.map((r) => r.id)).toEqual(['b1', 'a3'])
		const all = await kora.query('notes', { scope, orderBy: 'rank' })
		expect(all.map((r) => r.id)).toEqual(['a1', 'a2', 'b1', 'a3'])
	})

	test('a caller filter that contradicts the scope returns nothing', async () => {
		const { kora } = await setup()
		const rows = await kora.query('notes', {
			scope: { notes: { orgId: 'org-a' } },
			where: { orgId: 'org-z' },
		})
		expect(rows).toEqual([])
	})

	test('an unscoped collection returns nothing under a scope', async () => {
		const { kora } = await setup()
		expect(await kora.query('notes', { scope: { other: {} } })).toEqual([])
	})

	test('findById honours $in and hides out-of-scope records', async () => {
		const { kora } = await setup()
		const scope = { notes: { orgId: { $in: ['org-a'] } } }
		expect(await kora.findById('notes', 'a1', { scope })).not.toBeNull()
		expect(await kora.findById('notes', 'z1', { scope })).toBeNull()
	})
})

describe('route-context scoped writes (SEC-6)', () => {
	test("a scoped delete of another tenant's record is rejected", async () => {
		const { kora, store } = await setup()
		const res = await kora.apply(
			{ collection: 'notes', type: 'delete', recordId: 'z1' },
			{ scope: { notes: { orgId: 'org-a' } } },
		)
		expect(res.ok).toBe(false)
		expect(await store.findRecord('notes', 'z1')).not.toBeNull()
	})

	test('a scoped route cannot move its own record out of scope', async () => {
		const { kora, store } = await setup()
		const res = await kora.apply(
			{ collection: 'notes', type: 'update', recordId: 'a1', data: { orgId: 'org-z' } },
			{ scope: { notes: { orgId: 'org-a' } } },
		)
		expect(res.ok ? null : res.code).toBe('SCOPE_VIOLATION')
		expect((await store.findRecord('notes', 'a1'))?.orgId).toBe('org-a')
	})

	test('a scoped partial update of an in-scope record succeeds', async () => {
		const { kora, store } = await setup()
		const res = await kora.apply(
			{ collection: 'notes', type: 'update', recordId: 'a1', data: { text: 'edited' } },
			{ scope: { notes: { orgId: 'org-a' } } },
		)
		expect(res.ok).toBe(true)
		expect((await store.findRecord('notes', 'a1'))?.text).toBe('edited')
	})

	test('an unscoped (trusted) route may still transfer ownership', async () => {
		const { kora, store } = await setup()
		const res = await kora.apply({
			collection: 'notes',
			type: 'update',
			recordId: 'a1',
			data: { orgId: 'org-z' },
		})
		expect(res.ok).toBe(true)
		expect((await store.findRecord('notes', 'a1'))?.orgId).toBe('org-z')
	})

	test('a conditional set touching an out-of-scope record applies nothing', async () => {
		const { kora, store } = await setup()
		const res = await kora.applyConditional(
			{
				collection: 'notes',
				id: 'a1',
				update: { text: 'admitted' },
				also: [{ collection: 'notes', type: 'update', recordId: 'z1', data: { text: 'pwned' } }],
			},
			{ scope: { notes: { orgId: 'org-a' } } },
		)
		expect(res.ok ? null : res.code).toBe('SCOPE_VIOLATION')
		expect((await store.findRecord('notes', 'a1'))?.text).toBe('a1')
		expect((await store.findRecord('notes', 'z1'))?.text).toBe('z1')
	})
})
