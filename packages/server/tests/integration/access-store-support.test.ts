/**
 * A schema that declares access rules is always enforced. What cannot be judged is
 * refused instead of served unchecked: a store with no membership index, a store rebuilding
 * it, and a session that read the schema before it declared rules (on every path).
 */
import { defineSchema, owner, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { LogEntry } from '../../src/logging/structured-logger'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import type { ClientSession } from '../../src/session/client-session'
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

	for (const moment of ['before the batch is judged', 'while the write commits'] as const) {
		test(`a write in flight when rules appear (${moment}) is not refused for good`, async () => {
			const auth = new TokenAuthProvider({
				validate: async (token) => (token === 'alice' ? { userId: 'alice' } : null),
			})
			const plain = defineSchema({
				version: 1,
				collections: { notes: { fields: { userId: t.string(), body: t.string() } } },
			})
			const harness = await createHarness(plain, auth)
			const alice = await harness.login('alice', 'alice-node')
			const before = alice.messages.length
			const store = harness.store as unknown as Record<string, unknown>
			const swapOn = (name: string) => {
				const original = store[name]
				if (typeof original !== 'function') return
				store[name] = (...args: unknown[]) => {
					harness.store.getSchema = () => schema
					return (original as (...a: unknown[]) => unknown).apply(harness.store, args)
				}
			}
			if (moment === 'before the batch is judged') swapOn('findStoredOperations')
			else for (const name of ['applyConditional', 'applyRemoteOperation']) swapOn(name)
			// Judged without alice's identity (her session never compiled a grant), her own
			// note would be refused as anonymous and the refusal remembered.
			const write = makeOp('alice-node', 1, {
				collection: 'notes',
				recordId: 'n1',
				data: { userId: 'alice', body: 'mine' },
			})
			alice.send(batch([write]))
			await tick(150)
			const after = alice.messages.slice(before)
			expect(after.some((m) => m.type === 'operation-rejected')).toBe(false)
			const error = after.find((m) => m.type === 'error')
			expect(error && 'code' in error ? error.code : null).toBe('ACCESS_RULES_CHANGED')
			const resolutions = await harness.store.findOperationResolutions?.('alice-node', [write.id])
			expect(resolutions?.get(write.id)).toBeUndefined()
		})
	}

	test('side channels (Yjs, presence, blobs) skip a session whose rules are not in force', async () => {
		const auth = new TokenAuthProvider({
			validate: async (token) => (token === 'alice' ? { userId: 'alice' } : null),
		})
		const plain = defineSchema({
			version: 1,
			collections: { notes: { fields: { userId: t.string(), body: t.string() } } },
		})
		const harness = await createHarness(plain, auth)
		const alice = await harness.login('alice', 'alice-node')
		const sessions = (harness.server as unknown as { sessions: Map<string, ClientSession> })
			.sessions
		const session = [...sessions.values()][0]
		expect(session?.canReceiveRecord('notes', 'n1', { userId: 'bob' })).toBe(true)
		harness.store.getSchema = () => schema
		// Yjs and presence audiences ask canReceiveRecord; blob policies ask isStreaming.
		expect(session?.canReceiveRecord('notes', 'n1', { userId: 'bob' })).toBe(false)
		expect(session?.isStreaming()).toBe(false)
		const error = alice.messages.find((m) => m.type === 'error')
		expect(error && 'code' in error ? error.code : null).toBe('ACCESS_RULES_CHANGED')
	})

	test('while the store rebuilds its membership index, sessions are refused retriably', async () => {
		const auth = new TokenAuthProvider({
			validate: async (token) => (token === 'alice' ? { userId: 'alice' } : null),
		})
		const harness = await createHarness(schema, auth)
		const handshake = {
			supportsScopeDisjunction: true,
			lastDeliverySequence: 0,
		} as Partial<SyncMessage>
		const live = await harness.login('alice', 'alice-node', handshake)
		expect(live.messages.some((m) => m.type === 'handshake-response')).toBe(true)
		let ready = false
		harness.store.isAccessIndexReady = () => ready
		await harness.server.getKoraContext().apply({
			collection: 'notes',
			type: 'insert',
			recordId: 'n1',
			data: { userId: 'alice', body: 'x' },
		})
		await tick(100)
		const closed = live.messages.find((m) => m.type === 'error')
		expect(closed && 'code' in closed ? closed.code : null).toBe('ACCESS_RULES_CHANGED')
		expect(closed && 'retriable' in closed ? closed.retriable : null).toBe(true)

		const during = await harness.login('alice', 'alice-node-2', handshake)
		expect(during.messages.some((m) => m.type === 'handshake-response')).toBe(false)
		ready = true
		const afterwards = await harness.login('alice', 'alice-node-3', handshake)
		expect(afterwards.messages.some((m) => m.type === 'handshake-response')).toBe(true)
	})

	test('a refusal judged while another instance rebuilds the index is not remembered', async () => {
		const auth = new TokenAuthProvider({
			validate: async (token) => (token === 'alice' ? { userId: 'alice' } : null),
		})
		const harness = await createHarness(schema, auth)
		const alice = await harness.login('alice', 'alice-node', {
			supportsScopeDisjunction: true,
			lastDeliverySequence: 0,
		} as Partial<SyncMessage>)
		const before = alice.messages.length
		// This instance has not polled yet; the shared index state says another is rebuilding.
		const read = harness.store.getAccessIndexState.bind(harness.store)
		harness.store.getAccessIndexState = async () => ({ ...(await read()), rebuilding: true })
		const write = makeOp('alice-node', 1, {
			collection: 'notes',
			recordId: 'n1',
			data: { userId: 'bob', body: 'not mine' },
		})
		alice.send(batch([write]))
		await tick(150)
		const after = alice.messages.slice(before)
		expect(after.some((m) => m.type === 'operation-rejected')).toBe(false)
		const error = after.find((m) => m.type === 'error')
		expect(error && 'code' in error ? error.code : null).toBe('ACCESS_RULES_CHANGED')
		const resolutions = await harness.store.findOperationResolutions?.('alice-node', [write.id])
		expect(resolutions?.get(write.id)).toBeUndefined()
	})

	test('a write judged inside the store after a rebuild started is not refused for good', async () => {
		const auth = new TokenAuthProvider({
			validate: async (token) => (token === 'alice' ? { userId: 'alice' } : null),
		})
		const harness = await createHarness(schema, auth)
		const alice = await harness.login('alice', 'alice-node', {
			supportsScopeDisjunction: true,
			lastDeliverySequence: 0,
		} as Partial<SyncMessage>)
		const before = alice.messages.length
		let ready = true
		harness.store.isAccessIndexReady = () => ready
		// The rebuild starts after the batch was checked, while the write waits for the store.
		const store = harness.store as unknown as Record<string, unknown>
		for (const name of ['applyConditional', 'applyRemoteOperation']) {
			const original = store[name]
			if (typeof original !== 'function') continue
			store[name] = (...args: unknown[]) => {
				ready = false
				return (original as (...a: unknown[]) => unknown).apply(harness.store, args)
			}
		}
		const write = makeOp('alice-node', 1, {
			collection: 'notes',
			recordId: 'n1',
			data: { userId: 'alice', body: 'mine' },
		})
		alice.send(batch([write]))
		await tick(150)
		const after = alice.messages.slice(before)
		expect(after.some((m) => m.type === 'operation-rejected')).toBe(false)
		expect(await harness.store.findRecord('notes', 'n1')).toBeNull()
		const resolutions = await harness.store.findOperationResolutions?.('alice-node', [write.id])
		expect(resolutions?.get(write.id)).toBeUndefined()
	})

	test('roleOf refuses to answer while the membership index is not ready', async () => {
		const auth = new TokenAuthProvider({ validate: async () => null })
		const harness = await createHarness(schema, auth)
		harness.store.isAccessIndexReady = () => false
		await expect(harness.server.access.roleOf('alice', 'notes:n1')).rejects.toMatchObject({
			context: { code: 'ACCESS_INDEX_NOT_READY' },
		})
	})

	test('a custom store without a synchronous generation is still followed through polling', async () => {
		const auth = new TokenAuthProvider({
			validate: async (token) => (token === 'alice' ? { userId: 'alice' } : null),
		})
		const store = new MemoryServerStore('server')
		// A custom store implementing only the required index methods.
		const custom = store as unknown as Record<string, unknown>
		custom.accessIndexGeneration = undefined
		custom.isAccessIndexReady = undefined
		const harness = await createHarness(schema, auth, {}, store)
		const alice = await harness.login('alice', 'alice-node', {
			supportsScopeDisjunction: true,
			lastDeliverySequence: 0,
		} as Partial<SyncMessage>)
		expect(alice.messages.some((m) => m.type === 'handshake-response')).toBe(true)
		// A replace-mode restore starts a new generation; the poll reads it.
		await store.importBackup(await store.exportBackup(), false)
		await harness.server.revalidateAccessSessions()
		const error = alice.messages.find((m) => m.type === 'error')
		expect(error && 'code' in error ? error.code : null).toBe('ACCESS_RULES_CHANGED')
	})

	for (const view of ['a synchronous view', 'no synchronous view'] as const) {
		test(`a restore while a handshake reads its memberships refuses it (${view})`, async () => {
			const auth = new TokenAuthProvider({
				validate: async (token) => (token === 'alice' ? { userId: 'alice' } : null),
			})
			const store = new MemoryServerStore('server')
			if (view === 'no synchronous view') {
				const custom = store as unknown as Record<string, unknown>
				custom.accessIndexGeneration = undefined
				custom.isAccessIndexReady = undefined
			}
			const harness = await createHarness(schema, auth, {}, store)
			const backup = await store.exportBackup()
			// The intervals are read from the index as it was; a restore (another instance's,
			// say) rotates the generation before the handshake goes on.
			const read = store.getMembershipIntervals.bind(store)
			let restored = false
			store.getMembershipIntervals = async (userId: string) => {
				const intervals = await read(userId)
				if (!restored) {
					restored = true
					await store.importBackup(backup, false)
				}
				return intervals
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
			expect(restored).toBe(true)
			expect(alice.messages.some((m) => m.type === 'handshake-response')).toBe(false)
			const error = alice.messages.find((m) => m.type === 'error')
			expect(error && 'code' in error ? error.code : null).toBe('ACCESS_RULES_CHANGED')
		})
	}

	test('rules installed while a relay reads the store stop the relay', async () => {
		const auth = new TokenAuthProvider({
			validate: async (token) => (token === 'alice' ? { userId: 'alice' } : null),
		})
		const plain = defineSchema({
			version: 1,
			collections: { notes: { fields: { userId: t.string(), body: t.string() } } },
		})
		const harness = await createHarness(plain, auth)
		// A version-vector client (no watermark): fed by relays, not the delivery stream.
		const alice = await harness.login('alice', 'alice-node')
		expect(alice.messages.some((m) => m.type === 'handshake-response')).toBe(true)
		const before = alice.messages.length
		const read = harness.store.getOperationScopeSnapshots?.bind(harness.store)
		harness.store.getOperationScopeSnapshots = async (ids) => {
			harness.store.getSchema = () => schema
			return read ? read(ids) : new Map()
		}
		await harness.server.getKoraContext().apply({
			collection: 'notes',
			type: 'insert',
			recordId: 'n1',
			data: { userId: 'bob', body: 'secret' },
		})
		await tick(150)
		const after = alice.messages.slice(before)
		const delivered = after.flatMap((m) =>
			m.type === 'operation-batch' ? (m.operations as Array<{ recordId: string }>) : [],
		)
		expect(delivered.map((op) => op.recordId)).not.toContain('n1')
		const error = after.find((m) => m.type === 'error')
		expect(error && 'code' in error ? error.code : null).toBe('ACCESS_RULES_CHANGED')
	})
})
