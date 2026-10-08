/**
 * Until the sync server enforces access rules (beta.15 access steps 3 and 4), a schema
 * that declares them is refused: running with rules the server ignores would let every
 * signed-in user read and write those collections.
 */
import { defineSchema, owner, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createHarness } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: { userId: t.string(), body: t.string() },
			access: { read: owner('userId'), write: owner('userId') },
		},
	},
})

describe('access rules before enforcement', () => {
	test('a server built on a store with an access schema is refused', async () => {
		const store = new MemoryServerStore('server')
		await store.setSchema(schema)
		expect(() => new KoraSyncServer({ store })).toThrow(/does not enforce yet/)
	})

	test('a schema set after construction gets no sessions', async () => {
		const auth = new TokenAuthProvider({
			validate: async (token) => (token === 'alice' ? { userId: 'alice' } : null),
		})
		const plain = defineSchema({
			version: 1,
			collections: { notes: { fields: { userId: t.string(), body: t.string() } } },
		})
		const harness = await createHarness(plain, auth)
		await harness.store.setSchema(schema)
		const alice = await harness.login('alice', 'alice-node')
		const error = alice.messages.find((m) => m.type === 'error')
		expect(error && 'code' in error ? error.code : null).toBe('ACCESS_RULES_NOT_ENFORCED')
		expect(alice.messages.some((m) => m.type === 'handshake-response')).toBe(false)
	})
})
