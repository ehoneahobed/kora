/**
 * `onOperationsCommitted`: one call per committed batch, after the commit, for device
 * uploads (WebSocket and HTTP) and server-authored writes, never for refused, ignored or
 * duplicate operations, and a failing handler never affects the write.
 *
 * Runs on the memory and SQLite stores, and on Postgres when KORA_PG_TEST_URL is set.
 */
import type { KoraEvent, Operation, SchemaDefinition } from '@korajs/core'
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { HttpLongPollingTransport, JsonMessageSerializer, type SyncMessage } from '@korajs/sync'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import postgres from 'postgres'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { LogEntry } from '../../src/logging/structured-logger'
import type { KoraSyncServer } from '../../src/server/kora-sync-server'
import type { OperationsCommittedContext } from '../../src/server/operations-committed'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createPostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { SqliteServerStore } from '../../src/store/sqlite-server-store'
import type { KoraSyncServerConfig } from '../../src/types'
import { createHarness, makeOp, sendAndAwaitAck, tick } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		tasks: { fields: { projectId: t.string(), title: t.string() } },
	},
	relations: {
		taskProject: {
			from: 'tasks',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
	},
})

const accessSchema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group', 'manage') },
		},
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: {
				read: member('id'),
				create: owner('ownerId'),
				update: member('id', 'edit'),
				delete: member('id', 'manage'),
			},
		},
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) => (['ann', 'bob'].includes(token) ? { userId: token } : null),
})

interface CommittedCall {
	ids: string[]
	collections: string[]
	context: OperationsCommittedContext
}

function recorder(): {
	calls: CommittedCall[]
	handler: NonNullable<KoraSyncServerConfig['onOperationsCommitted']>
} {
	const calls: CommittedCall[] = []
	return {
		calls,
		handler: (operations, context) => {
			calls.push({
				ids: operations.map((op) => op.id),
				collections: operations.map((op) => op.collection),
				context,
			})
		},
	}
}

function rejectionFor(messages: SyncMessage[], operationId: string): string | null {
	for (const m of messages) {
		if (m.type === 'operation-rejected' && m.operationId === operationId) return m.code
	}
	return null
}

const LOGIN = { supportsScopeDisjunction: true, lastDeliverySequence: 0 } as Partial<SyncMessage>
const SILENT = { log: () => {} }

type StoreFactory = () => Promise<ServerStore>

