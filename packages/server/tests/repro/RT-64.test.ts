/**
 * RT-64 repro (Phase 3 red team, 2026-10-02): a protocol-2 client can omit
 * `hashVersion` and upload operations whose id is not their content hash. The server
 * verifies only ids that declare version 2, and clients verify only version-2 or
 * enveloped ops, so a version-1 op is never checked anywhere. Server-derived ids
 * (`deriveSideEffectOpId` over a parent op id, a `server/` rule and the target record)
 * are 64-hex strings in the same space, and every store deduplicates by id alone.
 *
 * A writer that knows the parent of a correction can therefore pre-store an arbitrary
 * operation under the correction's id; when the server later derives the correction,
 * the store answers 'duplicate' and the correction is never stored. Here a user
 * writes a comment under a post that was already deleted (cascade). The server's
 * `cascade-late` correction id is derived from the post's delete id (delivered to the
 * user) and the comment's own op id (chosen by the user), so it is fully predictable:
 * the orphan comment survives on the server and on every device.
 *
 * Asserts the CORRECT behaviour (fails at 959b791): the late child is deleted.
 */
import { defineSchema, deriveSideEffectOpId, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { withContentId } from '../fixtures/content-id'
import { batch, createHarness, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		posts: { fields: { title: t.string() } },
		comments: { fields: { text: t.string(), postId: t.string().optional() } },
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

function op(nodeId: string, seq: number, partial: Partial<Operation>): Operation {
	const built: Operation = {
		id: `rt64-${nodeId}-${seq}`,
		nodeId,
		type: 'insert',
		collection: 'posts',
		recordId: 'x',
		data: {},
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: seq, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	}
	// Honest operations carry real (version-1) content ids; only the squat chooses one.
	return partial.id === undefined ? withContentId(built) : built
}

describe('RT-64: unverified version-1 ids squat server-derived correction ids', () => {
	test('a comment written under a deleted post is deleted by the server', async () => {
		const { store, server, login } = await createHarness(schema, null)
		const owner = await login('t', 'owner-node')
		const post = op('owner-node', 1, { recordId: 'post-1', data: { title: 'p' } })
		const del = op('owner-node', 2, {
			type: 'delete',
			recordId: 'post-1',
			data: null,
			causalDeps: [post.id],
		})
		owner.send(batch([post, del]))
		await tick()
		expect(await store.findRecord('posts', 'post-1')).toBeNull()

		// The attacker saw the delete (its id is on the wire) and chooses its own op id.
		const attacker = await login('t', 'attacker-node')
		const comment = op('attacker-node', 2, {
			collection: 'comments',
			recordId: 'c-1',
			data: { text: 'still here', postId: 'post-1' },
		})
		const correctionId = await deriveSideEffectOpId(
			`${del.id}|${comment.id}`,
			'server/relation:commentPost:cascade-late',
			'c-1',
		)
		// Any harmless operation, uploaded first under the correction's id; no hashVersion,
		// so nothing verifies the id against the content.
		const squat = op('attacker-node', 1, {
			id: correctionId,
			collection: 'comments',
			recordId: 'decoy',
			data: { text: 'decoy' },
		})
		attacker.send(batch([squat, comment]))
		await tick(100)

		// Correct: the late child of a deleted cascade parent does not survive.
		expect(await store.findRecord('comments', 'c-1')).toBeNull()
		// The squat itself is refused: its id is not the hash of its content.
		expect(
			attacker.messages.some(
				(m) =>
					m.type === 'operation-rejected' &&
					m.operationId === correctionId &&
					m.code === 'INVALID_OPERATION_ID',
			),
		).toBe(true)
		expect(await store.findRecord('comments', 'decoy')).toBeNull()
		await server.stop()
	})
})
