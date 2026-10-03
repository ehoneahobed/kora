/**
 * RT-73 repro (Phase 3 red team round 2, 2026-10-03): a cascade the server deferred to
 * the end of an upload batch (RT-69 residual fix) is lost for good when the batch
 * fails after the delete committed.
 *
 * `applyServerOperation` no longer derives a side effect the author claims to upload
 * itself in the same batch; the session derives it after the loop, only if no
 * authored copy was stored. The deferred list lives in memory. If anything throws
 * after the delete committed (a transient database error, a restart during a deploy),
 * the list is gone. The client re-sends the batch: the delete is now a stored
 * duplicate, and duplicates derive nothing, so if the author's copy is refused on the
 * retry (a child the author may read but not write, a validator, an invalid id) the
 * child is never cascaded: an orphan of a deleted parent, on the server and on every
 * device that syncs from it. Before the residual fix the effect was derived right
 * after the delete committed.
 *
 * Asserts the CORRECT behaviour (fails at 4d6c8a7): the child is deleted on the server.
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { batch, createHarness, makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		posts: { fields: { title: t.string() } },
		comments: { fields: { text: t.string(), postId: t.string().optional() } },
		notes: { fields: { title: t.string() } },
	},
	relations: {
		commentPost: {
			from: 'comments',
			to: 'posts',
			type: 'many-to-one',
			field: 'postId',
			onDelete: 'cascade',
		},
	},
})

/** A memory store whose apply of one operation id throws once (a transient failure). */
class FlakyStore extends MemoryServerStore {
	failOnce: string | null = null
	override async applyRemoteOperation(
		...args: Parameters<MemoryServerStore['applyRemoteOperation']>
	): ReturnType<MemoryServerStore['applyRemoteOperation']> {
		if (args[0].id === this.failOnce) {
			this.failOnce = null
			throw new Error('connection terminated unexpectedly')
		}
		return super.applyRemoteOperation(...args)
	}
}

describe('RT-73: deferred cascades are lost when the batch fails after the delete', () => {
	test('the child of a deleted post does not survive a retried batch', async () => {
		const store = new FlakyStore('server-1')
		const { server, login } = await createHarness(schema, null, {}, store)
		// Protocol 2: a protocol-1 session may store an unverifiable id unverified (RT-71),
		// which would let the bad-id copy below in; protocol 2 refuses it, as intended.
		const owner = await login('t', 'owner-node', { protocolVersion: 2 })
		const post = makeOp('owner-node', 1, {
			collection: 'posts',
			recordId: 'post-1',
			data: { title: 'p' },
		})
		const comment = makeOp('owner-node', 2, {
			collection: 'comments',
			recordId: 'c-1',
			data: { text: 'c', postId: 'post-1' },
			causalDeps: [post.id],
		})
		owner.send(batch([post, comment]))
		await tick(100)
		expect(await store.findRecord('comments', 'c-1')).not.toBeNull()

		const del = makeOp('owner-node', 3, {
			type: 'delete',
			collection: 'posts',
			recordId: 'post-1',
			data: null,
			causalDeps: [comment.id],
		})
		const unrelated = makeOp('owner-node', 4, {
			collection: 'notes',
			recordId: 'n-1',
			data: { title: 'n' },
			causalDeps: [del.id],
		})
		// The author's own cascade copy; it is refused (here: its id is not its content
		// hash; in production also a missing write grant on the child, or a validator).
		const copy: Operation = {
			...makeOp('owner-node', 5, {
				type: 'delete',
				collection: 'comments',
				recordId: 'c-1',
				data: null,
				causalDeps: [del.id],
			}),
			id: 'f'.repeat(64),
		}
		store.failOnce = unrelated.id
		const upload = batch([del, unrelated, copy])
		owner.send(upload)
		await tick(100)
		expect(await store.findRecord('posts', 'post-1')).toBeNull()

		// The client re-sends the unacknowledged batch on its next connection.
		const again = await login('t', 'owner-node', { protocolVersion: 2 })
		again.send(upload)
		await tick(150)

		expect(await store.findRecord('posts', 'post-1')).toBeNull()
		// Correct: the referential effect of the committed delete is never left undone.
		expect(await store.findRecord('comments', 'c-1')).toBeNull()
		await server.stop()
	})
})
