/**
 * Blob chunk delivery end to end (2026-10-18): a device whose initial sync is still
 * arriving (engine 'syncing': handshake accepted, final delta batch not yet received)
 * can already pull a blob through a real KoraSyncServer. Before the fix the request was
 * silently dropped on the client and the pull failed after a 30 s timeout.
 */
import { defineSchema, t } from '@korajs/core'
import { TokenAuthProvider } from '@korajs/server'
import type { ServerTransport } from '@korajs/server'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { type ScopedNetwork, scopedNetwork, settle } from './repro/scoped-network'

const schema = defineSchema({
	version: 1,
	collections: { files: { fields: { team: t.string(), doc: t.blob().optional() } } },
})

const auth = new TokenAuthProvider({
	validate: async (token) => ({ userId: token, scopes: { files: { team: 'red' } } }),
})

let net: ScopedNetwork | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

describe('blob chunk delivery through a real server', () => {
	test('a device still receiving its initial sync pulls a blob from a peer', async () => {
		net = await scopedNetwork(schema, { auth })
		const alice = await net.device({ name: 'alice', token: 'alice' })
		await settle([alice], 1)
		const bytes = new Uint8Array(64).map((_, i) => (i * 37) % 251)
		const { ref } = await alice.putBlob(bytes, { chunkSize: 16 })

		// Bob's initial delta is held back: his engine stays 'syncing'.
		const held: Array<{ message: SyncMessage; transport: ServerTransport }> = []
		net.intercept.set('bob', (message, transport) => {
			if (message.type !== 'operation-batch') return true
			held.push({ message, transport })
			return false
		})
		const bob = await net.device({ name: 'bob', token: 'bob' })
		await bob.sync()
		expect(bob.getSyncEngine()?.getState()).toBe('syncing')

		const result = await bob.pullBlobByRef(ref)
		expect(result.ref.hash).toBe(ref.hash)
		expect(await bob.getBlobBytes(ref.hash)).toEqual(bytes)

		net.intercept.delete('bob')
		for (const { message, transport } of held) transport.send(message)
	}, 20_000)
})
