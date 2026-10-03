/**
 * RT-77 repro (Phase 3 red team round 3, 2026-10-03): the RT-73 duplicate-delete
 * re-check runs the referential effects of the UPLOADED operation's content, not of the
 * stored delete it duplicates.
 *
 * `isStoredDuplicate` matches on the id and node alone (own node: any sequence; another
 * node: same sequence). It runs before `checkUploadIntegrity`, so the uploaded content
 * is never compared with the stored operation and its id is never verified. The new
 * duplicate path then calls `resumeStoredDeleteEffects(op)` whenever the UPLOADED op
 * says `type: 'delete'`: `undoneSideEffectsOfStoredDelete` evaluates
 * `checkReferentialIntegrityOnDelete` for the uploaded collection and record id, and the
 * server derives cascades (server-authored, `kora:server:` node) for every child of
 * that record. The record itself was never deleted.
 *
 * A device needs only the id of any operation the server stores: one of its own (any
 * sequence), or any delivered operation of another node (with that node id and
 * sequence). No operation validator runs (duplicates skip it), the rate limiter is not
 * charged (a duplicate is free), and the derived deletes carry server authority.
 *
 * Asserts the CORRECT behaviour (fails at 97981a7): the live post keeps its comments.
 */
import { defineSchema, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
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

async function seedPostWithComments(
	login: Awaited<ReturnType<typeof createHarness>>['login'],
): Promise<void> {
	const owner = await login('t', 'owner-node', { protocolVersion: 2 })
	const post = makeOp('owner-node', 1, {
		collection: 'posts',
		recordId: 'post-1',
		data: { title: 'p' },
	})
	const c1 = makeOp('owner-node', 2, {
		collection: 'comments',
		recordId: 'c-1',
		data: { text: 'one', postId: 'post-1' },
		causalDeps: [post.id],
	})
	const c2 = makeOp('owner-node', 3, {
		collection: 'comments',
		recordId: 'c-2',
		data: { text: 'two', postId: 'post-1' },
		causalDeps: [post.id],
	})
	owner.send(batch([post, c1, c2]))
	await tick(100)
}

describe('RT-77: a forged duplicate delete cascades a live record', () => {
	test('own stored id: a "delete" duplicate of an own insert cascades a live post', async () => {
		// Every delete must be refused by the app's validator: the attack bypasses it.
		const { store, server, login } = await createHarness(schema, null, {
			validateOperation: (op) =>
				op.type === 'delete' && op.nodeId === 'mallory-node'
					? { action: 'reject', code: 'NO_DELETES', message: 'mallory may not delete' }
					: { action: 'accept' },
		})
		await seedPostWithComments(login)
		expect(await store.findRecord('comments', 'c-1')).not.toBeNull()

		const mallory = await login('t', 'mallory-node', { protocolVersion: 2 })
		const note = makeOp('mallory-node', 1, {
			collection: 'notes',
			recordId: 'n-1',
			data: { title: 'harmless' },
		})
		mallory.send(batch([note]))
		await tick(100)
		expect(await store.findRecord('notes', 'n-1')).not.toBeNull()

		// Same id as the stored note insert, any sequence, different content.
		const forged = {
			...note,
			type: 'delete' as const,
			collection: 'posts',
			recordId: 'post-1',
			data: null,
			sequenceNumber: 2,
		}
		mallory.send(batch([forged]))
		await tick(150)

		// The post was never deleted ...
		expect(await store.findRecord('posts', 'post-1')).not.toBeNull()
		// ... so its comments must still exist (fails: the server cascaded them).
		expect(await store.findRecord('comments', 'c-1')).not.toBeNull()
		expect(await store.findRecord('comments', 'c-2')).not.toBeNull()
		await server.stop()
	})

	test("another node's delivered id: same (node, sequence, id), forged content", async () => {
		const { store, server, login } = await createHarness(schema, null)
		await seedPostWithComments(login)
		// Any later stored operation of any node will do: the derived cascades are stamped
		// right after the forged "delete", so it must be newer than the children.
		const owner = await login('t', 'owner-node', { protocolVersion: 2 })
		const later = makeOp('owner-node', 4, {
			collection: 'notes',
			recordId: 'n-owner',
			data: { title: 'later' },
		})
		owner.send(batch([later]))
		await tick(100)
		const stored = (await store.getOperationRange('owner-node', 4, 4))[0]
		if (!stored) throw new Error('later op not stored')

		const mallory = await login('t', 'mallory-node', { protocolVersion: 2 })
		// Mallory echoes the owner's delivered id under the owner's node and sequence: the
		// batch lookup calls it a stored duplicate before any per-op check.
		const forged = {
			...stored,
			type: 'delete' as const,
			collection: 'posts',
			recordId: 'post-1',
			data: null,
			previousData: null,
		}
		mallory.send(batch([forged]))
		await tick(150)

		expect(await store.findRecord('posts', 'post-1')).not.toBeNull()
		expect(await store.findRecord('comments', 'c-1')).not.toBeNull()
		expect(await store.findRecord('comments', 'c-2')).not.toBeNull()
		await server.stop()
	})
})
