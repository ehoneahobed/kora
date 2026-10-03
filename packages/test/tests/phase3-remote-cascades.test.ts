/**
 * RT-69 acceptance: a device applying a REMOTE cascading delete never authors or
 * uploads its own copies of the cascades. Four devices and a late joiner: the server
 * stores exactly one cascade per child, the author's (a LOCAL delete's effects are
 * authored and uploaded; the server derives no second copy of an effect the author
 * uploaded in the same batch), and nothing from any receiving device. A delete whose
 * author did not know a child still cascades it: the server derives that one. Every
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
	test("4 devices + a late joiner: exactly one cascade per child (the author's), none from the server or receivers", async () => {
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
				// Exactly one per child: the author's (its local delete). The server does not
				// derive a second copy of a cascade the author uploaded itself (RT-69).
				expect(nodes).toEqual([authorNode])
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

	test('a child the deleting device never saw is cascaded by the server, everywhere', async () => {
		const network = await createTestNetwork(schema, { devices: 3 })
		try {
			const [author, other, observer] = network.devices as [TestDevice, TestDevice, TestDevice]
			const project = await author.collection('projects').insert({ name: 'p' })
			const known = await author
				.collection('tasks')
				.insert({ title: 'known', projectId: String(project.id) })
			for (const d of [author, other, observer]) await d.sync()
			for (const d of [author, other, observer]) await d.sync()
			// The author goes offline; another device adds a child the author never sees.
			await author.disconnect()
			const unseen = await other
				.collection('tasks')
				.insert({ title: 'unseen', projectId: String(project.id) })
			await other.sync()
			await author.collection('projects').delete(String(project.id))
			for (let pass = 0; pass < 3; pass++) for (const d of [author, other, observer]) await d.sync()

			for (const d of [author, other, observer]) {
				expect(await d.getState('tasks')).toHaveLength(0)
				expect(await d.getState('projects')).toHaveLength(0)
			}
			const deletes = network.server
				.getAllOperations()
				.filter((op) => op.collection === 'tasks' && op.type === 'delete')
			expect(
				deletes.filter((op) => op.recordId === String(known.id)).map((op) => op.nodeId),
			).toEqual([author.getNodeId()])
			const unseenDeletes = deletes.filter((op) => op.recordId === String(unseen.id))
			expect(unseenDeletes).toHaveLength(1)
			expect(unseenDeletes[0]?.nodeId.startsWith('kora:server:')).toBe(true)
		} finally {
			await network.close()
		}
	}, 60_000)
})
