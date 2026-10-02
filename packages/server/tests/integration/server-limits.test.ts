import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import {
	DEFAULT_MAX_CONNECTIONS,
	KoraSyncServer,
	resolvePerMessageDeflate,
} from '../../src/server/kora-sync-server'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { buildServerBackup } from '../../src/store/server-backup'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'

/**
 * Server resource limits (SRV-6, LMS #11, LMS #12): connection ceiling, per-node rate
 * limit across reconnects, request body caps, backup validation, compression.
 */

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

let seq = 0
function op(nodeId: string, overrides: Partial<Operation> = {}): Operation {
	seq += 1
	return {
		id: `limits-${seq}`,
		nodeId,
		type: 'insert',
		collection: 'todos',
		recordId: `r-${seq}`,
		data: { title: 'x' },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: 0, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('KoraSyncServer limits', () => {
	test('a connection ceiling applies by default', () => {
		expect(DEFAULT_MAX_CONNECTIONS).toBeGreaterThan(0)
		const server = new KoraSyncServer({ store: new MemoryServerStore('s'), maxConnections: 1 })
		server.handleConnection(createServerTransportPair().server)
		const refused = createServerTransportPair()
		const messages: SyncMessage[] = []
		refused.client.onMessage((m) => messages.push(m))
		expect(() => server.handleConnection(refused.server)).toThrow()
		expect(messages.some((m) => m.type === 'error' && m.code === 'MAX_CONNECTIONS')).toBe(true)
		void server.stop()
	})

	test('the per-node rate limit survives a reconnect', async () => {
		const store = new MemoryServerStore('s')
		await store.setSchema(schema)
		const server = new KoraSyncServer({ store, maxOpsPerMinute: 3 })
		let limited = false
		for (let round = 0; round < 3 && !limited; round++) {
			const { client, server: transport } = createServerTransportPair()
			const messages: SyncMessage[] = []
			client.onMessage((m) => messages.push(m))
			server.handleConnection(transport)
			client.send({
				type: 'handshake',
				messageId: `hs-${round}`,
				nodeId: 'phone',
				versionVector: {},
				schemaVersion: 1,
			})
			await vi.waitFor(() =>
				expect(messages.some((m) => m.type === 'handshake-response')).toBe(true),
			)
			client.send({
				type: 'operation-batch',
				messageId: `b-${round}`,
				operations: [op('phone'), op('phone')],
				isFinal: true,
				batchIndex: 0,
			})
			await vi.waitFor(() => expect(messages.some((m) => m.type === 'acknowledgment')).toBe(true))
			limited = messages.some((m) => m.type === 'error' && m.code === 'RATE_LIMIT')
			await client.disconnect()
		}
		await server.stop()
		expect(limited).toBe(true)
	})

	test('permessage-deflate is on by default with bounded memory, and configurable', () => {
		expect(resolvePerMessageDeflate(undefined)).toEqual(
			expect.objectContaining({ threshold: 1024, serverNoContextTakeover: true }),
		)
		expect(resolvePerMessageDeflate(false)).toBe(false)
		expect(resolvePerMessageDeflate({ threshold: 10 })).toEqual({ threshold: 10 })
	})
})

describe('createProductionServer limits', () => {
	test('route bodies over the cap get 413 and never reach the handler', async () => {
		let called = false
		const server = createProductionServer({
			store: new MemoryServerStore('s'),
			port: 0,
			staticDir: '/nonexistent',
			maxRequestBodyBytes: 1_000,
			httpRoutes: [
				{
					path: '/api',
					async handle(request) {
						called = true
						return { status: 200, body: request.body ?? null }
					},
				},
			],
		})
		const base = await server.start()
		try {
			const small = await fetch(`${base}/api/x`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ a: 1 }),
			})
			expect(small.status).toBe(200)
			called = false
			const big = await fetch(`${base}/api/x`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ pad: 'x'.repeat(5_000) }),
			})
			expect(big.status).toBe(413)
			expect(called).toBe(false)
		} finally {
			await server.stop()
		}
	})

	test('a backup with a far-future operation is refused with 400', async () => {
		const store = new MemoryServerStore('s')
		await store.setSchema(schema)
		const server = createProductionServer({ store, port: 0, staticDir: '/nonexistent' })
		const base = await server.start()
		try {
			const future = op('n', {
				timestamp: { wallTime: Date.now() + 86_400_000, logical: 0, nodeId: 'n' },
			})
			const backup = await buildServerBackup(
				'other',
				[future],
				new Map([['n', future.sequenceNumber]]),
			)
			const res = await fetch(`${base}/__kora/backup/import`, {
				method: 'POST',
				body: Buffer.from(backup),
			})
			expect(res.status).toBe(400)
			expect((await res.json()).code).toBe('BACKUP_INVALID_OPERATION')
			expect(await store.getOperationCount()).toBe(0)
		} finally {
			await server.stop()
		}
	})

	test('a connection that never handshakes is closed by the deadline', async () => {
		const server = createProductionServer({
			store: new MemoryServerStore('s'),
			port: 0,
			staticDir: '/nonexistent',
			syncOptions: { handshakeTimeoutMs: 100 },
		})
		const base = await server.start()
		try {
			const ws = new WebSocket(`${base.replace('http', 'ws')}/kora-sync`)
			const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
			await closed
			const health = await (await fetch(`${base}/health`)).json()
			expect(health.connectedClients).toBe(0)
		} finally {
			await server.stop()
		}
	})
})
