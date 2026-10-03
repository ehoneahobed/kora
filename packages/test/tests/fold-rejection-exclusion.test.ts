/**
 * W7 step 2: the client fold excludes what the server refused. A device's own
 * operation that the server terminally rejects never enters the authoritative log;
 * once the rejection arrives the author re-folds the record without it, so its
 * state converges to the server's and every other device's.
 */
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice, TestNetwork } from '../src/index'
import { createTestNetwork } from '../src/index'

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				tags: t.array(t.string()).default([]),
				score: t.number().merge('counter').default(0),
			},
		},
	},
})

let network: TestNetwork | null = null
afterEach(async () => {
	await network?.close()
	network = null
})

describe('a terminally rejected own operation is excluded from the author fold', () => {
	test('the author converges to the server and the other device', async () => {
		network = await createTestNetwork(schema, {
			devices: 2,
			validateOperation: (op) =>
				op.data?.title === 'forbidden'
					? { action: 'reject', code: 'POLICY_DENIED', message: 'not allowed', retriable: false }
					: { action: 'accept' },
		})
		const [author, other] = network.devices as [TestDevice, TestDevice]
		const created = await author.collection('items').insert({ title: 'ok', tags: ['a'] })
		await author.sync()
		await other.sync()

		// Offline: the author makes a refused edit (title + tags + counter in ONE op),
		// and the other device edits concurrently.
		await author.disconnect()
		await other.disconnect()
		await author.collection('items').update(created.id, {
			title: 'forbidden',
			tags: ['a', 'mine'],
			score: 5,
		})
		await other.collection('items').update(created.id, { tags: ['a', 'theirs'], score: 2 })
		expect((await author.collection('items').findById(created.id))?.title).toBe('forbidden')

		for (let pass = 0; pass < 3; pass++) {
			await author.sync()
			await other.sync()
		}

		const onAuthor = await author.collection('items').findById(created.id)
		const onOther = await other.collection('items').findById(created.id)
		const view = (record: Record<string, unknown> | null) => ({
			title: record?.title,
			tags: record?.tags,
			score: record?.score,
		})
		// Nothing of the refused operation survives on its author.
		expect(view(onAuthor)).toEqual({ title: 'ok', tags: ['a', 'theirs'], score: 2 })
		expect(view(onAuthor)).toEqual(view(onOther))
		const onServer = (await network.server.store.findRecord('items', created.id)) as Record<
			string,
			unknown
		> | null
		expect(onServer?.title).toBe('ok')
	}, 60_000)
})
