/**
 * F6: the device and the server refuse exactly the same operations by default. A write
 * the device accepts must never be refused by a default server for its size, or a
 * fire-and-forget mutation would succeed locally and be undone after upload.
 */
import { defineSchema, t } from '@korajs/core'
import { TokenAuthProvider } from '@korajs/server'
import { afterEach, describe, expect, test } from 'vitest'
import { type ScopedNetwork, scopedNetwork, settle } from './repro/scoped-network'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string() } } },
})

let net: ScopedNetwork | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

describe('F6: default operation size limits agree', () => {
	test('a write just under the device limit is stored by a default server; one over is refused on the device', async () => {
		net = await scopedNetwork(schema, {
			auth: new TokenAuthProvider({ validate: async (token) => ({ userId: token }) }),
		})
		const device = await net.device({ name: 'ann-laptop', token: 'ann' })
		// 250 KiB of text: inside the 256 KiB default on both sides.
		const near = await device.collection('notes').insert({ body: 'x'.repeat(250 * 1024) })
		await settle([device])
		expect(await device.getRejectedOperations()).toEqual([])
		expect((await net.store.findRecord('notes', near.id))?.body).toHaveLength(250 * 1024)

		await expect(
			device.collection('notes').insert({ body: 'x'.repeat(260 * 1024) }),
		).rejects.toMatchObject({ code: 'OPERATION_TOO_LARGE' })
	}, 60_000)
})
