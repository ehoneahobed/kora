/**
 * A fresh device of a group's owner receives the group's edit history without a re-scope per
 * edit. Editing a group the user already owns leaves their membership as it was, so the
 * session must not refresh the grant, rebuild a scope unit or re-read the group at each of
 * the edits: with the database in another region, those per-operation reads made a first
 * download wait minutes (the production stall of 2026-11-08).
 *
 * The test counts the store reads a re-scope makes and requires them to stay flat as the
 * history grows, while every edit still reaches the device.
 */
import { defineSchema, member, owner, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { createHarness } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { forms: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: { fields: { userId: t.string(), group: t.string(), role: t.string() } },
		forms: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: { read: member('id'), create: owner('ownerId'), update: member('id', 'edit') },
		},
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) => (token === 'ann' ? { userId: 'ann' } : null),
})

const FRESH = { supportsScopeDisjunction: true, lastDeliverySequence: 0 } as Partial<SyncMessage>

async function freshDeviceReads(edits: number): Promise<{ reads: number; delivered: number }> {
	const h = await createHarness(schema, auth)
	const ctx = h.server.getKoraContext()
	await ctx.apply({
		collection: 'forms',
		type: 'insert',
		recordId: 'f1',
		data: { title: 't0', ownerId: 'ann' },
	})
	for (let i = 1; i <= edits; i++) {
		await ctx.apply({
			collection: 'forms',
			type: 'update',
			recordId: 'f1',
			data: { title: `t${i}` },
		})
	}
	const maxSeq = vi.spyOn(h.store, 'getMaxDeliverySequence')
	const queries = vi.spyOn(h.store, 'queryCollection')
	const client = await h.login('ann', 'device-2', FRESH)
	await h.settle()
	const delivered = client.messages
		.filter((m) => m.type === 'operation-batch')
		.flatMap((m) => (m as unknown as { operations: { collection: string }[] }).operations)
		.filter((op) => op.collection === 'forms').length
	return { reads: maxSeq.mock.calls.length + queries.mock.calls.length, delivered }
}

describe('delivering the edit history of a group the user owns', () => {
	test('reads do not grow with the number of edits', async () => {
		const small = await freshDeviceReads(5)
		const large = await freshDeviceReads(120)
		expect(small.delivered).toBeGreaterThanOrEqual(6)
		expect(large.delivered).toBeGreaterThanOrEqual(121)
		// A handful of reads for the session itself; never one per edit.
		expect(large.reads).toBeLessThanOrEqual(small.reads + 5)
	})
})
