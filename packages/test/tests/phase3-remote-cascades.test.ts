/**
 * RT-69 acceptance: a device applying a REMOTE cascading delete never authors or
 * uploads its own copies of the cascades. Four devices and a late joiner: the server
 * stores the author's cascade (a LOCAL delete's effects are authored and uploaded)
 * and the server's own derived copy, and nothing from any receiving device. Every
 * device, the late joiner included, converges with no child left and no provisional
 * effect pending.
 */
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncTransport } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TestDevice, createTestNetwork } from '../src/index'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		tasks: { fields: { title: t.string(), projectId: t.string() } },
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
}) as unknown as SchemaDefinition

function pair(): { client: SyncTransport; serverTransport: ServerTransport } {
	const created = createServerTransportPair()
	return { client: created.client as unknown as SyncTransport, serverTransport: created.server }
}

describe('RT-69: cascades of a remote delete stay local', () => {
	test('4 devices + a late joiner: one cascade per child from the author and one from the server, none from receivers', async () => {
		const network = await createTestNetwork(schema, { devices: 4 })
		let late: TestDevice | null = null
		try {
			const devices = network.devices as TestDevice[]
			const [author] = devices as [TestDevice]
			const project = await author.collection('projects').insert({ name: 'p' })
			const children = 12
			for (let i = 0; i < children; i++) {
				await author.collection('tasks').insert({ title: `t${i}`, projectId: String(project.id) })
			}
			for (let pass = 0; pass < 2; pass++) for (const d of devices) await d.sync()
			await author.collection('projects').delete(String(project.id))
			for (let pass = 0; pass < 3; pass++) for (const d of devices) await d.sync()

			late = new TestDevice({
				name: 'late-joiner',
				schema,
				server: network.server,
				tmpDir: network.tmpDir,
				createTransportPair: pair,
			})
			await late.open()
			for (let pass = 0; pass < 2; pass++) {
				await late.sync()
				for (const d of devices) await d.sync()
			}

			for (const d of [...devices, late]) {
				expect(await d.getState('tasks')).toHaveLength(0)
				expect(await d.getState('projects')).toHaveLength(0)
			}
			const taskDeletes = network.server
				.getAllOperations()
				.filter((op) => op.collection === 'tasks' && op.type === 'delete')
			const authorNode = author.getNodeId()
			const byChild = new Map<string, string[]>()
			for (const op of taskDeletes) {
				byChild.set(op.recordId, [...(byChild.get(op.recordId) ?? []), op.nodeId])
			}
			expect(byChild.size).toBe(children)
			for (const nodes of byChild.values()) {
				// Exactly one from the author (its local delete) and one from the server.
				expect(nodes.filter((n) => n === authorNode)).toHaveLength(1)
				expect(nodes.filter((n) => n !== authorNode)).toHaveLength(1)
			}
			const receivers = new Set(
				[...devices.slice(1), late].map((d) => (d as TestDevice).getNodeId()),
			)
			expect(taskDeletes.filter((op) => receivers.has(op.nodeId))).toEqual([])
		} finally {
			await late?.close()
			await network.close()
		}
	}, 60_000)
})
