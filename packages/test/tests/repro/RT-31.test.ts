/**
 * RT-31 repro (2026-10-02, Phase 2 seam W3 x server ingest): the one-time upgrade
 * re-upload of a device's own history must be harmless.
 *
 * After upgrading, a device with no recorded acknowledged prefix re-uploads every op
 * it ever wrote (the server dedups by id). The server session authorized,
 * timestamp-checked, size-checked and ran the app validator on each re-uploaded op
 * BEFORE noticing it already stored it. An op that today's authorization refuses
 * (its record was since transferred to another owner by a server route) came back as
 * a non-retriable SCOPE_VIOLATION for an op the server already holds: the device
 * recorded a rejection and could roll back its own, already-synced write.
 *
 * Asserts the CORRECT behaviour (fails before the fix).
 */
import { defineSchema, t } from '@korajs/core'
import { TokenAuthProvider } from '@korajs/server'
import type { StorageAdapter } from '@korajs/store'
import { afterEach, describe, expect, test } from 'vitest'
import { type ScopedNetwork, scopedNetwork, settle } from './scoped-network'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), owner: t.string() } },
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

describe('RT-31: upgrade re-upload of already-stored ops is acknowledged as duplicate', () => {
	test('an op whose record was transferred away is re-uploaded without rejection', async () => {
		const rejected: string[] = []
		let validatorCalls = 0
		net = await scopedNetwork(schema, {
			auth,
			// An app validator that would refuse any client write to a record the writer
			// no longer owns; it must not even be consulted for an already-stored op.
			validateOperation: async (op, ctx) => {
				validatorCalls += 1
				const row = await ctx.kora.findById(op.collection, op.recordId)
				if (row && row.owner !== ctx.auth?.userId) {
					return { action: 'reject', code: 'NOT_OWNER', message: 'not yours', retriable: false }
				}
				return { action: 'accept' }
			},
		})
		const d = await net.device({ name: 'alice-laptop', token: 'alice' })
		net.intercept.set('alice-laptop', (m) => {
			if (m.type === 'operation-rejected') rejected.push(m.code)
			return true
		})

		const rec = await d.collection('todos').insert({ title: 'mine', owner: 'alice' })
		const second = await d.collection('todos').insert({ title: 'still mine', owner: 'alice' })
		await settle([d])
		await d.disconnect()
		expect(net.store.getAllOperations()).toHaveLength(2)

		// A server route transfers the first record to Bob (Alice keeps her copy: retain).
		const moved = await net.server
			.getKoraContext()
			.apply({ collection: 'todos', type: 'update', recordId: rec.id, data: { owner: 'bob' } })
		expect(moved.ok).toBe(true)

		// Simulate the upgrade: no acknowledged prefix recorded, so the device re-uploads
		// its whole history once on the next connection.
		const adapter = (d as unknown as { adapter: StorageAdapter }).adapter
		await adapter.execute("DELETE FROM _kora_meta WHERE key = 'own_acked_through'")
		validatorCalls = 0

		await d.reconnect()
		await settle([d])

		expect(rejected).toEqual([])
		expect(await d.getRejectedOperations()).toEqual([])
		expect(validatorCalls).toBe(0)
		// Nothing new stored; the server's state is unchanged.
		expect(net.store.getAllOperations()).toHaveLength(3)
		expect(await net.store.findRecord('todos', rec.id)).toMatchObject({ owner: 'bob' })
		// The device keeps its data, and its upload prefix covers the re-uploaded history.
		expect(await d.collection('todos').findById(rec.id)).toMatchObject({ title: 'mine' })
		expect(await d.collection('todos').findById(second.id)).toMatchObject({ title: 'still mine' })
		expect(d.getSyncEngine()?.getStatus().pendingOperations ?? 0).toBe(0)
	})
})
