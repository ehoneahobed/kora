/**
 * RT-69 repro (Phase 3 red team, 2026-10-02): every device that applies a remote
 * cascading delete authors, stores and UPLOADS its own copy of every cascade.
 *
 * Seam 5 (RT-60) stamps a device's copies right after the delete, which fixed their
 * precedence, but the copies are still ordinary operations of the receiving device's
 * node (own id, own sequence number), so they enter the sync queue and the server
 * stores each one. Deleting a parent with N children in a workspace of D devices
 * stores about N x (D + 1) child deletes (the author's, the server's, and one per
 * receiving device), each relayed to every device, and each authorized against the
 * receiving user's grants (a reader's device has its copies refused). The cost is
 * proportional to the number of devices that ever apply the delete, including every
 * device that later re-syncs from scratch.
 *
 * Asserts the CORRECT behaviour (fails at 959b791): receiving devices do not upload
 * copies of effects the server already derives; the server stores at most the
 * author's and the server's copy of each cascade.
 */
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { type TestDevice, createTestNetwork } from '../../src/index'

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

describe('RT-69: cascade copies per receiving device', () => {
	test('deleting a parent stores at most two deletes per child', async () => {
		const network = await createTestNetwork(schema, { devices: 4 })
		try {
			const devices = network.devices as TestDevice[]
			const [author] = devices as [TestDevice]
			const project = await author.collection('projects').insert({ name: 'p' })
			const children = 20
			for (let i = 0; i < children; i++) {
				await author.collection('tasks').insert({ title: `t${i}`, projectId: String(project.id) })
			}
			for (let pass = 0; pass < 2; pass++) for (const d of devices) await d.sync()
			await author.collection('projects').delete(String(project.id))
			for (let pass = 0; pass < 3; pass++) for (const d of devices) await d.sync()

			for (const d of devices) expect(await d.getState('tasks')).toHaveLength(0)
			const taskDeletes = network.server
				.getAllOperations()
				.filter((op) => op.collection === 'tasks' && op.type === 'delete')
			expect(taskDeletes.length).toBeLessThanOrEqual(children * 2)
		} finally {
			await network.close()
		}
	}, 60_000)
})
