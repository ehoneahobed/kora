/**
 * `refreshScopes(userId)`: an app re-resolves a user's grant right after a membership
 * change, instead of waiting for the periodic revalidation (disabled here, so only
 * the call can explain what happens).
 *
 * Bob is invited to Alice's shared space and receives its document as soon as the
 * app refreshes him; once removed, his device retracts the document (`scopeExit:
 * 'retract'`) and his offline edit to it is refused. Other users' sessions are left
 * alone, and an unchanged grant ends nothing.
 */
import { defineSchema, t } from '@korajs/core'
import { TokenAuthProvider } from '@korajs/server'
import { afterEach, describe, expect, test } from 'vitest'
import { type ScopedNetwork, scopedNetwork, settle } from './repro/scoped-network'

const schema = defineSchema({
	version: 1,
	collections: { docs: { fields: { spaceId: t.string(), title: t.string() } } },
})

let net: ScopedNetwork | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

describe('refreshScopes', () => {
	test('membership changes apply at once, and removal retracts on the removed device', async () => {
		const memberships: Record<string, string[]> = {
			alice: ['user:alice', 'doc:1'],
			bob: ['user:bob'],
		}
		const auth = new TokenAuthProvider({
			validate: async (token) => ({
				userId: token,
				scopes: { docs: { spaceId: { $in: [...(memberships[token] ?? [])] } } },
			}),
		})
		net = await scopedNetwork(schema, { auth, sessionRevalidationIntervalMs: 0 })
		const alice = await net.device({ name: 'alice-laptop', token: 'alice' })
		const bob = await net.device({ name: 'bob-laptop', token: 'bob', scopeExit: 'retract' })
		await settle([alice, bob])

		const doc = await alice.collection('docs').insert({ spaceId: 'doc:1', title: 'Plan' })
		await settle([alice, bob])
		expect(await bob.collection('docs').findById(doc.id)).toBeNull()

		// Invitation accepted: the app refreshes Bob.
		memberships.bob = ['user:bob', 'doc:1']
		expect(await net.server.refreshScopes('bob')).toBe(1)
		await settle([bob])
		expect(await bob.collection('docs').findById(doc.id)).toMatchObject({ title: 'Plan' })
		expect(alice.isConnected()).toBe(true)

		// Nothing changed for Alice: her session is kept.
		expect(await net.server.refreshScopes('alice')).toBe(0)
		expect(alice.isConnected()).toBe(true)

		// Bob edits offline; meanwhile Alice removes him.
		await bob.disconnect()
		await bob.collection('docs').update(doc.id, { title: 'Bob was here' })
		memberships.bob = ['user:bob']
		expect(await net.server.refreshScopes('bob')).toBe(0) // no live session to end
		await bob.reconnect()
		await settle([alice, bob])

		expect(await bob.collection('docs').findById(doc.id)).toBeNull()
		const rejected = await bob.getRejectedOperations()
		expect(rejected.map((r) => r.recordId)).toContain(doc.id)
		expect(await net.store.findRecord('docs', doc.id)).toMatchObject({ title: 'Plan' })
		expect(await alice.collection('docs').findById(doc.id)).toMatchObject({ title: 'Plan' })
	}, 60_000)

	test('a removed user with a live session is cut off by the call alone', async () => {
		const memberships: Record<string, string[]> = {
			alice: ['user:alice', 'doc:1'],
			bob: ['user:bob', 'doc:1'],
		}
		const auth = new TokenAuthProvider({
			validate: async (token) => ({
				userId: token,
				scopes: { docs: { spaceId: { $in: [...(memberships[token] ?? [])] } } },
			}),
		})
		net = await scopedNetwork(schema, { auth, sessionRevalidationIntervalMs: 0 })
		const alice = await net.device({ name: 'alice-laptop', token: 'alice' })
		const bob = await net.device({ name: 'bob-laptop', token: 'bob', scopeExit: 'retract' })
		const doc = await alice.collection('docs').insert({ spaceId: 'doc:1', title: 'Plan' })
		await settle([alice, bob])
		expect(await bob.collection('docs').findById(doc.id)).toMatchObject({ title: 'Plan' })

		memberships.bob = ['user:bob']
		expect(await net.server.refreshScopes('bob')).toBe(1)
		expect(bob.isConnected()).toBe(false)
		// Alice keeps writing; Bob reconnects with the narrowed grant.
		await alice.collection('docs').update(doc.id, { title: 'Plan v2' })
		await settle([alice, bob])
		expect(await bob.collection('docs').findById(doc.id)).toBeNull()
		expect(alice.isConnected()).toBe(true)
	}, 60_000)
})
