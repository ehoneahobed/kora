/**
 * RT-94 repro (Phase 4 beta.12 compatibility, 2026-10-03): with a server of this
 * release, a provisional cascade that no server copy confirms stays applied on a
 * streaming device until its next reconnect.
 *
 * Since RT-69 a receiving device applies the cascades of a remote delete as local-only
 * provisional effects, retired when the server's copy arrives or when the delivery
 * stream catches up, which the client only recognised at the end of a handshake's
 * initial sync. A delete the server derives no cascade for leaves the effect applied on
 * every device that was streaming when it arrived, while devices that received the same
 * delete during a catch-up (and the server) keep the child. Found in the mixed-fleet
 * chaos matrix (`scripts/remediation/compat-beta12.mjs <b12> chaos/current-server`,
 * seed 6): a second delete of an already-deleted project, whose late child the server
 * revived from the child's later edits and derived nothing for; no beta.12 component is
 * involved. The protocol-1 variant is RT-91.
 *
 * Simulated deterministically: the author's link drops the server-derived (`kora:`)
 * operations, so no server copy confirms the effect (protocol 2 kept).
 *
 * Asserts the CORRECT behaviour (fails before the fix): after the stream settles, the
 * streaming device agrees with a fresh device that received the same operations.
 */
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { type ScopedNetwork, scopedNetwork } from './scoped-network'

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

/** The server derived nothing for the delete: its own operations never arrive. */
function withoutServerCopies(message: SyncMessage): SyncMessage {
	if (message.type !== 'operation-batch') return message
	return {
		...message,
		operations: message.operations.filter((op) => !op.nodeId.startsWith('kora:')),
	}
}

let net: ScopedNetwork | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

describe('RT-94: an unconfirmed provisional cascade on a streaming device (protocol 2)', () => {
	test('a streaming device and a fresh device agree on a late child', async () => {
		net = await scopedNetwork(schema, {})
		const n = net
		for (const name of ['author-of-child', 'fresh']) {
			n.intercept.set(name, (message, transport) => {
				transport.send(withoutServerCopies(message))
				return false
			})
		}
		const deleter = await n.device({ name: 'deleter', token: '' })
		const author = await n.device({ name: 'author-of-child', token: '' })
		const project = await deleter.collection('projects').insert({ name: 'p' })
		await deleter.sync()
		await author.sync()
		await author.sync()
		await deleter.disconnect()
		const child = await author
			.collection('tasks')
			.insert({ title: 'late child', projectId: String(project.id) })
		await author.sync()
		await deleter.collection('projects').delete(String(project.id))
		await deleter.sync()
		for (let i = 0; i < 3; i++) {
			await deleter.sync()
			await author.sync()
		}
		const fresh = await n.device({ name: 'fresh', token: '' })
		await fresh.sync()
		await fresh.sync()
		const onFresh = await fresh.collection('tasks').findById(String(child.id))
		const onAuthor = await author.collection('tasks').findById(String(child.id))
		expect(onAuthor === null).toBe(onFresh === null)
	}, 30_000)
})
