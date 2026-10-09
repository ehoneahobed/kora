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
import { batch, createHarness, makeOp, tick } from '../repro/rt-fixture'

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
	test('a built-in store refuses to install an access schema', async () => {
		const store = new MemoryServerStore('server')
		await expect(store.setSchema(schema)).rejects.toThrow(/does not enforce yet/)
		expect(store.getSchema()).toBeNull()
	})

	test('a server on a (custom) store reporting an access schema is refused', () => {
		const store = new MemoryServerStore('server')
		store.getSchema = () => schema
		expect(() => new KoraSyncServer({ store })).toThrow(/does not enforce yet/)
	})

	test('a live session is closed when an access schema is installed, before it writes or receives', async () => {
		const auth = new TokenAuthProvider({
			validate: async (token) => (token === 'alice' ? { userId: 'alice' } : null),
		})
		const plain = defineSchema({
			version: 1,
			collections: { notes: { fields: { userId: t.string(), body: t.string() } } },
		})
		const harness = await createHarness(plain, auth)
		const alice = await harness.login('alice', 'alice-node')
		expect(alice.messages.some((m) => m.type === 'handshake-response')).toBe(true)
		// A custom store whose schema changes under a live session.
		await harness.server.getKoraContext().apply({
			collection: 'notes',
			type: 'insert',
			recordId: 'n0',
			data: { userId: 'bob', body: 'before' },
		})
		harness.store.getSchema = () => schema
		await harness.server.getKoraContext().apply({
			collection: 'notes',
			type: 'insert',
			recordId: 'n1',
			data: { userId: 'bob', body: 'secret' },
		})
		const write = makeOp('alice-node', 1, {
			collection: 'notes',
			recordId: 'n2',
			data: { userId: 'alice', body: 'x' },
		})
		alice.send(batch([write]))
		await tick(120)
		const delivered = alice.messages.flatMap((m) =>
			m.type === 'operation-batch' ? (m.operations as Array<{ recordId: string }>) : [],
		)
		expect(delivered.map((op) => op.recordId)).not.toContain('n1')
		expect(await harness.store.findRecord('notes', 'n2')).toBeNull()
		const error = alice.messages.find((m) => m.type === 'error')
		expect(error && 'code' in error ? error.code : null).toBe('ACCESS_RULES_NOT_ENFORCED')
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
		harness.store.getSchema = () => schema
		const alice = await harness.login('alice', 'alice-node')
		const error = alice.messages.find((m) => m.type === 'error')
		expect(error && 'code' in error ? error.code : null).toBe('ACCESS_RULES_NOT_ENFORCED')
		expect(alice.messages.some((m) => m.type === 'handshake-response')).toBe(false)
	})
})
