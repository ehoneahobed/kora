import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, migrate, t } from '@korajs/core'
import { afterAll, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'

// NEW-STORE-1: migrate().backfill(transform) documents "the transform receives
// each record"; it must receive the deserialized record (booleans, arrays), not
// the raw SQLite row.
const dir = mkdtempSync(join(tmpdir(), 'new-store-1-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('backfill transform sees typed record values', async () => {
	const path = join(dir, 'db.db')
	const v1 = defineSchema({
		version: 1,
		collections: { items: { fields: { done: t.boolean().default(false), tags: t.array(t.string()).default([]) } } },
	})
	const a = createApp({ schema: v1, store: { adapter: 'better-sqlite3', name: path } })
	await a.ready
	await (a as unknown as Record<string, any>).items.insert({ done: true, tags: ['x'] })
	await a.close()

	const seen: Array<Record<string, unknown>> = []
	const v2 = defineSchema({
		version: 2,
		collections: { items: { fields: { done: t.boolean().default(false), tags: t.array(t.string()).default([]) } } },
		migrations: { 2: migrate().backfill('items', (r) => (seen.push(r), {})) },
	})
	const b = createApp({ schema: v2, store: { adapter: 'better-sqlite3', name: path } })
	await b.ready
	await b.close()
	expect(seen[0]?.done).toBe(true)
	expect(seen[0]?.tags).toEqual(['x'])
})
