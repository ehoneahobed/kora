/**
 * RT-82 repro (Phase 3 red team round 3, 2026-10-03): under end-to-end encryption with
 * a sealed relation, a refused cascade copy leaves the receivers' durable provisional
 * effect in place for good.
 *
 * Since the RT-74 fix a receiving device's cascade of a sealed relation is a DURABLE
 * provisional effect: kept at catch-up, retired only by the deleting device's real
 * copy. When the server refuses that copy (the deleting user has no write grant on
 * another user's child, or a validator refuses it), the copy is never relayed. The
 * deleting device excludes its refused copy from its fold (W7), so the child is alive
 * there and on the server; every receiver keeps it deleted, with nothing that ever
 * retires the effect. Without encryption the server derives its own cascade (and the
 * cascade-late correction), so all replicas agree.
 *
 * Asserts the CORRECT behaviour (fails at 97981a7): the deleting device and the receiver
 * agree on the child.
 */
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { type TestDevice, createTestNetwork } from '../../src/index'

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
	config: { enabled: true, key: 'correct horse battery staple' },
	salt: new Uint8Array(16).fill(7),
	iterations: 1_000,
}

async function syncAll(devices: TestDevice[], passes = 3): Promise<void> {
	for (let pass = 0; pass < passes; pass++) for (const d of devices) await d.sync()
}

describe('RT-82: a refused sealed cascade copy never retires the receivers effect', () => {
	test("the deleting device and a receiver agree when the deleter's copy is refused", async () => {
		// App policy: a todo may be deleted only by the device (user) that created it.
		const creators = new Map<string, string>()
		const network = await createTestNetwork(schema, {
			devices: 2,
			encryption,
			validateOperation: (op) => {
				if (op.collection !== 'todos') return { action: 'accept' }
				if (op.type === 'insert') {
					creators.set(op.recordId, op.nodeId)
					return { action: 'accept' }
				}
				if (op.type === 'delete' && creators.get(op.recordId) !== op.nodeId) {
					return { action: 'reject', code: 'NOT_OWNER', message: 'only the creator deletes a todo' }
				}
				return { action: 'accept' }
			},
		})
		try {
			const [a, b] = network.devices as [TestDevice, TestDevice]
			const project = await a.collection('projects').insert({ name: 'shared' })
			await syncAll([a, b], 2)
			await b.collection('todos').insert({ title: "b's todo", projectId: String(project.id) })
			await syncAll([a, b], 2)
			expect(await a.getState('todos')).toHaveLength(1)

			await a.collection('projects').delete(String(project.id))
			await syncAll([a, b], 3)
			await a.disconnect()
			await a.reconnect()
			await b.disconnect()
			await b.reconnect()
			await syncAll([a, b], 3)

			// The server refused A's cascade copy (the validator saw it); A excludes it from
			// its fold. Correct: one answer (fails: A shows the todo, B keeps it deleted for
			// good, nothing ever retires B's durable provisional effect).
			const count = async (d: TestDevice) => (await d.getState('todos')).length
			expect(await count(a)).toBe(await count(b))
		} finally {
			await network.close()
		}
	}, 120_000)
})
