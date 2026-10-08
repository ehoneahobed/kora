/**
 * A delivery pass reads the rows its visibility decisions need once per chunk. Those
 * rows are the pass's own: a decision another code path makes meanwhile (a Yjs doc
 * write's authorization, a presence audience) must read the store, never a row the
 * pass read before a later write moved the record.
 *
 * Runs on the memory store, or on Postgres with KORA_REPRO_STORE=postgres and
 * KORA_PG_TEST_URL set (see rt-fixture.ts).
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { createHarness, tick } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { spaceId: t.string(), body: t.richtext() } } },
})

const SPACES: Record<string, string[]> = {
	alice: ['user:alice', 'shared'],
	carol: ['user:carol', 'shared'],
}

const auth = new TokenAuthProvider({
	validate: async (token) => {
		const spaces = SPACES[token]
		if (!spaces) return null
		return { userId: token, scopes: { notes: { spaceId: { $in: spaces } } } }
	},
})

test('a Yjs doc write is authorized on the stored record, not on a row a held delivery pass read', async () => {
	const harness = await createHarness(schema, auth)
	const ctx = harness.server.getKoraContext()
	const inserted = await ctx.apply({
		collection: 'notes',
		type: 'insert',
		recordId: 'note-1',
		data: { spaceId: 'user:carol' },
	})
	expect(inserted.ok).toBe(true)
	const carol = await harness.login('carol', 'node-carol')
	const alice = await harness.login('alice', 'node-alice', {
		lastDeliverySequence: 0,
	} as Partial<SyncMessage>)

	// Alice's delivery pass treats note-1 moving into the shared space as a scope entry:
	// it reads the row (shared) and is held inside that decision.
	const held: { open: () => void } = { open: () => {} }
	const opened = new Promise<void>((resolve) => {
		held.open = resolve
	})
	const real = harness.store.getRecordFieldVersions.bind(harness.store)
	const versions = vi
		.spyOn(harness.store, 'getRecordFieldVersions')
		.mockImplementation(async (collection, recordId) => {
			if (recordId === 'note-1') await opened
			return real(collection, recordId)
		})
	try {
		const shared = await ctx.apply({
			collection: 'notes',
			type: 'update',
			recordId: 'note-1',
			data: { spaceId: 'shared' },
		})
		expect(shared.ok).toBe(true)
		await vi.waitFor(() => expect(versions).toHaveBeenCalled())

		// Carol takes the note back into her personal space: Alice may no longer write it.
		const taken = await ctx.apply({
			collection: 'notes',
			type: 'update',
			recordId: 'note-1',
			data: { spaceId: 'user:carol' },
		})
		expect(taken.ok).toBe(true)
		const carolMark = carol.messages.length
		alice.send({
			type: 'yjs-doc-update',
			messageId: 'y-after-move',
			collection: 'notes',
			recordId: 'note-1',
			field: 'body',
			update: 'AAAA',
		} as SyncMessage)
		await tick(100)
		expect(carol.messages.slice(carolMark).filter((m) => m.type === 'yjs-doc-update')).toEqual([])
	} finally {
		held.open()
		await tick()
		versions.mockRestore()
	}
})
