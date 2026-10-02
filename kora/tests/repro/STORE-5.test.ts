import { defineSchema, op, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

// STORE-5: app.exportBackup()/app.importBackup() (docs/guide/backup-restore.md)
// must round-trip the operation log losslessly and must not corrupt the
// importing device's identity / clocks in merge mode.
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), count: t.number().default(0) } } },
})

const mk = () => createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
const strip = (o: unknown) => JSON.parse(JSON.stringify(o))

describe('STORE-5 backup restore', () => {
	const apps: KoraApp[] = []
	afterEach(async () => {
		for (const a of apps.splice(0)) await a.close()
	})

	async function seeded(): Promise<KoraApp> {
		const a = mk()
		apps.push(a)
		await a.ready
		const todos = (a as unknown as Record<string, any>).todos
		const r = await todos.insert({ title: 'x' })
		await todos.update(r.id, { count: op.increment(2) })
		await a.mutation('rename', async (tx) => {
			await tx.todos!.update(r.id, { title: 'y' })
		})
		return a
	}

	test('replace-mode round trip preserves every operation exactly', async () => {
		const a = await seeded()
		const before = strip(await a.getStore().getAllOperations())
		const backup = await a.exportBackup()
		const res = await a.importBackup(backup, { merge: false })
		expect(res.success).toBe(true)
		const after = strip(await a.getStore().getAllOperations())
		expect(after).toEqual(before)
	})

	test('merge import into another device keeps that device identity and vector', async () => {
		const a = await seeded()
		const b = mk()
		apps.push(b)
		await b.ready
		await (b as unknown as Record<string, any>).todos.insert({ title: 'b1' })
		await (b as unknown as Record<string, any>).todos.insert({ title: 'b2' })
		const bStore = b.getStore()
		const bNode = bStore.getNodeId()
		const adapter = (bStore as unknown as { adapter: any }).adapter
		const res = await b.importBackup(await a.exportBackup(), { merge: true })
		expect(res.success).toBe(true)
		const meta = await adapter.query("SELECT value FROM _kora_meta WHERE key = 'node_id'")
		expect(meta[0].value).toBe(bNode)
		const vv = await adapter.query(
			'SELECT sequence_number FROM _kora_version_vector WHERE node_id = ?',
			[bNode],
		)
		expect(vv[0].sequence_number).toBe(2)
	})
})
