/**
 * NEW-SEC-1 repro: route-context recordMatchesScope compares with `!==`, so a `$in`
 * scope predicate (supported by the sync path's operationMatchesScopes and
 * normalizeScopeMap) never matches: scoped query()/findById() hide the caller's own
 * records. Fails closed (availability, not a leak). Asserts CORRECT behavior.
 */
import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { createRouteContext } from '../../src/server/route-context'
import { MemoryServerStore } from '../../src/store/memory-server-store'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { text: t.string(), orgId: t.string() } } },
})

describe('NEW-SEC-1: route scope ignores $in predicates', () => {
	test('findById/query honour a $in scope like the sync path does', async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		const kora = createRouteContext(new KoraSyncServer({ store }), store)
		await kora.apply({ collection: 'notes', type: 'insert', recordId: 'n1', data: { text: 'x', orgId: 'org-a' } })
		const scope = { notes: { orgId: { $in: ['org-a', 'org-b'] } } }
		expect.soft(await kora.findById('notes', 'n1', { scope })).not.toBeNull()
		expect((await kora.query('notes', { scope })).map((r) => r.id)).toEqual(['n1'])
	})
})
