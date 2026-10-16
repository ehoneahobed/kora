/**
 * A schema that declares access rules is always enforced. What cannot be judged is
 * refused instead of served unchecked: a store with no membership index, and a session
 * that started streaming before the schema declared rules.
 */
import { defineSchema, owner, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { LogEntry } from '../../src/logging/structured-logger'
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

describe('access rules are always enforced', () => {
	test('a built-in store installs an access schema with no option', async () => {
		const store = new MemoryServerStore('server')
		await store.setSchema(schema)
		expect(store.getSchema()?.access).toBeDefined()
		expect(() => new KoraSyncServer({ store })).not.toThrow()
	})

	test('a store without a membership index is refused for an access schema', async () => {
		const store = new MemoryServerStore('server')
		await store.setSchema(schema)
		const custom = Object.assign(Object.create(store) as MemoryServerStore, {
			getMembershipIntervals: undefined,
		})
		expect(() => new KoraSyncServer({ store: custom })).toThrow(/keeps no membership index/)
	})

	test('the experimental option is accepted with a deprecation warning', async () => {
		const store = new MemoryServerStore('server')
		await store.setSchema(schema)
		const logs: LogEntry[] = []
		new KoraSyncServer({
			store,
			experimentalAccessRules: true,
			logger: { log: (entry) => logs.push(entry) },
		})
		expect(logs).toContainEqual(
			expect.objectContaining({
				level: 'warn',
				event: 'server.option_deprecated',
				details: expect.objectContaining({ option: 'experimentalAccessRules' }),
			}),
		)
	})

	test('a live session is closed when access rules appear under it, before it writes or receives', async () => {
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
		await harness.server.getKoraContext().apply({
			collection: 'notes',
			type: 'insert',
			recordId: 'n0',
			data: { userId: 'bob', body: 'before' },
		})
		// A custom store whose schema changes under a live session: its read grant was
		// never compiled.
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
		expect(error && 'code' in error ? error.code : null).toBe('ACCESS_RULES_CHANGED')
	})

	test('rules installed while a handshake reads the store refuse it before anything is sent', async () => {
		const auth = new TokenAuthProvider({
			validate: async (token) => (token === 'alice' ? { userId: 'alice' } : null),
		})
		const plain = defineSchema({
			version: 1,
			collections: { notes: { fields: { userId: t.string(), body: t.string() } } },
		})
		const harness = await createHarness(plain, auth)
		await harness.server.getKoraContext().apply({
			collection: 'notes',
			type: 'insert',
			recordId: 'n1',
			data: { userId: 'bob', body: 'secret' },
		})
		// The schema changes after the handshake read it, during one of its later reads.
		const read = harness.store.getMaxDeliverySequence.bind(harness.store)
		harness.store.getMaxDeliverySequence = async () => {
			harness.store.getSchema = () => schema
			return read()
		}
		const alice = harness.connect()
		alice.send({
			type: 'handshake',
			messageId: 'hs-alice',
			nodeId: 'alice-node',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'alice',
			supportsScopeDisjunction: true,
			lastDeliverySequence: 0,
		} as SyncMessage)
		await tick(150)
		expect(alice.messages.some((m) => m.type === 'handshake-response')).toBe(false)
		expect(alice.messages.some((m) => m.type === 'operation-batch')).toBe(false)
		const error = alice.messages.find((m) => m.type === 'error')
		expect(error && 'code' in error ? error.code : null).toBe('ACCESS_RULES_CHANGED')
	})
})
