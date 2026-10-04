/**
 * RT-102 repro (final RC red team, STORE-12 / DX-5): the shared query-store cache (and the
 * React hook's re-subscribe key) identify a query by `JSON.stringify(descriptor)`, which
 * drops `undefined` values. `where({ projectId: undefined })` is a different query at
 * runtime (`"projectId" = ?` bound to undefined, which matches nothing, as opposed to no
 * condition), but it has the same key as `where({})`. Two components, one listing every
 * todo and one filtering by a not-yet-selected project (`where({ projectId: selected })`
 * with `selected` undefined, the usual React pattern), share ONE QueryStore: whichever
 * mounted first decides what both render. The same key also keeps `useQuery` from
 * re-running when the filter changes between `undefined` and "no filter". (`NaN` and
 * `null` collide the same way.)
 *
 * Asserts CORRECT behaviour: queries that return different rows never share a store.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { QueryBuilder } from '@korajs/store'
import { describe, expect, test } from 'vitest'

const { createApp } = await import('../../src/create-app')

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), projectId: t.string().optional() } },
	},
})

describe('RT-102: query cache key ignores undefined where values', () => {
	test('where({}) and where({ projectId: undefined }) do not share a QueryStore', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rt102-'))
		const app = createApp({ schema, store: { adapter: 'better-sqlite3', name: join(dir, 'a.db') } })
		await app.ready
		await app.todos.insert({ title: 'a', projectId: 'p1' })
		await app.todos.insert({ title: 'b' })

		const all = app.todos.where({}) as unknown as QueryBuilder<unknown>
		const selected: string | undefined = undefined
		const filtered = app.todos.where({ projectId: selected }) as unknown as QueryBuilder<unknown>
		const allRows = await all.exec()
		const filteredRows = await filtered.exec().catch(() => 'error')
		// Control: the runtime treats them as different queries.
		expect(filteredRows).not.toEqual(allRows)

		const cache = app.getQueryStoreCache()
		const a = cache.getOrCreate(all)
		const b = cache.getOrCreate(filtered)
		expect(b).not.toBe(a)

		cache.release(all)
		cache.release(filtered)
		await app.close()
		rmSync(dir, { recursive: true, force: true })
	}, 20000)
})
