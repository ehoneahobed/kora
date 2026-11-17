import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { type Harness, createHarness } from '../repro/rt-fixture'

/**
 * A handshake's `syncQueries` is client-supplied and deduplicated on the server before the
 * session starts. It is validated and capped first, so a malformed or oversized list is
 * refused with a clear code instead of stalling the server.
 */
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), owner: t.string() } } },
})

let harness: Harness | null = null
afterEach(async () => {
	await harness?.server.stop()
	harness = null
})

function errorOf(messages: SyncMessage[]): { code?: string; retriable?: boolean } | undefined {
	return messages.find((m) => m.type === 'error') as
		| { code?: string; retriable?: boolean }
		| undefined
}

function queries(n: number): Array<{ collection: string; where: Record<string, unknown> }> {
	return Array.from({ length: n }, (_, i) => ({ collection: 'todos', where: { owner: `u${i}` } }))
}

describe('handshake syncQueries are validated and capped', () => {
	test('a list within the default cap is accepted', async () => {
		harness = await createHarness(schema, null)
		const c = await harness.login('anyone', 'node-ok', {
			syncQueries: queries(10),
		} as Partial<SyncMessage>)
		expect(errorOf(c.messages)).toBeUndefined()
		expect(c.messages.some((m) => m.type === 'handshake-response')).toBe(true)
	})

	test('more entries than the default cap (1,000) are refused with SYNC_QUERIES_LIMIT', async () => {
		harness = await createHarness(schema, null)
		const c = await harness.login('anyone', 'node-big', {
			syncQueries: queries(1001),
		} as Partial<SyncMessage>)
		expect(errorOf(c.messages)).toMatchObject({ code: 'SYNC_QUERIES_LIMIT', retriable: false })
		expect(c.messages.some((m) => m.type === 'handshake-response')).toBe(false)
	})

	test('maxSyncQueries configures the cap', async () => {
		harness = await createHarness(schema, null, { maxSyncQueries: 5 })
		const ok = await harness.login('anyone', 'node-5', {
			syncQueries: queries(5),
		} as Partial<SyncMessage>)
		expect(errorOf(ok.messages)).toBeUndefined()
		const over = await harness.login('anyone', 'node-6', {
			syncQueries: queries(6),
		} as Partial<SyncMessage>)
		expect(errorOf(over.messages)).toMatchObject({ code: 'SYNC_QUERIES_LIMIT' })
	})

	test.each([
		['not a list', 'todos'],
		['an entry without a collection', [{ where: {} }]],
		['a collection that is not a string', [{ collection: 5, where: {} }]],
		['a where that is not an object', [{ collection: 'todos', where: [] }]],
		['a null entry', [null]],
	])('a malformed list (%s) is refused with INVALID_SYNC_QUERIES', async (_label, syncQueries) => {
		harness = await createHarness(schema, null)
		const c = await harness.login('anyone', `node-${Math.random()}`, {
			syncQueries,
		} as unknown as Partial<SyncMessage>)
		expect(errorOf(c.messages)).toMatchObject({ code: 'INVALID_SYNC_QUERIES', retriable: false })
		expect(c.messages.some((m) => m.type === 'handshake-response')).toBe(false)
	})
})
