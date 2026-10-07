/**
 * F12(b): how to change one key of an object or json field without reverting others.
 *
 * An update's `previousData` is the stored value at write time, and an object field
 * merges per top-level key: a key counts as written when it differs from that stored
 * value. These tests pin the documented behaviour (docs/guide/conflict-resolution.md).
 */
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'

const schema = defineSchema({
	version: 1,
	collections: {
		profiles: {
			fields: { settings: t.json<{ theme?: string; lang?: string }>() },
		},
	},
})

let store: Store | null = null
afterEach(async () => {
	await store?.close()
	store = null
})

async function setup(): Promise<{ s: Store; id: string; rendered: Record<string, unknown> }> {
	store = new Store({ schema, adapter: new BetterSqlite3Adapter(':memory:'), nodeId: 'dev' })
	await store.open()
	const row = await store
		.collection('profiles')
		.insert({ settings: { theme: 'light', lang: 'en' } })
	// The UI rendered this value; then another change to `lang` landed (a peer, or
	// another component).
	const rendered = { ...(row.settings as Record<string, unknown>) }
	await store
		.collection('profiles')
		.update(String(row.id), { settings: { ...rendered, lang: 'fr' } })
	return { s: store, id: String(row.id), rendered }
}

describe('changing one key of a json field (F12b)', () => {
	test('writing a whole object built from a stale render reverts the other key', async () => {
		const { s, id, rendered } = await setup()
		await s.collection('profiles').update(id, { settings: { ...rendered, theme: 'dark' } })
		expect((await s.collection('profiles').findById(id))?.settings).toEqual({
			theme: 'dark',
			lang: 'en',
		})
	})

	test('writing only the changed key removes the keys it leaves out', async () => {
		const { s, id } = await setup()
		await s.collection('profiles').update(id, { settings: { theme: 'dark' } })
		expect((await s.collection('profiles').findById(id))?.settings).toEqual({ theme: 'dark' })
	})

	test('merging into the current value inside a transaction changes only that key', async () => {
		const { s, id } = await setup()
		await s.transaction(async (tx) => {
			const current = await tx.collection('profiles').findById(id)
			const settings = (current?.settings ?? {}) as Record<string, unknown>
			await tx.collection('profiles').update(id, { settings: { ...settings, theme: 'dark' } })
		})
		expect((await s.collection('profiles').findById(id))?.settings).toEqual({
			theme: 'dark',
			lang: 'fr',
		})
		// Only `theme` was written: a concurrent change of `lang` elsewhere still wins.
		const ops = await s.getAllOperations()
		const last = ops[ops.length - 1]
		expect(last?.previousData).toEqual({ settings: { theme: 'light', lang: 'fr' } })
	})
})
