/**
 * RT-33 repro (2026-10-02, SYNC-11 server half): reconnecting an auth-scoped client
 * rescanned and re-sent its whole delivery stream.
 *
 * The client reports the watermark of the scope it REQUESTS. In an auth-scoped app the
 * server grants a different (resolved) scope, so it could not trust that watermark and
 * restarted the stream at 0 on every reconnect: the full in-scope history was scanned
 * and re-sent each time. The client keeps a watermark per accepted scope; it now also
 * reports the accepted scope it last streamed under (a canonical key) with that view's
 * watermark, and the server resumes from it when the scope it resolves now has the
 * same key. A widened grant changes the key, so the new view starts from 0 and the
 * newly visible records arrive.
 *
 * Asserts the CORRECT behaviour (fails before the fix).
 */
import { defineSchema, t } from '@korajs/core'
import { TokenAuthProvider } from '@korajs/server'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { type ScopedNetwork, scopedNetwork, settle } from './scoped-network'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), owner: t.string() } } },
})

/** Scope each principal is granted; mutable so a test can widen a grant. */
const grants = new Map<string, Record<string, Record<string, unknown>>>()
const auth = new TokenAuthProvider({
	validate: async (token) => ({
		userId: token,
		scopes: grants.get(token) ?? { todos: { owner: token } },
	}),
})

let net: ScopedNetwork | null = null
afterEach(async () => {
	await net?.close()
	net = null
	grants.clear()
	vi.restoreAllMocks()
})

/** Count the operations the server sends to one device in delivery batches. */
function countDelivered(n: ScopedNetwork, device: string): { ops: number; reset: () => void } {
	const counter = {
		ops: 0,
		reset: () => {
			counter.ops = 0
		},
	}
	n.intercept.set(device, (m: SyncMessage) => {
		if (m.type === 'operation-batch') counter.ops += m.operations.length
		return true
	})
	return counter
}

describe('RT-33: an auth-scoped client resumes its accepted view on reconnect', () => {
	test('reconnect streams only new operations, without rescanning from 0', async () => {
		net = await scopedNetwork(schema, { auth })
		const writer = await net.device({ name: 'alice-phone', token: 'alice' })
		const reader = await net.device({ name: 'alice-laptop', token: 'alice' })
		const delivered = countDelivered(net, 'alice-laptop')

		for (let i = 0; i < 20; i++) {
			await writer.collection('todos').insert({ title: `t${i}`, owner: 'alice' })
		}
		await settle([writer, reader])
		expect(await reader.getState('todos')).toHaveLength(20)
		await reader.disconnect()

		await writer.collection('todos').insert({ title: 'new-1', owner: 'alice' })
		await writer.collection('todos').insert({ title: 'new-2', owner: 'alice' })
		await settle([writer])

		const scans = vi.spyOn(net.store, 'getOperationsAfterDelivery')
		delivered.reset()
		await reader.reconnect()
		await settle([reader])

		expect(await reader.getState('todos')).toHaveLength(22)
		expect(delivered.ops).toBe(2)
		// The delivery scan resumed from the reader's watermark, never from 0.
		const cursors = scans.mock.calls.map(([after]) => after)
		expect(cursors.length).toBeGreaterThan(0)
		expect(Math.min(...cursors)).toBeGreaterThan(0)
	}, 30_000)

	test('a grant widened between sessions delivers the newly visible records', async () => {
		net = await scopedNetwork(schema, { auth })
		const alice = await net.device({ name: 'alice-laptop', token: 'alice' })
		const bob = await net.device({ name: 'bob-laptop', token: 'bob' })

		await alice.collection('todos').insert({ title: 'a1', owner: 'alice' })
		const shared = await bob.collection('todos').insert({ title: 'b1', owner: 'bob' })
		await settle([alice, bob])
		expect(await alice.getState('todos')).toHaveLength(1)
		await alice.disconnect()

		// Alice may now also read Bob's todos.
		grants.set('alice', { todos: { owner: { $in: ['alice', 'bob'] } } })
		await bob.collection('todos').insert({ title: 'b2', owner: 'bob' })
		await settle([bob])

		await alice.reconnect()
		await settle([alice])
		const titles = (await alice.getState('todos')).map((r) => r.title).sort()
		expect(titles).toEqual(['a1', 'b1', 'b2'])
		expect(await alice.collection('todos').findById(shared.id)).toMatchObject({ title: 'b1' })

		// And the widened view now resumes on the next reconnect.
		await alice.disconnect()
		const delivered = countDelivered(net, 'alice-laptop')
		await alice.reconnect()
		await settle([alice])
		expect(delivered.ops).toBe(0)
	}, 30_000)
})
