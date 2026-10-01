import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, migrate, t } from '@korajs/core'
import { afterAll, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'

// STORE-13: local migrations must be atomic/idempotent, and backfilled values
// must be represented in the op log (otherwise they never sync).
const dir = mkdtempSync(join(tmpdir(), 'store-13-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const db = () => join(dir, `db-${++n}.db`)

const v1 = defineSchema({
	version: 1,
	collections: { items: { fields: { name: t.string(), qty: t.number().default(1) } } },
})

async function seed(path: string) {
	const app = createApp({ schema: v1, store: { adapter: 'better-sqlite3', name: path } })
	await app.ready
	await (app as unknown as Record<string, any>).items.insert({ name: 'w', qty: 1 })
	await app.close()
}

describe('STORE-13 migrations', () => {
	test('a failed migration leaves no partial effect and a retry applies the backfill once', async () => {
		const path = db()
		await seed(path)
		let fail = true
		const v2 = defineSchema({
			version: 2,
			collections: { items: { fields: { name: t.string(), qty: t.number().default(1) } } },
			migrations: {
				2: migrate()
					.backfill('items', (r) => ({ qty: Number(r.qty) * 10 }))
					.backfill('items', () => {
						if (fail) throw new Error('crash mid-migration')
						return {}
					}),
			},
		})
		const a1 = createApp({ schema: v2, store: { adapter: 'better-sqlite3', name: path } })
		await expect(a1.ready).rejects.toThrow()
		await a1.close().catch(() => {})
		fail = false
		const a2 = createApp({ schema: v2, store: { adapter: 'better-sqlite3', name: path } })
		await a2.ready
		const [row] = await (a2 as unknown as Record<string, any>).items.where({}).exec()
		await a2.close()
		expect(row.qty).toBe(10)
	})

	test('backfilled values produce operations so they can sync', async () => {
		const path = db()
		await seed(path)
		const v2 = defineSchema({
			version: 2,
			collections: { items: { fields: { name: t.string(), qty: t.number().default(1) } } },
			migrations: { 2: migrate().backfill('items', () => ({ qty: 5 })) },
		})
		const app = createApp({ schema: v2, store: { adapter: 'better-sqlite3', name: path } })
		await app.ready
		const ops = await app.getStore().getAllOperations()
		await app.close()
		expect(
			ops.some((o) => o.type === 'update' && (o.data as Record<string, unknown>)?.qty === 5),
		).toBe(true)
	})
})
