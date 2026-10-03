/**
 * RT-74 repro (Phase 3 red team round 2, 2026-10-03): under end-to-end encryption, a
 * cascade the server cannot derive is undone on the receiving device.
 *
 * With encryption, the server runs cascades only when the relation's field is listed
 * in `cleartextFields`; otherwise, per the guide, "each device cascades for itself".
 * Since the RT-69 fix a device applies the cascades of a REMOTE delete only as
 * provisional effects, and `settleAfterCatchUp` retires every provisional effect still
 * pending when a delivery stream catches up ("an effect the server did not derive
 * does not stay applied locally"). When the author of the delete never saw the child
 * (here: it goes away right after uploading the delete), nobody makes the cascade
 * durable: device B shows the child deleted until its next catch-up, then shows it
 * again, an orphan of a deleted parent on B and on the server. Before the RT-69 fix B
 * authored a durable copy.
 *
 * Asserts the CORRECT behaviour (fails at 4d6c8a7): the child stays deleted on B
 * across a reconnect.
 *
 * REDESIGN (Phase 3 round 4, 2026-10-03): devices no longer cascade sealed relations.
 * Encryption may not seal the foreign key of a cascade / set-null / restrict relation:
 * createApp (and TestDevice) refuse it with SEALED_RELATION_FIELD, and with the key in
 * cleartextFields the server cascades exactly as without encryption. This repro now
 * asserts (1) the refusal and (2) the original scenario converging with the cleartext key.
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
	// projectId is sealed: the server cannot cascade, devices must.
	// The foreign key the server enforces travels in cleartext (a sealed one is refused).
	config: {
		enabled: true,
		key: 'correct horse battery staple',
		cleartextFields: { todos: ['projectId'] },
	},
	salt: new Uint8Array(16).fill(7),
	iterations: 1_000,
}

/** The first connection's client stops receiving operation batches once `deaf` is set. */
const control = { deaf: false, connections: 0 }
function wrap(pair: TransportPair): TransportPair {
	const index = control.connections++
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

describe('RT-74: encrypted cascades are retired at catch-up', () => {
	test('a sealed foreign key on the cascade relation is refused at device creation', async () => {
		await expect(
			createTestNetwork(schema, {
				devices: 1,
				encryption: { ...encryption, config: { enabled: true, key: 'k' } },
			}),
		).rejects.toMatchObject({ code: 'SEALED_RELATION_FIELD', relation: 'todoProject' })
	})

	test('encrypted, foreign key in cleartext: the cascade of a child the deleter never saw stays applied', async () => {
		const network = await createTestNetwork(schema, {
			devices: 2,
			encryption,
			wrapTransport: wrap,
		})
		try {
			const [a, b] = network.devices as [TestDevice, TestDevice]
			await a.sync() // connection 0: A
			await b.sync()
			const project = await a.collection('projects').insert({ name: 'p' })
			await a.sync()
			await b.sync()
			expect(await b.getState('projects')).toHaveLength(1)

			// A stops receiving (it is about to go away); B adds a child A never sees, and
			// A deletes the project without knowing it.
			control.deaf = true
			await b.collection('todos').insert({ title: 'child', projectId: String(project.id) })
			await b.sync()
			await a.collection('projects').delete(String(project.id))
			await a.sync()
			await b.sync()
			expect(await b.getState('todos')).toHaveLength(0)

			await b.disconnect()
			await b.reconnect()
			await b.sync()
			await b.sync()
			// Correct: the cascade B applied stays applied.
			expect(await b.getState('projects')).toHaveLength(0)
			expect(await b.getState('todos')).toHaveLength(0)
		} finally {
			await network.close()
		}
	}, 60_000)
})
