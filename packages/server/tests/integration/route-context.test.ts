import { type Operation, defineSchema, t } from '@korajs/core'
import { describe, expect, test, vi } from 'vitest'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				text: t.string(),
				userId: t.string(),
			},
		},
		tags: {
			fields: {
				name: t.string(),
			},
			constraints: [{ type: 'unique', fields: ['name'], onConflict: 'last-write-wins' }],
		},
	},
})

// A single dispatcher route that exposes the request.kora context over HTTP so
// the integration tests can drive apply/query/findById through the real server.
function dispatcherRoute() {
	return {
		path: '/api',
		async handle(request: {
			body?: unknown
			kora: import('../../src/server/route-context').ProductionHttpRouteContext
		}) {
			const body = (request.body ?? {}) as {
				action?: string
				mutation?: import('../../src/server/route-context').RouteMutation
				collection?: string
				id?: string
				options?: Record<string, unknown>
				scope?: Record<string, Record<string, unknown>>
			}
			const scopeOption = body.scope ? { scope: body.scope } : undefined

			if (body.action === 'apply' && body.mutation) {
				const result = await request.kora.apply(body.mutation, scopeOption)
				return { status: result.ok ? 200 : 400, body: result }
			}
			if (body.action === 'query' && body.collection) {
				const records = await request.kora.query(body.collection, {
					...(body.options ?? {}),
					...(scopeOption ?? {}),
				})
				return { status: 200, body: { records } }
			}
			if (body.action === 'findById' && body.collection && body.id) {
				const record = await request.kora.findById(body.collection, body.id, scopeOption)
				return { status: 200, body: { record } }
			}
			return { status: 400, body: { error: 'bad request' } }
		},
	}
}

async function startServer(port: number): Promise<{ stop: () => Promise<void>; base: string }> {
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	const server = createProductionServer({ store, port, httpRoutes: [dispatcherRoute()] })
	await server.start()
	return { stop: () => server.stop(), base: `http://localhost:${port}` }
}

async function post(base: string, payload: unknown): Promise<{ status: number; body: unknown }> {
	const res = await fetch(`${base}/api`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	})
	return { status: res.status, body: await res.json() }
}

