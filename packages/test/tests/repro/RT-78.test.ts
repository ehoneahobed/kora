/**
 * RT-78 repro (Phase 3 red team round 3, 2026-10-03): sealed-relation cascades (RT-74
 * fix) delete a child that was moved to another (live) parent.
 *
 * Under end-to-end encryption with the relation field sealed, the server cannot cascade.
 * The deleting device judges a late child at the wrong moment:
 *
 * 1. `cascadeLateChildOfOwnDelete` (kora/src/apply-pipeline.ts) runs after EACH applied
 *    remote write. When the deleting device learns of a child it did not know, it
 *    applies the child's ops one by one: right after the insert (still under the deleted
 *    parent) it authors a real cascade delete, before the next op of the same batch
 *    moves the child to another project. That delete is stamped now, so it beats the
 *    move on every replica: a child that every other device shows alive under a live
 *    project is deleted everywhere.
 *
 * 2. (Held up, by test: a receiver's durable provisional cascade does give way to a
 *    concurrent move by a peer that had not seen the delete. But once the deleting
 *    device returns, (1) deletes the moved child on every device anyway.)
 *
 * Without encryption the server's cascade-late correction looks at the child's folded
 * state, so the moved child survives (control test below).
 *
 * Asserts the CORRECT behaviour (fails at 97981a7): a child moved to a live project
 * survives, on every device.
 *
 * REDESIGN (Phase 3 round 4, 2026-10-03): the late-cascade authoring on the deleting
 * device is removed. A sealed foreign key on a cascade relation is refused at device
 * creation (SEALED_RELATION_FIELD); with the key in cleartextFields the server's
 * cascade-late correction judges the folded child, as without encryption. This repro now
 * asserts (1) the refusal and (2) the moved todo surviving with the cleartext key.
 */
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import type { SyncTransport } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { type TestDevice, type TransportPair, createTestNetwork } from '../../src/index'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: { fields: { title: t.string(), projectId: t.string().optional() } },
	},
	relations: {
		todoProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
	},
}) as unknown as SchemaDefinition

const encryption = {
	// The foreign key the server enforces travels in cleartext (a sealed one is refused).
	config: {
		enabled: true,
		key: 'correct horse battery staple',
		cleartextFields: { todos: ['projectId'] },
	},
	salt: new Uint8Array(16).fill(7),
	iterations: 1_000,
}

/** The first connection (device A) can be made deaf to operation batches. */
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

async function syncAll(devices: TestDevice[], passes = 3): Promise<void> {
	for (let pass = 0; pass < passes; pass++) for (const d of devices) await d.sync()
}

async function todoProject(device: TestDevice): Promise<string | null | 'gone'> {
	const rows = await device.getState('todos')
	const row = rows[0]
	return row ? (row.projectId as string | null) : 'gone'
}

describe('RT-78: sealed cascades and a child moved to a live project', () => {
	test('a sealed foreign key on the cascade relation is refused at device creation', async () => {
		await expect(
			createTestNetwork(schema, {
				devices: 1,
				encryption: { ...encryption, config: { enabled: true, key: 'k' } },
			}),
		).rejects.toMatchObject({ code: 'SEALED_RELATION_FIELD', relation: 'todoProject' })
	})

	test('encrypted, foreign key in cleartext: a child moved to a live project survives everywhere', async () => {
		const { control, wrap } = deafener()
		const network = await createTestNetwork(schema, { devices: 2, encryption, wrapTransport: wrap })
		try {
			const [a, b] = network.devices as [TestDevice, TestDevice]
			await syncAll([a, b], 1)
			const p = await a.collection('projects').insert({ name: 'p' })
			const q = await a.collection('projects').insert({ name: 'q' })
			await syncAll([a, b], 2)

			control.deaf = true
			// B adds a todo under P and moves it to Q; A never sees either before deleting P.
			const todo = await b.collection('todos').insert({ title: 'x', projectId: String(p.id) })
			await b.collection('todos').update(String(todo.id), { projectId: String(q.id) })
			await b.sync()
			await a.collection('projects').delete(String(p.id))
			await syncAll([a, b])
			// B: the delete of P does not touch a todo of Q.
			expect(await todoProject(b)).toBe(String(q.id))

			// A comes back and learns of the todo (insert under P, then the move).
			control.deaf = false
			await a.disconnect()
			await a.reconnect()
			await syncAll([a, b], 4)

			// Correct: the todo lives under Q everywhere (fails: A deleted it, everywhere).
			expect({ a: await todoProject(a), b: await todoProject(b) }).toEqual({
				a: String(q.id),
				b: String(q.id),
			})
		} finally {
			await network.close()
		}
	}, 120_000)

	test('control: without encryption the moved todo survives (server cascade-late)', async () => {
		const { control, wrap } = deafener()
		const network = await createTestNetwork(schema, { devices: 2, wrapTransport: wrap })
		try {
			const [a, b] = network.devices as [TestDevice, TestDevice]
			await syncAll([a, b], 1)
			const p = await a.collection('projects').insert({ name: 'p' })
			const q = await a.collection('projects').insert({ name: 'q' })
			await syncAll([a, b], 2)
			control.deaf = true
			const todo = await b.collection('todos').insert({ title: 'x', projectId: String(p.id) })
			await b.collection('todos').update(String(todo.id), { projectId: String(q.id) })
			await b.sync()
			await a.collection('projects').delete(String(p.id))
			await syncAll([a, b])
			control.deaf = false
			await a.disconnect()
			await a.reconnect()
			await syncAll([a, b], 4)
			expect(await todoProject(a)).toBe(String(q.id))
			expect(await todoProject(b)).toBe(String(q.id))
		} finally {
			await network.close()
		}
	}, 120_000)
})
