/**
 * SEC-7 repro: buildSelectQuery interpolates orderBy direction, limit and offset into
 * SQL without validation. TypeScript types constrain them, but values that reach the
 * query builder from untrusted runtime input (URL params cast to the type) are
 * injected verbatim. Asserts CORRECT behavior (fails today).
 */
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import type { OrderByDirection } from '../../src/types'
import { Store } from '../../src/store/store'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { title: t.string() } },
		secrets: { fields: { value: t.string() } },
	},
})

let store: Store | null = null
afterEach(async () => {
	await store?.close()
	store = null
})

async function open(): Promise<Store> {
	store = new Store({ schema, adapter: new BetterSqlite3Adapter(':memory:') })
	await store.open()
	await store.collection('notes').insert({ title: 'n1' })
	await store.collection('secrets').insert({ value: 'TOP-SECRET' })
	return store
}

describe('SEC-7: SQL injection via orderBy direction / limit / offset', () => {
	test('a non asc/desc direction is rejected instead of being spliced into SQL', async () => {
		const s = await open()
		// e.g. `?dir=` from a URL, cast to the declared type.
		// Boolean oracle over another collection: rows come back iff the secret starts with TOP.
		const dir = "ASC LIMIT (SELECT COUNT(*) FROM secrets WHERE value LIKE 'TOP%')" as OrderByDirection
		let rows: unknown[] = []
		let threw = false
		try {
			rows = await s.collection('notes').where({}).orderBy('title', dir).exec()
		} catch {
			threw = true
		}
		// Injection evidence: the oracle returned a row (secret matched) instead of an error.
		expect.soft(rows).toHaveLength(0)
		expect(threw).toBe(true)
	})

	test('a non-integer limit/offset is rejected instead of being spliced into SQL', async () => {
		const s = await open()
		const evil = "(SELECT CASE WHEN (SELECT value FROM secrets) LIKE 'TOP%' THEN 10 ELSE 0 END)" as unknown as number
		let threw = false
		let rows: unknown[] = []
		try {
			rows = await s.collection('notes').where({}).limit(evil).exec()
		} catch {
			threw = true
		}
		// Injection evidence: the oracle returned a row (secret matched) instead of an error.
		expect.soft(rows).toHaveLength(0)
		expect(threw).toBe(true)
	})
})
