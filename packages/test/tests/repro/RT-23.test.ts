/**
 * RT-23 repro (red team round 3, 2026-10-02): in peer-relay mode (no central blob
 * store) blob possession is never recorded, so identical content referenced by a
 * second tenant is refused for good.
 *
 * Since RT-11 a blob reference is accepted only when the writer can already read a
 * record referencing the hash, owns it (pushed the bytes), or claims an unowned,
 * unreferenced hash. Without central persistence the server ignores pushes, so the
 * second tenant that legitimately holds the same bytes (a common PDF template, a
 * stock image) can never prove possession.
 *
 * Asserts the CORRECT behaviour (fails before the fix): in peer mode the server
 * verifies pushed bytes against their hash and records possession without storing
 * them; a tenant that never held the bytes still cannot read them.
 */
import { defineSchema, t } from '@korajs/core'
import { TokenAuthProvider } from '@korajs/server'
import { afterEach, describe, expect, test } from 'vitest'
import { type ScopedNetwork, scopedNetwork, settle } from './scoped-network'

const schema = defineSchema({
	version: 1,
	collections: { files: { fields: { owner: t.string(), doc: t.blob().optional() } } },
})

const auth = new TokenAuthProvider({
	validate: async (token) => ({ userId: token, scopes: { files: { owner: token } } }),
})

function template(): Uint8Array {
	const bytes = new Uint8Array(3000)
	for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff
	return bytes
}

let net: ScopedNetwork | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

describe('RT-23: identical blob content in two tenants (peer-relay mode)', () => {
	test('both tenants may reference the same content; a third tenant cannot read it', async () => {
		net = await scopedNetwork(schema, { auth })
		const alice = await net.device({ name: 'alice', token: 'alice' })
		const bob = await net.device({ name: 'bob', token: 'bob' })
		const eve = await net.device({ name: 'eve', token: 'eve' })
		await settle([alice, bob, eve], 1)

		const a = await alice.putBlob(template(), { chunkSize: 512 })
		const aliceFile = await alice.collection('files').insert({ owner: 'alice', doc: a.ref })
		await settle([alice])
		expect(await net.store.findRecord('files', aliceFile.id)).not.toBeNull()

		const b = await bob.putBlob(template(), { chunkSize: 512 })
		expect(b.ref.manifestHash).toBe(a.ref.manifestHash)
		const bobFile = await bob.collection('files').insert({ owner: 'bob', doc: b.ref })
		await settle([bob])
		expect(await bob.getRejectedOperations()).toEqual([])
		expect(await net.store.findRecord('files', bobFile.id)).not.toBeNull()

		// A tenant whose scope references nothing gets nothing, from anyone.
		await expect(eve.pullBlobByRef(a.ref)).rejects.toThrow()
	}, 60_000)
})