function runCommittedHookTests(name: string, createStore: StoreFactory): void {
	describe(`onOperationsCommitted (${name})`, () => {
		async function setup(
			extra: Partial<KoraSyncServerConfig> = {},
			withSchema: SchemaDefinition = schema,
		) {
			const store = (await createStore()) as MemoryServerStore
			const { calls, handler } = recorder()
			const harness = await createHarness(
				withSchema,
				auth,
				{ onOperationsCommitted: handler, unscopedSharing: 'allow', logger: SILENT, ...extra },
				store,
			)
			return { harness, calls, store }
		}

		test('a device upload is one batch with the session auth, after the commit', async () => {
			const seen: Array<{ committed: boolean }> = []
			const { harness, calls, store } = await setup({
				onOperationsCommitted: async (operations, context) => {
					// The batch is committed when the handler runs: readable from the store.
					const first = operations[0] as Operation
					seen.push({
						committed: (await store.findRecord(first.collection, first.recordId)) !== null,
					})
					calls.push({
						ids: operations.map((op) => op.id),
						collections: operations.map((op) => op.collection),
						context,
					})
				},
			})
			const ann = await harness.login('ann', 'ann-node', LOGIN)
			const a = makeOp('ann-node', 1, {
				collection: 'projects',
				recordId: 'p1',
				data: { name: 'A' },
			})
			const b = makeOp('ann-node', 2, {
				collection: 'tasks',
				recordId: 't1',
				data: { projectId: 'p1', title: 'T' },
			})
			await sendAndAwaitAck(ann, [a, b])
			await vi.waitFor(() => expect(calls).toHaveLength(1))
			expect(calls[0]?.ids).toEqual([a.id, b.id])
			expect(calls[0]?.context.source).toBe('sync')
			expect(calls[0]?.context.auth?.userId).toBe('ann')
			expect(typeof calls[0]?.context.sessionId).toBe('string')
			expect(seen).toEqual([{ committed: true }])

			// The same batch again is all duplicates: no call.
			await sendAndAwaitAck(ann, [a, b])
			await tick(20)
			expect(calls).toHaveLength(1)
			await harness.server.stop()
		})

		test('refused and ignored operations are never reported', async () => {
			const { harness, calls } = await setup({
				validateOperation: (op) => {
					const title = (op.data as { title?: string } | null)?.title
					if (title === 'refuse') return { action: 'reject', code: 'NOPE', message: 'No.' }
					if (title === 'ignore') return { action: 'ignore' }
					return { action: 'accept' }
				},
			})
			const ann = await harness.login('ann', 'ann-node', LOGIN)
			const project = makeOp('ann-node', 1, {
				collection: 'projects',
				recordId: 'p1',
				data: { name: 'A' },
			})
			const refused = makeOp('ann-node', 2, {
				collection: 'tasks',
				recordId: 't1',
				data: { projectId: 'p1', title: 'refuse' },
			})
			const ignored = makeOp('ann-node', 3, {
				collection: 'tasks',
				recordId: 't2',
				data: { projectId: 'p1', title: 'ignore' },
			})
			const kept = makeOp('ann-node', 4, {
				collection: 'tasks',
				recordId: 't3',
				data: { projectId: 'p1', title: 'keep' },
			})
			await sendAndAwaitAck(ann, [project, refused, ignored, kept])
			expect(rejectionFor(ann.messages, refused.id)).toBe('NOPE')
			await vi.waitFor(() => expect(calls).toHaveLength(1))
			expect(calls[0]?.ids).toEqual([project.id, kept.id])

			// A batch where nothing commits: no call at all.
			const onlyRefused = makeOp('ann-node', 5, {
				collection: 'tasks',
				recordId: 't4',
				data: { projectId: 'p1', title: 'refuse' },
			})
			await sendAndAwaitAck(ann, [onlyRefused])
			await tick(20)
			expect(calls).toHaveLength(1)
			await harness.server.stop()
		})

		test('a delete and the cascade it causes are one batch', async () => {
			const { harness, calls } = await setup()
			const ann = await harness.login('ann', 'ann-node', LOGIN)
			const project = makeOp('ann-node', 1, {
				collection: 'projects',
				recordId: 'p1',
				data: { name: 'A' },
			})
			const task = makeOp('ann-node', 2, {
				collection: 'tasks',
				recordId: 't1',
				data: { projectId: 'p1', title: 'T' },
			})
			await sendAndAwaitAck(ann, [project, task])
			await vi.waitFor(() => expect(calls).toHaveLength(1))
			const remove = makeOp('ann-node', 3, {
				type: 'delete',
				collection: 'projects',
				recordId: 'p1',
				data: null,
			})
			await sendAndAwaitAck(ann, [remove])
			await vi.waitFor(() => expect(calls).toHaveLength(2))
			expect(calls[1]?.ids[0]).toBe(remove.id)
			expect(calls[1]?.collections).toEqual(['projects', 'tasks'])
			expect(calls[1]?.context.source).toBe('sync')
			await harness.server.stop()
		})

		test('server writes: kora.apply, kora.transaction (one batch with its cascade)', async () => {
			const { harness, calls } = await setup()
			const kora = harness.server.getKoraContext()
			const created = await kora.apply({
				collection: 'projects',
				type: 'insert',
				recordId: 'p1',
				data: { name: 'A' },
			})
			expect(created.ok).toBe(true)
			expect(calls).toHaveLength(1)
			expect(calls[0]?.context).toEqual({ source: 'server', auth: null, sessionId: null })

			const tx = await kora.transaction(async () => [
				{
					collection: 'tasks',
					type: 'insert',
					recordId: 't1',
					data: { projectId: 'p1', title: 'A' },
				},
				{
					collection: 'tasks',
					type: 'insert',
					recordId: 't2',
					data: { projectId: 'p1', title: 'B' },
				},
			])
			expect(tx.ok).toBe(true)
			expect(calls).toHaveLength(2)
			expect(calls[1]?.collections).toEqual(['tasks', 'tasks'])

			const removed = await kora.transaction(async () => [
				{ collection: 'projects', type: 'delete', recordId: 'p1' },
			])
			expect(removed.ok).toBe(true)
			expect(calls).toHaveLength(3)
			expect(calls[2]?.collections).toEqual(['projects', 'tasks', 'tasks'])

			// A refused transaction commits nothing and reports nothing.
			const refused = await kora.transaction(async (t) => t.reject('NO', 'No.'))
			expect(refused.ok).toBe(false)
			const conditional = await kora.applyConditional({
				collection: 'projects',
				id: 'missing',
				if: { name: { $eq: 'x' } },
				update: { name: 'y' },
			})
			expect(conditional.ok).toBe(false)
			expect(calls).toHaveLength(3)
			await harness.server.stop()
		})

		test('server.access.grant reports the membership write', async () => {
			const { harness, calls } = await setup({}, accessSchema)
			const ann = await harness.login('ann', 'ann-node', LOGIN)
			const doc = makeOp('ann-node', 1, {
				collection: 'documents',
				recordId: 'd1',
				data: { title: 'Plan', ownerId: 'ann' },
			})
			await sendAndAwaitAck(ann, [doc])
			await vi.waitFor(() => expect(calls).toHaveLength(1))
			await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'edit' })
			expect(calls).toHaveLength(2)
			expect(calls[1]?.collections).toEqual(['members'])
			expect(calls[1]?.context.source).toBe('server')
			await harness.server.stop()
		})

		test('a throwing or rejecting handler is reported and never affects the write', async () => {
			const logs: LogEntry[] = []
			const events: KoraEvent[] = []
			const emitter = new SimpleEventEmitter()
			emitter.on('server:commit-hook-failed', (event) => events.push(event))
			const later = recorder()
			const { harness, store } = await setup({
				logger: { log: (entry) => logs.push(entry) },
				emitter,
				onOperationsCommitted: () => {
					throw new Error('hook exploded')
				},
			})
			harness.server.onOperationsCommitted(async () => {
				throw new Error('async hook exploded')
			})
			harness.server.onOperationsCommitted(later.handler)
			const ann = await harness.login('ann', 'ann-node', LOGIN)
			const op = makeOp('ann-node', 1, {
				collection: 'projects',
				recordId: 'p1',
				data: { name: 'A' },
			})
			await sendAndAwaitAck(ann, [op])
			expect(await store.findRecord('projects', 'p1')).not.toBeNull()
			expect(rejectionFor(ann.messages, op.id)).toBeNull()
			// A handler registered after the failing ones still runs.
			await vi.waitFor(() => expect(later.calls).toHaveLength(1))
			await vi.waitFor(() => expect(events).toHaveLength(2))
			expect(events.map((e) => (e as { message: string }).message).sort()).toEqual([
				'async hook exploded',
				'hook exploded',
			])
			expect(events[0]).toMatchObject({ source: 'sync', operationIds: [op.id] })
			const failures = logs.filter((entry) => entry.event === 'operations.commit_hook_failed')
			expect(failures).toHaveLength(2)
			expect(failures[0]).toMatchObject({ level: 'error', count: 1 })
			expect((await harness.server.getStatus()).errorCount).toBeGreaterThanOrEqual(2)

			// A server write is not failed by the handler either.
			const applied = await harness.server
				.getKoraContext()
				.apply({ collection: 'projects', type: 'insert', recordId: 'p2', data: { name: 'B' } })
			expect(applied.ok).toBe(true)
			await harness.server.stop()
		})

		test('handlers get a copy: mutating it changes nothing that is relayed', async () => {
			const { harness } = await setup({
				onOperationsCommitted: (operations) => {
					const data = (operations[0] as Operation).data as Record<string, unknown>
					data.name = 'tampered'
				},
			})
			const ann = await harness.login('ann', 'ann-node', LOGIN)
			const bob = await harness.login('bob', 'bob-node', LOGIN)
			const op = makeOp('ann-node', 1, {
				collection: 'projects',
				recordId: 'p1',
				data: { name: 'A' },
			})
			await sendAndAwaitAck(ann, [op])
			await vi.waitFor(() => {
				const relayed = bob.messages.flatMap((m) =>
					m.type === 'operation-batch' ? (m.operations as Operation[]) : [],
				)
				expect(relayed.find((o) => o.id === op.id)?.data).toEqual({ name: 'A' })
			})
			expect((await harness.store.findRecord('projects', 'p1'))?.name).toBe('A')
			await harness.server.stop()
		})

		test('unsubscribing stops the calls', async () => {
			const { harness } = await setup({ onOperationsCommitted: undefined })
			const { calls, handler } = recorder()
			const off = harness.server.onOperationsCommitted(handler)
			const kora = harness.server.getKoraContext()
			await kora.apply({
				collection: 'projects',
				type: 'insert',
				recordId: 'p1',
				data: { name: 'A' },
			})
			off()
			await kora.apply({
				collection: 'projects',
				type: 'insert',
				recordId: 'p2',
				data: { name: 'B' },
			})
			expect(calls).toHaveLength(1)
			await harness.server.stop()
		})

		test('a batch that fails part way still reports what it committed', async () => {
			const { harness, calls, store } = await setup()
			const ann = await harness.login('ann', 'ann-node', LOGIN)
			const first = makeOp('ann-node', 1, {
				collection: 'projects',
				recordId: 'p1',
				data: { name: 'A' },
			})
			const second = makeOp('ann-node', 2, {
				collection: 'projects',
				recordId: 'p2',
				data: { name: 'B' },
			})
			const apply = store.applyRemoteOperation.bind(store)
			store.applyRemoteOperation = async (op, options) => {
				if (op.id === second.id) throw new Error('disk on fire')
				return apply(op, options)
			}
			ann.send({
				type: 'operation-batch',
				messageId: 'b-fail',
				operations: [first, second],
				isFinal: true,
				batchIndex: 0,
			})
			await vi.waitFor(() => expect(calls).toHaveLength(1))
			expect(calls[0]?.ids).toEqual([first.id])
			store.applyRemoteOperation = apply
			await harness.server.stop()
		})

		test('a delete whose cascade write fails is still reported and relayed', async () => {
			const { harness, calls, store } = await setup()
			const ann = await harness.login('ann', 'ann-node', LOGIN)
			const bob = await harness.login('bob', 'bob-node', LOGIN)
			const project = makeOp('ann-node', 1, {
				collection: 'projects',
				recordId: 'p1',
				data: { name: 'A' },
			})
			const task = makeOp('ann-node', 2, {
				collection: 'tasks',
				recordId: 't1',
				data: { projectId: 'p1', title: 'T' },
			})
			await sendAndAwaitAck(ann, [project, task])
			await vi.waitFor(() => expect(calls).toHaveLength(1))
			const apply = store.applyRemoteOperation.bind(store)
			let failed = false
			store.applyRemoteOperation = async (op, options) => {
				// The server's cascade copy of the task delete (not ann's own operation).
				if (op.collection === 'tasks' && op.nodeId !== 'ann-node' && !failed) {
					failed = true
					throw new Error('transient store error')
				}
				return apply(op, options)
			}
			const remove = makeOp('ann-node', 3, {
				type: 'delete',
				collection: 'projects',
				recordId: 'p1',
				data: null,
			})
			ann.send({
				type: 'operation-batch',
				messageId: 'b-cascade-fails',
				operations: [remove],
				isFinal: true,
				batchIndex: 0,
			})
			await vi.waitFor(() => expect(calls).toHaveLength(2))
			expect(failed).toBe(true)
			expect(calls[1]?.ids).toEqual([remove.id])
			expect(await store.findRecord('projects', 'p1')).toBeNull()
			// Another device receives the committed delete.
			await vi.waitFor(() =>
				expect(
					bob.messages.some(
						(m) =>
							m.type === 'operation-batch' &&
							(m.operations as Operation[]).some((o) => o.id === remove.id),
					),
				).toBe(true),
			)
			store.applyRemoteOperation = apply
			await harness.server.stop()
		})

		test('kora.apply: a delete whose cascade fails rejects, but is reported', async () => {
			const { harness, calls, store } = await setup()
			const kora = harness.server.getKoraContext()
			await kora.apply({
				collection: 'projects',
				type: 'insert',
				recordId: 'p1',
				data: { name: 'A' },
			})
			await kora.apply({
				collection: 'tasks',
				type: 'insert',
				recordId: 't1',
				data: { projectId: 'p1', title: 'T' },
			})
			const apply = store.applyRemoteOperation.bind(store)
			let failed = false
			store.applyRemoteOperation = async (op, options) => {
				if (op.collection === 'tasks' && op.type === 'delete' && !failed) {
					failed = true
					throw new Error('transient store error')
				}
				return apply(op, options)
			}
			await expect(
				kora.apply({ collection: 'projects', type: 'delete', recordId: 'p1' }),
			).rejects.toThrow('transient store error')
			store.applyRemoteOperation = apply
			expect(await store.findRecord('projects', 'p1')).toBeNull()
			expect(calls.map((call) => call.collections)).toEqual([['projects'], ['tasks'], ['projects']])
			await harness.server.stop()
		})

		test('a hostile thenable from a handler never fails the write', async () => {
			const logs: LogEntry[] = []
			const { harness, store } = await setup({
				logger: { log: (entry) => logs.push(entry) },
				onOperationsCommitted: () =>
					({
						// biome-ignore lint/suspicious/noThenProperty: a hostile thenable is what this test sends
						then() {
							throw new Error('bad thenable')
						},
					}) as unknown as Promise<void>,
			})
			harness.server.onOperationsCommitted(
				() =>
					Object.defineProperty({}, 'then', {
						get() {
							throw new Error('bad getter')
						},
					}) as Promise<void>,
			)
			const applied = await harness.server
				.getKoraContext()
				.apply({ collection: 'projects', type: 'insert', recordId: 'p1', data: { name: 'A' } })
			expect(applied.ok).toBe(true)
			expect(await store.findRecord('projects', 'p1')).not.toBeNull()
			await vi.waitFor(() =>
				expect(
					logs
						.filter((entry) => entry.event === 'operations.commit_hook_failed')
						.map((e) => e.error),
				).toEqual(expect.arrayContaining(['bad thenable', 'bad getter'])),
			)
			await harness.server.stop()
		})

		test('each handler gets its own copy', async () => {
			const seen: unknown[] = []
			const { harness } = await setup({
				onOperationsCommitted: (operations) => {
					;((operations[0] as Operation).data as Record<string, unknown>).name = 'tampered'
				},
			})
			harness.server.onOperationsCommitted((operations) => {
				seen.push((operations[0] as Operation).data)
			})
			await harness.server
				.getKoraContext()
				.apply({ collection: 'projects', type: 'insert', recordId: 'p1', data: { name: 'A' } })
			expect(seen).toEqual([{ name: 'A' }])
			await harness.server.stop()
		})

		test('HTTP long-polling uploads are reported like WebSocket ones', async () => {
			const store = (await createStore()) as MemoryServerStore
			await store.setSchema(schema)
			const { calls, handler } = recorder()
			const { KoraSyncServer } = await import('../../src/server/kora-sync-server')
			const server: KoraSyncServer = new KoraSyncServer({
				store,
				auth,
				unscopedSharing: 'allow',
				logger: SILENT,
				relayRetransmitIntervalMs: 0,
				deliveryPollIntervalMs: 0,
				onOperationsCommitted: handler,
			})
			const transport = new HttpLongPollingTransport({
				fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
					const headers = new Headers(init?.headers)
					const response = await server.handleHttpRequest({
						method: (init?.method ?? 'GET') as 'GET' | 'POST',
						...(headers.get('authorization')
							? { authorization: headers.get('authorization') as string }
							: {}),
						...(headers.get('x-kora-session')
							? { sessionId: headers.get('x-kora-session') as string }
							: {}),
						...(headers.get('content-type')
							? { contentType: headers.get('content-type') as string }
							: {}),
						...(typeof init?.body === 'string' ? { body: init.body } : {}),
					})
					return new Response(
						response.status === 204 || response.status === 304
							? null
							: ((response.body as string) ?? null),
						{ status: response.status, headers: response.headers },
					)
				}) as typeof fetch,
				retryDelayMs: 5,
				preferWebSocket: false,
				serializer: new JsonMessageSerializer(),
			})
			const received: SyncMessage[] = []
			transport.onMessage((m) => received.push(m))
			await transport.connect('http://localhost/kora-sync', { authToken: 'bob' })
			transport.send({
				type: 'handshake',
				messageId: 'hs',
				nodeId: 'bob-node',
				versionVector: {},
				schemaVersion: 1,
				authToken: 'bob',
			})
			await vi.waitFor(() =>
				expect(received.some((m) => m.type === 'handshake-response' && m.accepted)).toBe(true),
			)
			const op = makeOp('bob-node', 1, {
				collection: 'projects',
				recordId: 'p1',
				data: { name: 'H' },
			})
			transport.send({
				type: 'operation-batch',
				messageId: 'http-batch',
				operations: [op],
				isFinal: true,
				batchIndex: 0,
			})
			await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5_000 })
			expect(calls[0]?.ids).toEqual([op.id])
			expect(calls[0]?.context.source).toBe('sync')
			expect(calls[0]?.context.auth?.userId).toBe('bob')
			await transport.disconnect()
			await server.stop()
		})
	})
}

