/**
 * RT-19 repro (red team round 3, 2026-10-02): a record moving INTO a scope never
 * appears for its new owner.
 *
 * Since RT-14, download visibility of an operation is judged on the record's scope
 * values right after that operation (`snapshot.post`), so only the scope-changing
 * update is delivered to the new owner, never the record's earlier operations. The
 * client drops an update for a record it does not have, so the record never
 * materializes (also SRV-2 / NEW-SRV-3).
 *
 * Asserts the CORRECT behaviour (fails before the fix): the new owner's live and
 * fresh devices receive the complete current record (a server-built scope-entry
 * operation) and can edit it, without receiving the pre-transfer history (RT-14);
 * the previous owner's devices see a retraction (retract mode) or keep a stale copy
 * (retain mode, documented).
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

describe('RT-19: a record moving into scope reaches its new owner', () => {
	test('live and fresh devices of the new owner get the complete record and can edit it', async () => {
		net = await scopedNetwork(schema, { auth })
		const alice = await net.device({ name: 'alice-laptop', token: 'alice' })
		const alicePhone = await net.device({
			name: 'alice-phone',
			token: 'alice',
			scopeExit: 'retract',
		})
		const bob = await net.device({ name: 'bob-laptop', token: 'bob' })

		const rec = await alice
			.collection('todos')
			.insert({ title: 'plan', body: 'draft: budget 90k', owner: 'alice' })
		await settle([alice])
		await alice.collection('todos').update(rec.id, { body: 'handover notes' })
		await settle([alice, alicePhone, bob])
		expect((await alicePhone.collection('todos').findById(rec.id))?.body).toBe('handover notes')
		expect(await bob.collection('todos').findById(rec.id)).toBeNull()

		// A trusted server route transfers the record to Bob while Bob is streaming.
		const transfer = await net.server
			.getKoraContext()
			.apply({ collection: 'todos', type: 'update', recordId: rec.id, data: { owner: 'bob' } })
		expect(transfer.ok).toBe(true)
		await settle([bob, alicePhone, alice])

		const live = await bob.collection('todos').findById(rec.id)
		expect(live).toMatchObject({ title: 'plan', body: 'handover notes', owner: 'bob' })

		// A device Bob signs in on afterwards gets it from the initial stream.
		const bobFresh = await net.device({ name: 'bob-tablet', token: 'bob' })
		await settle([bobFresh])
		expect(await bobFresh.collection('todos').findById(rec.id)).toMatchObject({
			title: 'plan',
			body: 'handover notes',
			owner: 'bob',
		})

		// Bob can edit the record, and the edit converges to his other device.
		await bob.collection('todos').update(rec.id, { title: 'plan B' })
		await settle([bob, bobFresh])
		expect(await bob.getRejectedOperations()).toEqual([])
		expect((await net.store.findRecord('todos', rec.id))?.title).toBe('plan B')
		expect((await bobFresh.collection('todos').findById(rec.id))?.title).toBe('plan B')

		// The previous owner: retract mode hides the record; retain mode (the default)
		// keeps the stale copy it already had, as documented.
		expect(await alicePhone.collection('todos').findById(rec.id)).toBeNull()
		expect((await alice.collection('todos').findById(rec.id))?.owner).toBe('alice')
	}, 60_000)

	test('later edits of an entered record are not left as orphans (NEW-SRV-3)', async () => {
		net = await scopedNetwork(schema, { auth })
		const alice = await net.device({ name: 'alice-laptop', token: 'alice' })
		const bob = await net.device({ name: 'bob-laptop', token: 'bob' })
		const rec = await alice.collection('todos').insert({ title: 't', body: 'b', owner: 'alice' })
		await settle([alice, bob])
		const kora = net.server.getKoraContext()
		expect(
			(
				await kora.apply({
					collection: 'todos',
					type: 'update',
					recordId: rec.id,
					data: { owner: 'bob' },
				})
			).ok,
		).toBe(true)
		expect(
			(
				await kora.apply({
					collection: 'todos',
					type: 'update',
					recordId: rec.id,
					data: { body: 'b2' },
				})
			).ok,
		).toBe(true)
		await settle([bob])
		expect(await bob.collection('todos').findById(rec.id)).toMatchObject({
			title: 't',
			body: 'b2',
			owner: 'bob',
		})
	}, 60_000)
})
