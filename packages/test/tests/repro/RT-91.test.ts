/**
 * RT-91 repro (Phase 4 beta.12 compatibility, 2026-10-03): through a beta.12 (protocol 1)
 * server, a provisional cascade of a remote delete stays applied for as long as the
 * device stays connected, so devices diverge.
 *
 * Since RT-69 a receiving device applies the cascades of a remote delete as local-only
 * provisional effects, retired when the author's or the server's copy arrives, or when
 * the delivery stream catches up (the final batch after a handshake). A server of this
 * release always derives the cascade of a late child (one the deleting device did not
 * hold). A beta.12 server derives none. A device that holds such a child and is
 * STREAMING when the delete arrives keeps the provisional delete until it reconnects;
 * a device that received the same delete during a catch-up (or a fresh device) keeps
 * the child. Under a beta.12 server nothing else ever settles it.
 *
 * Found with the real beta.12 build (tag v1.0.0-beta.12):
 * `scripts/remediation/compat-beta12.mjs <b12> chaos/b12-server` (seed 8: the author of a
 * late child had it deleted provisionally, its peers and a fresh device had it).
 *
 * Simulated here with this release's server: device B's link strips the handshake's
 * `protocolVersion` (a beta.12 server sends none) and drops server-derived (`kora:`)
 * operations, which a beta.12 server never sends.
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

/** What a beta.12 server sends: no protocol version, no server-derived operations. */
function asBeta12Server(message: SyncMessage): SyncMessage {
	if (message.type === 'handshake-response') {
		const { protocolVersion: _v, ...rest } = message as SyncMessage & { protocolVersion?: number }
		return rest as SyncMessage
	}
	if (message.type === 'operation-batch') {
		return {
			...message,
			operations: message.operations.filter((op) => !op.nodeId.startsWith('kora:')),
		}
	}
	return message
}

let net: ScopedNetwork | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

describe('RT-91: provisional cascades through a protocol-1 server', () => {
	test('a streaming device and a fresh device agree on a late child', async () => {
		net = await scopedNetwork(schema, {})
		const n = net
		for (const name of ['author-of-child', 'fresh']) {
			n.intercept.set(name, (message, transport) => {
				transport.send(asBeta12Server(message))
				return false
			})
		}
		const deleter = await n.device({ name: 'deleter', token: '' })
		const author = await n.device({ name: 'author-of-child', token: '' })
		const project = await deleter.collection('projects').insert({ name: 'p' })
		await deleter.sync()
		await author.sync()
		await author.sync()
		expect(await author.collection('projects').findById(String(project.id))).not.toBeNull()

		// The deleter goes offline; the author adds a child the deleter never sees.
		await deleter.disconnect()
		const child = await author
			.collection('tasks')
			.insert({ title: 'late child', projectId: String(project.id) })
		await author.sync()
		// The deleter deletes the project offline, then reconnects: the author is streaming.
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
