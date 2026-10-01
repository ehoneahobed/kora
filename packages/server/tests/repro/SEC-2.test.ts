/**
 * SEC-2 repro: upload scope check trusts client-supplied previousData / data instead
 * of the stored row, so an authenticated tenant can edit, delete, or take over
 * another tenant's record. Asserts the CORRECT behavior (fails today).
 */
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), userId: t.string() } } },
})

function op(overrides: Partial<Operation>): Operation {
	return {
		id: `op-${Math.random().toString(36).slice(2)}`,
		nodeId: 'alice-node',
		type: 'update',
		collection: 'todos',
		recordId: 'bob-rec',
		data: {},
		previousData: null,
		timestamp: { wallTime: Date.now() + 1000, logical: 0, nodeId: 'alice-node' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

async function setup() {
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	// Bob's record already exists on the server.
	await store.applyRemoteOperation({
		id: 'bob-insert',
		nodeId: 'bob-node',
		type: 'insert',
		collection: 'todos',
		recordId: 'bob-rec',
		data: { title: 'bob secret', userId: 'bob' },
		previousData: null,
		timestamp: { wallTime: Date.now() - 10_000, logical: 0, nodeId: 'bob-node' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	})
	const auth = new TokenAuthProvider({
		validate: async (token) =>
			token === 'alice-token' ? { userId: 'alice', scopes: { todos: { userId: 'alice' } } } : null,
	})
	const server = new KoraSyncServer({ store, auth })
	const { client, server: transport } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	server.handleConnection(transport)
	client.send({
		type: 'handshake',
		messageId: 'hs',
		nodeId: 'alice-node',
		versionVector: {},
		schemaVersion: 1,
		authToken: 'alice-token',
	})
	await vi.waitFor(() =>
		expect(messages.some((m) => m.type === 'handshake-response')).toBe(true),
	)
	async function upload(o: Operation): Promise<void> {
		client.send({
			type: 'operation-batch',
			messageId: `b-${o.id}`,
			operations: [o],
			isFinal: true,
			batchIndex: 0,
		})
		await vi.waitFor(() =>
			expect(
				messages.some(
					(m) =>
						(m.type === 'acknowledgment' && m.acknowledgedMessageId === `b-${o.id}`) ||
						(m.type === 'operation-rejected' && m.operationId === o.id),
				),
			).toBe(true),
		)
	}
	async function bobRow(): Promise<Record<string, unknown> | undefined> {
		const rows = await store.queryCollection('todos', {
			where: { id: 'bob-rec' },
			includeDeleted: true,
			limit: 1,
		})
		return rows[0]
	}
	return { store, messages, upload, bobRow }
}

describe('SEC-2: upload scope trusts client previousData / data', () => {
	test('forged previousData must not let alice edit bob\'s record', async () => {
		const { messages, upload, bobRow } = await setup()
		const o = op({ data: { title: 'hacked' }, previousData: { userId: 'alice' } })
		await upload(o)
		expect.soft(messages.some((m) => m.type === 'operation-rejected' && m.operationId === o.id)).toBe(true)
		expect((await bobRow())?.title).toBe('bob secret')
	})

	test('forged previousData must not let alice delete bob\'s record', async () => {
		const { store, upload } = await setup()
		await upload(op({ type: 'delete', data: null, previousData: { userId: 'alice' } }))
		// Non-deleted query: bob's record must still be live.
		const live = await store.queryCollection('todos', { where: { id: 'bob-rec' } })
		expect(live).toHaveLength(1)
	})

	test('data:{userId:alice} must not let alice take ownership of bob\'s record', async () => {
		const { upload, bobRow } = await setup()
		await upload(op({ data: { userId: 'alice' } }))
		expect((await bobRow())?.userId).toBe('bob')
	})

	test('insert reusing bob\'s recordId with userId:alice must not overwrite bob\'s record', async () => {
		const { upload, bobRow } = await setup()
		await upload(op({ type: 'insert', data: { title: 'mine now', userId: 'alice' } }))
		const row = await bobRow()
		expect.soft(row?.userId).toBe('bob')
		expect(row?.title).toBe('bob secret')
	})
})
