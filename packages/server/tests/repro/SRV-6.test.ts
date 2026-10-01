/**
 * SRV-6 repro: server resource limits. Asserts CORRECT behavior (fails today):
 *  - the per-node ingest rate limit survives a reconnect,
 *  - scope-rejected operations count toward the rate limit,
 *  - idle HTTP long-poll sessions expire,
 *  - custom-route request bodies are size-capped (413).
 */
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), userId: t.string() } } },
})

let seq = 0
function mkOp(nodeId: string, userId: string): Operation {
	seq += 1
	return {
		id: `srv6-${seq}-${Math.random().toString(36).slice(2)}`,
		nodeId,
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${seq}`,
		data: { title: 'x', userId },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: seq, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

async function connect(server: KoraSyncServer, nodeId: string, token?: string) {
	const { client, server: transport } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	server.handleConnection(transport)
	client.send({
		type: 'handshake',
		messageId: `hs-${nodeId}-${Math.random()}`,
		nodeId,
		versionVector: {},
		schemaVersion: 1,
		...(token ? { authToken: token } : {}),
	} as SyncMessage)
	await vi.waitFor(() => expect(messages.some((m) => m.type === 'handshake-response')).toBe(true))
	async function upload(ops: Operation[]): Promise<void> {
		const id = `b-${Math.random()}`
		const before = messages.length
		client.send({
			type: 'operation-batch',
			messageId: id,
			operations: ops,
			isFinal: true,
			batchIndex: 0,
		} as SyncMessage)
		await vi.waitFor(() => expect(messages.length).toBeGreaterThan(before))
		await new Promise((r) => setTimeout(r, 20))
	}
	return { client, messages, upload, close: () => client.disconnect?.() }
}

const rateLimited = (ms: SyncMessage[]) =>
	ms.some((m) => m.type === 'error' && m.code === 'RATE_LIMIT')

describe('SRV-6 server resource limits', () => {
	test('control: 6 ops in one session hit a 5/min limit', async () => {
		const store = new MemoryServerStore('s0')
		await store.setSchema(schema)
		const server = new KoraSyncServer({ store, maxOpsPerMinute: 5 })
		const c = await connect(server, 'node-c')
		await c.upload(Array.from({ length: 6 }, () => mkOp('node-c', 'u')))
		await server.stop()
		expect(rateLimited(c.messages)).toBe(true)
	})

	afterEach(() => vi.useRealTimers())

	test('rate limit is not reset by reconnecting', async () => {
		const store = new MemoryServerStore('s')
		await store.setSchema(schema)
		const server = new KoraSyncServer({ store, maxOpsPerMinute: 5 })
		let limited = false
		for (let round = 0; round < 4 && !limited; round++) {
			const c = await connect(server, 'node-r')
			await c.upload([mkOp('node-r', 'u'), mkOp('node-r', 'u'), mkOp('node-r', 'u')])
			limited = rateLimited(c.messages)
			await c.close()
			await new Promise((r) => setTimeout(r, 10))
		}
		await server.stop()
		// 12 ops from one node within a minute against a 5/min limit must be throttled.
		expect(limited).toBe(true)
	})

	test('scope-rejected operations count toward the rate limit', async () => {
		const store = new MemoryServerStore('s2')
		await store.setSchema(schema)
		const server = new KoraSyncServer({
			store,
			maxOpsPerMinute: 5,
			auth: {
				authenticate: async () => ({ userId: 'alice', scopes: { todos: { userId: 'alice' } } }),
			},
		})
		const c = await connect(server, 'node-s', 'tok')
		const ops = Array.from({ length: 50 }, () => mkOp('node-s', 'bob'))
		await c.upload(ops)
		const rejections = c.messages.filter((m) => m.type === 'operation-rejected').length
		await server.stop()
		console.log(
			`SRV-6 scope-rejected processed=${rejections}/50 rateLimited=${rateLimited(c.messages)}`,
		)
		expect(rejections).toBeLessThanOrEqual(5)
	})

	test('idle HTTP long-poll sessions expire', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'Date'] })
		const store = new MemoryServerStore('s3')
		await store.setSchema(schema)
		const server = new KoraSyncServer({ store })
		for (let i = 0; i < 100; i++) {
			await server.handleHttpRequest({ method: 'GET', clientId: `client-${i}` })
		}
		expect(server.getConnectionCount()).toBe(100)
		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
		const remaining = server.getConnectionCount()
		vi.useRealTimers()
		await server.stop()
		expect(remaining).toBe(0)
	})

	test('custom route request bodies are size-capped', async () => {
		const port = 39561
		let receivedBytes = 0
		const server = createProductionServer({
			store: new MemoryServerStore('s4'),
			port,
			httpRoutes: [
				{
					path: '/auth',
					async handle(request) {
						receivedBytes = JSON.stringify(request.body ?? null).length
						return { status: 200, body: { ok: true } }
					},
				},
			],
		})
		await server.start()
		try {
			const big = JSON.stringify({ email: 'a@b.c', pad: 'x'.repeat(20 * 1024 * 1024) })
			const res = await fetch(`http://localhost:${port}/auth/signin`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: big,
			})
			console.log(
				`SRV-6 20MiB unauthenticated body -> status ${res.status}, handler saw ${receivedBytes} bytes`,
			)
			expect(res.status).toBe(413)
		} finally {
			await server.stop()
		}
	}, 30000)
})
