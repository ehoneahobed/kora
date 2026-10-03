/**
 * RT-74 acceptance: cascades under end-to-end encryption with the relation's field
 * sealed (the server cannot derive them).
 *
 * - Receivers apply a remote delete's cascades as DURABLE provisional effects: kept at
 *   catch-up and retired only by a real copy (the deleting device's).
 * - Receivers never author copies (no write amplification, RT-69).
 * - The deleting device authors the copies of the children it knew, and, when it
 *   later learns of a child it did not know, authors that cascade too (exactly once).
 * - Every device converges, the deleting device included.
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import type { SyncTransport } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { type TestDevice, type TransportPair, createTestNetwork } from '../src/index'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: { fields: { title: t.string(), projectId: t.string().optional() } },
		notes: { fields: { body: t.string(), projectId: t.string().optional() } },
	},
	relations: {
		todoProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
		noteProject: {
			from: 'notes',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'set-null',
		},
	},
}) as unknown as SchemaDefinition

const encryption = {
	config: { enabled: true, key: 'correct horse battery staple' },
	salt: new Uint8Array(16).fill(7),
	iterations: 1_000,
}

/** Device A (first connection) can be made deaf to operation batches. */
function deafener(): { control: { deaf: boolean }; wrap: (pair: TransportPair) => TransportPair } {
	const control = { deaf: false }
	let connections = 0
	const wrap = (pair: TransportPair): TransportPair => {
		const index = connections++
		const inner = pair.client
		const client: SyncTransport = {
			connect: (...args) => inner.connect(...args),
			disconnect: () => inner.disconnect(),
			send: (message) => inner.send(message),
			onMessage: (handler) =>
				inner.onMessage((message) => {
					if (index === 0 && control.deaf && message.type === 'operation-batch') return
					handler(message)
				}),
			onClose: (handler) => inner.onClose(handler),
			onError: (handler) => inner.onError(handler),
			isConnected: () => inner.isConnected(),
		}
		return { client, serverTransport: pair.serverTransport }
	}
	return { control, wrap }
}

async function provisionalCount(device: TestDevice): Promise<number> {
	const rows = await (
		device.store as unknown as {
			adapter: { query<T>(sql: string): Promise<T[]> }
		}
	).adapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM _kora_provisional_ops')
	return rows[0]?.n ?? 0
}

async function syncAll(devices: TestDevice[], passes = 3): Promise<void> {
	for (let pass = 0; pass < passes; pass++) for (const d of devices) await d.sync()
}

function childEffectsBy(ops: Operation[], collection: string, recordId: string): string[] {
	return ops
		.filter(
			(op) => op.collection === collection && op.recordId === recordId && op.type !== 'insert',
		)
		.map((op) => op.nodeId)
}

describe('RT-74: sealed relations, devices cascade', () => {
	test('a child the deleting device did not know: durable on receivers, cascaded by the deleter when it returns', async () => {
		const { control, wrap } = deafener()
		const network = await createTestNetwork(schema, {
			devices: 3,
			encryption,
			wrapTransport: wrap,
		})
		try {
			const [a, b, c] = network.devices as [TestDevice, TestDevice, TestDevice]
			await syncAll([a, b, c], 1)
			const project = await a.collection('projects').insert({ name: 'p' })
			await syncAll([a, b, c], 2)

			control.deaf = true
			await b.collection('todos').insert({ title: 'unknown', projectId: String(project.id) })
			await b.collection('notes').insert({ body: 'unknown', projectId: String(project.id) })
			await b.sync()
			await a.collection('projects').delete(String(project.id))
			await syncAll([a, b, c])

			// Receivers cascaded (durably) and authored nothing.
			for (const d of [b, c]) {
				expect(await d.getState('todos')).toHaveLength(0)
				expect((await d.getState('notes'))[0]?.projectId ?? null).toBeNull()
				expect(await provisionalCount(d)).toBe(2)
			}
			for (const d of [b, c]) {
				await d.disconnect()
				await d.reconnect()
			}
			await syncAll([b, c])
			for (const d of [b, c]) {
				expect(await d.getState('todos')).toHaveLength(0)
				expect((await d.getState('notes'))[0]?.projectId ?? null).toBeNull()
			}

			// A comes back, learns of the children, and authors their effects once.
			control.deaf = false
			await a.disconnect()
			await a.reconnect()
			await syncAll([a, b, c], 4)
			for (const d of [a, b, c]) {
				expect(await d.getState('projects')).toHaveLength(0)
				expect(await d.getState('todos')).toHaveLength(0)
				expect((await d.getState('notes'))[0]?.projectId ?? null).toBeNull()
			}
			// The real copies retired the receivers' provisional effects.
			expect(await provisionalCount(b)).toBe(0)
			expect(await provisionalCount(c)).toBe(0)
			const ops = await b.store.getAllOperations()
			const todo = ops.find((op) => op.collection === 'todos' && op.type === 'insert')
			const note = ops.find((op) => op.collection === 'notes' && op.type === 'insert')
			expect(childEffectsBy(ops, 'todos', String(todo?.recordId))).toEqual([a.getNodeId()])
			expect(childEffectsBy(ops, 'notes', String(note?.recordId))).toEqual([a.getNodeId()])

			// A further reconnect authors nothing more.
			await a.disconnect()
			await a.reconnect()
			await syncAll([a, b, c])
			const again = await b.store.getAllOperations()
			expect(childEffectsBy(again, 'todos', String(todo?.recordId))).toEqual([a.getNodeId()])
		} finally {
			await network.close()
		}
	}, 120_000)

	test("children the deleting device knew: its copies retire the receivers' durable effects", async () => {
		const network = await createTestNetwork(schema, { devices: 3, encryption })
		try {
			const [a, b, c] = network.devices as [TestDevice, TestDevice, TestDevice]
			const project = await a.collection('projects').insert({ name: 'p' })
			for (let i = 0; i < 3; i++) {
				await a.collection('todos').insert({ title: `t${i}`, projectId: String(project.id) })
			}
			await syncAll([a, b, c])
			await a.collection('projects').delete(String(project.id))
			await syncAll([a, b, c])
			for (const d of [a, b, c]) {
				expect(await d.getState('todos')).toHaveLength(0)
				expect(await provisionalCount(d)).toBe(0)
			}
			// One copy per child, the author's.
			const ops = await c.store.getAllOperations()
			const deletes = ops.filter((op) => op.collection === 'todos' && op.type === 'delete')
			expect(deletes).toHaveLength(3)
			expect(new Set(deletes.map((op) => op.nodeId))).toEqual(new Set([a.getNodeId()]))
		} finally {
			await network.close()
		}
	}, 120_000)
})
