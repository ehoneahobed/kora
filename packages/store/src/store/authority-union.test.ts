import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { RecordFolder } from '../fold/record-folder'
import { Store } from './store'

const schema = defineSchema({
	version: 1,
	collections: {
		items: { fields: { title: t.string(), status: t.string().merge('server-authoritative') } },
	},
}) as unknown as SchemaDefinition

const dir = mkdtempSync(join(tmpdir(), 'kora-authority-union-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function open(name: string): Promise<Store> {
	const store = new Store({
		schema,
		adapter: new BetterSqlite3Adapter(join(dir, name)),
		nodeId: 'dev',
	})
	await store.open()
	return store
}

describe('authoritative node ids: the union of explicit ids (RT-75)', () => {
	test('kora:server: ids are not kept; explicit ids accumulate and survive a reopen', async () => {
		const store = await open('union.db')
		await store.setAuthoritativeNodeIds(['kora:server:d:1', 'legacy-a'])
		await store.setAuthoritativeNodeIds(['kora:server:d:2'])
		await store.setAuthoritativeNodeIds(['kora:server:d:3', 'extra-b'])
		expect(await store.loadAuthoritativeNodeIds()).toEqual(['extra-b', 'legacy-a'])
		await store.close()
		const reopened = await open('union.db')
		await reopened.setAuthoritativeNodeIds(['kora:server:d:4'])
		expect(await reopened.loadAuthoritativeNodeIds()).toEqual(['extra-b', 'legacy-a'])
		await reopened.close()
	})

	test('records are re-folded only when the explicit set grows', async () => {
		const store = await open('refold.db')
		for (let i = 0; i < 5; i++)
			await store.collection('items').insert({ title: `t${i}`, status: 's' })
		await store.setAuthoritativeNodeIds(['kora:server:d:1', 'legacy-a'])
		const refolds = vi.spyOn(RecordFolder.prototype, 'refoldInTx')
		await store.setAuthoritativeNodeIds(['kora:server:d:2'])
		await store.setAuthoritativeNodeIds(['legacy-a'])
		expect(refolds).toHaveBeenCalledTimes(0)
		await store.setAuthoritativeNodeIds(['legacy-c'])
		expect(refolds).toHaveBeenCalledTimes(5)
		refolds.mockRestore()
		await store.close()
	})
})
