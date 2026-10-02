/**
 * RT-21 repro (red team round 3, 2026-10-02): an anonymous device is locked out for
 * good when its node token is lost.
 *
 * Since RT-12 the server binds an anonymous device's node id to a token it issues at
 * the first claim. The claim commits before the handshake response is delivered, so
 * a response lost in transit leaves a node the device can never use again: every
 * later handshake without the token is refused `NODE_ID_CLAIMED`, and the client has
 * no recovery, so its offline writes never sync. Nodes claimed under the legacy
 * shared anonymous owner are locked out the same way.
 *
 * Asserts the CORRECT behaviour (fails before the fix): the claim is provisional until
 * the device proves it saved the token; a device refused `NODE_ID_CLAIMED` rotates to
 * a fresh node id and re-sends its unsynced writes under it; legacy claims are
 * accepted during the deprecation window.
 */
import { defineSchema, t } from '@korajs/core'
import { MixedAuthProvider, TokenAuthProvider } from '@korajs/server'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { type ScopedNetwork, scopedNetwork } from './scoped-network'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { text: t.string() } } },
})

const auth = new MixedAuthProvider({
	primary: new TokenAuthProvider({ validate: async () => null }),
	anonymousScopes: { notes: {} },
})

let net: ScopedNetwork | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

async function serverHas(n: ScopedNetwork, id: string): Promise<boolean> {
	return (await n.store.findRecord('notes', id)) !== null
}

describe('RT-21: anonymous node claims survive a lost token', () => {
	test('a lost handshake response does not lock the device out', async () => {
		net = await scopedNetwork(schema, { auth })
		const device = await net.device({ name: 'kiosk', token: '' })
		let dropped = false
		net.intercept.set('kiosk', (m: SyncMessage, transport) => {
			if (!dropped && m.type === 'handshake-response') {
				// The claim (and its token) committed, but the response never arrives.
				dropped = true
				transport.close(1006, 'connection lost')
				return false
			}
			return true
		})
		await device.sync()
		expect(dropped).toBe(true)

		const note = await device.collection('notes').insert({ text: 'written offline' })
		await device.sync()
		await device.sync()
		expect(await serverHas(net, note.id)).toBe(true)
	}, 30_000)

	test('a device refused NODE_ID_CLAIMED rotates its node id and syncs its writes', async () => {
		net = await scopedNetwork(schema, { auth })
		const device = await net.device({ name: 'kiosk', token: '' })
		const original = device.getNodeId()
		// Someone else already holds this node id.
		expect(await net.store.claimNode(original, 'someone-else')).toBe(true)
		const rotations: unknown[] = []
		device.emitter.on('sync:node-id-rotated', (event) => rotations.push(event))

		const first = await device.collection('notes').insert({ text: 'first' })
		const second = await device.collection('notes').insert({ text: 'second' })
		await device.sync()
		await device.sync()
		await device.sync()

		expect(device.getNodeId()).not.toBe(original)
		expect(rotations.length).toBe(1)
		expect(await serverHas(net, first.id)).toBe(true)
		expect(await serverHas(net, second.id)).toBe(true)
		// The local copies are intact.
		expect((await device.collection('notes').findById(first.id))?.text).toBe('first')
	}, 30_000)

	test('a node claimed under the legacy shared anonymous owner is still accepted', async () => {
		net = await scopedNetwork(schema, { auth })
		const device = await net.device({ name: 'kiosk', token: '' })
		expect(await net.store.claimNode(device.getNodeId(), 'kora:anonymous')).toBe(true)
		const note = await device.collection('notes').insert({ text: 'legacy' })
		await device.sync()
		await device.sync()
		expect(await serverHas(net, note.id)).toBe(true)
	}, 30_000)
})
