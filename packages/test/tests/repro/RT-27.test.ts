/**
 * RT-27 repro (2026-10-02): a scope-entry operation (RT-19) carried ONE timestamp,
 * the record's newest HLC, for every field.
 *
 * Under per-field last-write-wins that whole-row stamp beats a device's own newer
 * unsynced edit of a field whose server version is OLDER than the record's newest
 * server write. The device's field is overwritten locally, then its own pending
 * operation uploads and wins on the server: device and server diverge. The entry also
 * made a fresh device's `createdAt` the record's latest edit time.
 *
 * Scenario: device D holds the record (retain mode keeps a stale copy when it leaves
 * D's scope). Server has title@t1 and body@t7; D edits title offline at t5 (between
 * them). The record re-enters D's scope (owner@t8, scope-entry delivered). D
 * reconnects and uploads. D, the server and a third device must converge on
 * title = D's edit and body = the server's.
 *
 * Asserts the CORRECT behaviour (fails before the fix).
 */
import { defineSchema, t } from '@korajs/core'
import { TokenAuthProvider } from '@korajs/server'
import { afterEach, describe, expect, test } from 'vitest'
import { type ScopedNetwork, scopedNetwork, settle } from './scoped-network'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), body: t.string(), owner: t.string() } },
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) => ({ userId: token, scopes: { todos: { owner: token } } }),
})

let net: ScopedNetwork | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

async function trustedUpdate(n: ScopedNetwork, id: string, data: Record<string, unknown>) {
	const result = await n.server
		.getKoraContext()
		.apply({ collection: 'todos', type: 'update', recordId: id, data })
	expect(result.ok).toBe(true)
}

describe('RT-27: a scope-entry operation never overrides a newer field edit', () => {
	test('stale retained copy with an offline edit converges with the server and peers', async () => {
		net = await scopedNetwork(schema, { auth })
		const d = await net.device({ name: 'alice-laptop', token: 'alice' })
		const peer = await net.device({ name: 'alice-phone', token: 'alice' })

		// t1: title and body written.
		const rec = await d
			.collection('todos')
			.insert({ title: 'title@t1', body: 'body@t1', owner: 'alice' })
		await settle([d, peer])
		await d.disconnect()

		// t2: the record leaves Alice's scope (D keeps its stale copy: retain).
		await trustedUpdate(net, rec.id, { owner: 'bob' })
		// t5: D edits the title offline.
		await new Promise((r) => setTimeout(r, 5))
		await d.collection('todos').update(rec.id, { title: 'title@t5 (D)' })
		await new Promise((r) => setTimeout(r, 5))
		// t7: the body changes on the server; t8: the record returns to Alice.
		await trustedUpdate(net, rec.id, { body: 'body@t7 (server)' })
		await trustedUpdate(net, rec.id, { owner: 'alice' })
		await settle([peer])

		// D reconnects: receives the scope entry, uploads its pending edit.
		await d.reconnect()
		await settle([d, peer])

		const expected = { title: 'title@t5 (D)', body: 'body@t7 (server)', owner: 'alice' }
		expect(await d.getRejectedOperations()).toEqual([])
		expect(await net.store.findRecord('todos', rec.id)).toMatchObject(expected)
		expect(await d.collection('todos').findById(rec.id)).toMatchObject(expected)
		expect(await peer.collection('todos').findById(rec.id)).toMatchObject(expected)

		// A fresh device converges too.
		const fresh = await net.device({ name: 'alice-tablet', token: 'alice' })
		await settle([fresh])
		expect(await fresh.collection('todos').findById(rec.id)).toMatchObject(expected)
	}, 60_000)

	test('a device regaining scope after a retraction keeps its newer offline edit', async () => {
		net = await scopedNetwork(schema, { auth })
		const d = await net.device({ name: 'alice-laptop', token: 'alice', scopeExit: 'retract' })
		const peer = await net.device({ name: 'alice-phone', token: 'alice' })

		const rec = await d
			.collection('todos')
			.insert({ title: 'title@t1', body: 'body@t1', owner: 'alice' })
		await settle([d, peer])
		// D edits the title offline (t5) before learning the record left its scope.
		await d.disconnect()
		await trustedUpdate(net, rec.id, { owner: 'bob' })
		await new Promise((r) => setTimeout(r, 5))
		await d.collection('todos').update(rec.id, { title: 'title@t5 (D)' })
		await new Promise((r) => setTimeout(r, 5))
		await trustedUpdate(net, rec.id, { body: 'body@t7 (server)' })
		await trustedUpdate(net, rec.id, { owner: 'alice' })

		await d.reconnect()
		await settle([d, peer])

		const expected = { title: 'title@t5 (D)', body: 'body@t7 (server)', owner: 'alice' }
		expect(await net.store.findRecord('todos', rec.id)).toMatchObject(expected)
		expect(await d.collection('todos').findById(rec.id)).toMatchObject(expected)
		expect(await peer.collection('todos').findById(rec.id)).toMatchObject(expected)
	}, 60_000)

	test('a fresh device entering via a scope entry keeps the original createdAt', async () => {
		net = await scopedNetwork(schema, { auth })
		const alice = await net.device({ name: 'alice-laptop', token: 'alice' })
		const rec = await alice.collection('todos').insert({ title: 't', body: 'b', owner: 'alice' })
		await settle([alice])
		await new Promise((r) => setTimeout(r, 20))
		await alice.collection('todos').update(rec.id, { title: 't2' })
		await settle([alice])
		await new Promise((r) => setTimeout(r, 20))
		await trustedUpdate(net, rec.id, { owner: 'bob' })

		const bob = await net.device({ name: 'bob-laptop', token: 'bob' })
		await settle([bob])
		const entered = await bob.collection('todos').findById(rec.id)
		expect(entered).toMatchObject({ title: 't2', owner: 'bob' })
		expect(entered?.createdAt).toBe(rec.createdAt)
	}, 60_000)
})