describe('httpRoutes request.kora context', () => {
	test('apply insert is readable via findById and query', async () => {
		const { stop, base } = await startServer(39230)
		try {
			const inserted = await post(base, {
				action: 'apply',
				mutation: { collection: 'notes', type: 'insert', data: { text: 'hello', userId: 'u1' } },
			})
			expect(inserted.status).toBe(200)
			const applyBody = inserted.body as { ok: boolean; operation: Operation }
			expect(applyBody.ok).toBe(true)
			const id = applyBody.operation.recordId

			const found = await post(base, { action: 'findById', collection: 'notes', id })
			expect((found.body as { record: { text: string } | null }).record?.text).toBe('hello')

			const queried = await post(base, { action: 'query', collection: 'notes' })
			const records = (queried.body as { records: Array<{ id: string }> }).records
			expect(records.some((r) => r.id === id)).toBe(true)
		} finally {
			await stop()
		}
	})

	test('apply update changes materialized state, apply delete removes it', async () => {
		const { stop, base } = await startServer(39231)
		try {
			const inserted = await post(base, {
				action: 'apply',
				mutation: { collection: 'notes', type: 'insert', data: { text: 'v1', userId: 'u1' } },
			})
			const id = (inserted.body as { operation: Operation }).operation.recordId

			const updated = await post(base, {
				action: 'apply',
				mutation: { collection: 'notes', type: 'update', recordId: id, data: { text: 'v2' } },
			})
			expect((updated.body as { ok: boolean }).ok).toBe(true)

			const afterUpdate = await post(base, { action: 'findById', collection: 'notes', id })
			expect((afterUpdate.body as { record: { text: string } | null }).record?.text).toBe('v2')

			const deleted = await post(base, {
				action: 'apply',
				mutation: { collection: 'notes', type: 'delete', recordId: id },
			})
			expect((deleted.body as { ok: boolean }).ok).toBe(true)

			const afterDelete = await post(base, { action: 'findById', collection: 'notes', id })
			expect((afterDelete.body as { record: unknown }).record).toBeNull()
		} finally {
			await stop()
		}
	})

	test('apply runs through the validated pipeline: unique constraint rejects a duplicate', async () => {
		const { stop, base } = await startServer(39232)
		try {
			const first = await post(base, {
				action: 'apply',
				mutation: { collection: 'tags', type: 'insert', data: { name: 'kora' } },
			})
			expect((first.body as { ok: boolean }).ok).toBe(true)

			const second = await post(base, {
				action: 'apply',
				mutation: { collection: 'tags', type: 'insert', data: { name: 'kora' } },
			})
			expect(second.status).toBe(400)
			const body = second.body as { ok: boolean; code: string }
			expect(body.ok).toBe(false)
			expect(body.code).toBe('CONSTRAINT_VIOLATION')
		} finally {
			await stop()
		}
	})

	test('scope rejects an out-of-scope mutation and allows an in-scope one', async () => {
		const { stop, base } = await startServer(39233)
		try {
			const scope = { notes: { userId: 'u1' } }

			const outOfScope = await post(base, {
				action: 'apply',
				scope,
				mutation: { collection: 'notes', type: 'insert', data: { text: 'x', userId: 'u2' } },
			})
			expect(outOfScope.status).toBe(400)
			expect((outOfScope.body as { code: string }).code).toBe('SCOPE_VIOLATION')

			const inScope = await post(base, {
				action: 'apply',
				scope,
				mutation: { collection: 'notes', type: 'insert', data: { text: 'y', userId: 'u1' } },
			})
			expect((inScope.body as { ok: boolean }).ok).toBe(true)
		} finally {
			await stop()
		}
	})

	test('scope filters query results to the caller tenant', async () => {
		const { stop, base } = await startServer(39234)
		try {
			await post(base, {
				action: 'apply',
				mutation: { collection: 'notes', type: 'insert', data: { text: 'mine', userId: 'u1' } },
			})
			await post(base, {
				action: 'apply',
				mutation: { collection: 'notes', type: 'insert', data: { text: 'theirs', userId: 'u2' } },
			})

			const scoped = await post(base, {
				action: 'query',
				collection: 'notes',
				scope: { notes: { userId: 'u1' } },
			})
			const records = (scoped.body as { records: Array<{ userId: string }> }).records
			expect(records.length).toBe(1)
			expect(records.every((r) => r.userId === 'u1')).toBe(true)
		} finally {
			await stop()
		}
	})
})

describe('applyLocalOperation fan-out', () => {
	function collect(client: ReturnType<typeof createServerTransportPair>['client']) {
		const messages: import('@korajs/sync').SyncMessage[] = []
		client.onMessage((msg) => messages.push(msg))
		return messages
	}

	test('a server-originated operation is relayed to a connected client', async () => {
		const store = new MemoryServerStore('server-1')
		const server = new KoraSyncServer({ store })
		const pair = createServerTransportPair()
		const messages = collect(pair.client)
		server.handleConnection(pair.server)

		pair.client.send({
			type: 'handshake',
			messageId: 'hs-a',
			nodeId: 'client-a',
			versionVector: {},
			schemaVersion: 1,
		})

		await vi.waitFor(() => {
			expect(messages.find((m) => m.type === 'handshake-response')).toBeDefined()
		})
		await vi.waitFor(() => {
			expect(messages.filter((m) => m.type === 'operation-batch').length).toBeGreaterThanOrEqual(1)
		})

		const op: Operation = {
			id: 'op-server-originated',
			nodeId: 'server-1',
			type: 'insert',
			collection: 'todos',
			recordId: 'rec-server',
			data: { title: 'from REST' },
			previousData: null,
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'server-1' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		}

		const result = await server.applyLocalOperation(op)
		expect(result.result).toBe('applied')

		await vi.waitFor(() => {
			const relayed = messages.filter(
				(m) =>
					m.type === 'operation-batch' && m.operations.some((o) => o.id === 'op-server-originated'),
			)
			expect(relayed.length).toBeGreaterThanOrEqual(1)
		})

		await server.stop()
	})
})
