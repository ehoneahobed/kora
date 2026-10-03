/**
 * RT-77: an upload is a duplicate only when it is the SAME operation the server stores
 * under its id. Reusing a stored id with other content is refused (FORGED_DUPLICATE,
 * terminal), logged and counted, and has no effect: no derived op, no validator call,
 * no rate charge beyond the batch lookup. An honest re-upload is still a free duplicate.
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { batch, createHarness, deliveredOpIds, makeOp, sendAndAwaitAck } from '../repro/rt-fixture'

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

function rejections(messages: SyncMessage[]): Array<{ code: string; retriable: boolean }> {
	return messages
		.filter((m) => m.type === 'operation-rejected')
		.map((m) => m as unknown as { code: string; retriable: boolean })
		.map(({ code, retriable }) => ({ code, retriable }))
}

describe('forged duplicates (RT-77)', () => {
	test('a stored id with other content is refused FORGED_DUPLICATE, with no effect', async () => {
		const validated: string[] = []
		const { store, server, login } = await createHarness(schema, null, {
			validateOperation: (op) => {
				validated.push(op.id)
				return { action: 'accept' }
			},
		})
		const owner = await login('t', 'owner-node', { protocolVersion: 2 })
		const post = makeOp('owner-node', 1, {
			collection: 'posts',
			recordId: 'post-1',
			data: { title: 'p' },
		})
		const comment = makeOp('owner-node', 2, {
			collection: 'comments',
			recordId: 'c-1',
			data: { text: 'one', postId: 'post-1' },
			causalDeps: [post.id],
		})
		await sendAndAwaitAck(owner, [post, comment])

		const mallory = await login('t', 'mallory-node', { protocolVersion: 2 })
		const note = makeOp('mallory-node', 1, {
			collection: 'notes',
			recordId: 'n-1',
			data: { title: 'n' },
		})
		await sendAndAwaitAck(mallory, [note])
		const validatedBefore = validated.length
		const deliveredBefore = deliveredOpIds(owner.messages).length

		await sendAndAwaitAck(mallory, [
			{
				...note,
				type: 'delete',
				collection: 'posts',
				recordId: 'post-1',
				data: null,
				sequenceNumber: 2,
			},
		])
		expect(rejections(mallory.messages)).toEqual([{ code: 'FORGED_DUPLICATE', retriable: false }])
		expect(validated.length).toBe(validatedBefore)
		expect(await store.findRecord('posts', 'post-1')).not.toBeNull()
		expect(await store.findRecord('comments', 'c-1')).not.toBeNull()
		expect(await store.findRecord('notes', 'n-1')).not.toBeNull()
		expect(deliveredOpIds(owner.messages).length).toBe(deliveredBefore)
		expect(server.getMetricsCollector().getSnapshot(0).forgedDuplicates).toBe(1)

		// The honest re-upload of the same note is still a duplicate: acknowledged, free,
		// never validated again, never refused.
		mallory.messages.length = 0
		await sendAndAwaitAck(mallory, [note])
		expect(rejections(mallory.messages)).toEqual([])
		expect(validated.length).toBe(validatedBefore)
		await server.stop()
	})

	test('an honest re-sent delete is re-checked on the STORED delete only', async () => {
		const { store, server, login } = await createHarness(schema, null)
		const owner = await login('t', 'owner-node', { protocolVersion: 2 })
		const post = makeOp('owner-node', 1, {
			collection: 'posts',
			recordId: 'post-1',
			data: { title: 'p' },
		})
		const other = makeOp('owner-node', 2, {
			collection: 'posts',
			recordId: 'post-2',
			data: { title: 'q' },
		})
		const child = makeOp('owner-node', 3, {
			collection: 'comments',
			recordId: 'c-2',
			data: { text: 'two', postId: 'post-2' },
			causalDeps: [other.id],
		})
		const del = makeOp('owner-node', 4, {
			collection: 'posts',
			recordId: 'post-1',
			type: 'delete',
			data: null,
			causalDeps: [post.id],
		})
		await sendAndAwaitAck(owner, [post, other, child, del])
		// The stored delete re-sent with post-2 as its target: refused, post-2's child kept.
		owner.send(batch([{ ...del, recordId: 'post-2' }]))
		await sendAndAwaitAck(owner, [del])
		expect(rejections(owner.messages).map((r) => r.code)).toEqual(['FORGED_DUPLICATE'])
		expect(await store.findRecord('posts', 'post-2')).not.toBeNull()
		expect(await store.findRecord('comments', 'c-2')).not.toBeNull()
		expect(await store.findRecord('posts', 'post-1')).toBeNull()
		await server.stop()
	})
})