runCommittedHookTests('memory', async () => new MemoryServerStore('server-1'))
runCommittedHookTests(
	'sqlite',
	async () => new SqliteServerStore(drizzle(new Database(':memory:')), 'server-1'),
)

const postgresUrl = process.env.KORA_PG_TEST_URL
describe.skipIf(!postgresUrl)('postgres (live)', () => {
	const url = postgresUrl as string
	const schemas: string[] = []
	afterAll(async () => {
		const admin = postgres(url, { max: 1, onnotice: () => {} })
		for (const name of schemas) await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
		await admin.end()
	})
	runCommittedHookTests('postgres', async () => {
		const name = `kora_commit_hook_${process.pid}_${schemas.length + 1}`
		schemas.push(name)
		const admin = postgres(url, { max: 1, onnotice: () => {} })
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		await admin.end()
		const scoped = new URL(url)
		scoped.searchParams.set('search_path', name)
		return createPostgresServerStore({ connectionString: scoped.toString(), nodeId: 'server-1' })
	})
})

describe('onOperationsCommitted over a real WebSocket (production server)', () => {
	test('an upload through createProductionServer is reported with its session auth', async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		const { calls, handler } = recorder()
		const server = createProductionServer({
			store,
			port: 0,
			staticDir: '/nonexistent',
			syncOptions: { auth, unscopedSharing: 'allow', logger: SILENT },
		})
		const off = server.onOperationsCommitted(handler)
		const base = await server.start()
		const ws = new WebSocket(`${base.replace('http', 'ws')}/kora-sync`)
		const messages: SyncMessage[] = []
		ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as SyncMessage))
		try {
			await new Promise<void>((resolve, reject) => {
				ws.once('open', () => resolve())
				ws.once('error', reject)
			})
			ws.send(
				JSON.stringify({
					type: 'handshake',
					messageId: 'hs',
					nodeId: 'ann-node',
					versionVector: {},
					schemaVersion: 1,
					authToken: 'ann',
				}),
			)
			await vi.waitFor(() =>
				expect(messages.some((m) => m.type === 'handshake-response')).toBe(true),
			)
			const op = makeOp('ann-node', 1, {
				collection: 'projects',
				recordId: 'p1',
				data: { name: 'W' },
			})
			ws.send(
				JSON.stringify({
					type: 'operation-batch',
					messageId: 'ws-batch',
					operations: [op],
					isFinal: true,
					batchIndex: 0,
				}),
			)
			await vi.waitFor(() => expect(calls).toHaveLength(1))
			expect(calls[0]?.ids).toEqual([op.id])
			expect(calls[0]?.context.auth?.userId).toBe('ann')

			// Server writes through the production handle are reported too.
			await server.kora.apply({
				collection: 'projects',
				type: 'insert',
				recordId: 'p2',
				data: { name: 'S' },
			})
			expect(calls).toHaveLength(2)
			expect(calls[1]?.context.source).toBe('server')
			off()
		} finally {
			ws.close()
			await server.stop()
		}
	})
})
