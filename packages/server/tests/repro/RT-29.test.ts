/**
 * RT-29 repro, server half (W7 Stage B2): a scope-entry operation restates a record's
 * current values with one HLC per field (RT-27), and a receiver resolves each field by
 * last-write-wins against its own version of it. That is wrong for every field that is
 * not a plain register: a counter, a richtext document or a resolver field the
 * receiver also wrote concurrently has to MERGE, not pick a side.
 *
 * The fix: the entry carries the record's serialized fold state (filtered to the fields
 * it restates). A receiver that joins that state with its own reaches exactly the
 * server's value, whatever it already held. This file checks the server half: the
 * entry the server builds carries the state, and joining it with a receiver's own
 * concurrent writes gives the fold of the union (what the server holds once those
 * writes upload).
 *
 * Asserts the CORRECT behaviour (fails before the fix: no `foldState` on the entry).
 */
import {
	defineSchema,
	deserializeFoldState,
	foldRecord,
	joinStates,
	materialize,
	t,
} from '@korajs/core'
import type { Operation } from '@korajs/core'
import { stringToRichtextUpdate } from '@korajs/merge'
import { describe, expect, test } from 'vitest'
import { buildScopeEntryOperation } from '../../src/session/scope-entry'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { mergeRichtextUpdatesForServer } from '../../src/store/record-fold'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'

const schema = defineSchema({
	version: 1,
	collections: {
		posts: {
			fields: {
				owner: t.string(),
				likes: t.number().merge('counter'),
				body: t.richtext().optional(),
				total: t.number().default(0),
			},
			resolve: {
				total: (local, remote, base) => {
					const l = typeof local === 'number' ? local : 0
					const r = typeof remote === 'number' ? remote : 0
					const b = typeof base === 'number' ? base : 0
					return l + (r - b)
				},
			},
		},
	},
})

let seq = 0
function op(node: string, wall: number, partial: Partial<Operation>): Operation {
	seq += 1
	return {
		id: `${node}-${wall}-${seq}`,
		nodeId: node,
		type: 'update',
		collection: 'posts',
		recordId: 'p1',
		data: {},
		previousData: null,
		timestamp: { wallTime: wall, logical: 0, nodeId: node },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	}
}

function bytes(text: string): { $koraBytes: string } {
	return { $koraBytes: Buffer.from(stringToRichtextUpdate(text)).toString('base64') }
}

const stores = {
	memory: async () => new MemoryServerStore('srv'),
	sqlite: async () => createSqliteServerStore({ nodeId: 'srv' }),
}

for (const [name, make] of Object.entries(stores)) {
	describe(`RT-29 (${name}): scope entry carries the fold state`, () => {
		test('a receiver joining the entry state with its own concurrent writes reaches the union fold', async () => {
			const store = await make()
			await store.setSchema(schema)
			const insert = op('alice', 1000, {
				type: 'insert',
				data: { owner: 'alice', likes: 0, body: bytes('hello'), total: 10 },
			})
			// Server-side history the receiver (bob) never saw while out of scope.
			const aliceLikes = op('alice', 2000, { data: { likes: 3 }, previousData: { likes: 0 } })
			const aliceTotal = op('alice', 2100, { data: { total: 15 }, previousData: { total: 10 } })
			const aliceBody = op('alice', 2200, {
				data: { body: bytes('alice edit') },
				previousData: { body: bytes('hello') },
			})
			const transfer = op('alice', 3000, {
				data: { owner: 'bob' },
				previousData: { owner: 'alice' },
			})
			// Bob's concurrent offline writes (from the same base), newer than every
			// server field version, not yet uploaded.
			const bobLikes = op('bob', 5000, { data: { likes: 2 }, previousData: { likes: 0 } })
			const bobTotal = op('bob', 5100, { data: { total: 13 }, previousData: { total: 10 } })
			const bobBody = op('bob', 5200, {
				data: { body: bytes('bob edit') },
				previousData: { body: bytes('hello') },
			})
			for (const o of [insert, aliceLikes, aliceTotal, aliceBody, transfer]) {
				expect(await store.applyRemoteOperation(o)).toBe('applied')
			}

			const row = await store.findRecord('posts', 'p1')
			expect(row).not.toBeNull()
			const entry = await buildScopeEntryOperation({
				trigger: transfer,
				row: row as NonNullable<typeof row>,
				schema,
				timestamp: transfer.timestamp,
				fieldVersions: await store.getRecordFieldVersions?.('posts', 'p1'),
				foldState: await store.getRecordFoldState?.('posts', 'p1'),
				schemaVersion: 1,
			})
			expect(typeof entry.foldState).toBe('string')

			// The receiver: bob's own writes (he also holds the insert he synced earlier).
			const local = foldRecord([insert, bobLikes, bobTotal, bobBody], schema).state
			expect(local).not.toBeNull()
			const joined = joinStates(
				deserializeFoldState(entry.foldState as string),
				local as NonNullable<typeof local>,
				schema,
			)
			const receiver = materialize(joined, { richtext: mergeRichtextUpdatesForServer })

			// Truth: the server once bob uploads.
			for (const o of [bobLikes, bobTotal, bobBody]) await store.applyRemoteOperation(o)
			const truth = await store.getRecordFoldState?.('posts', 'p1')
			const server = materialize(truth as NonNullable<typeof truth>, {
				richtext: mergeRichtextUpdatesForServer,
			})

			// Counter: base 0 + 3 + 2. LWW on field versions would give 2 (or 3).
			expect(receiver?.likes).toBe(5)
			// Resolver in HLC order: 10 -> 15 -> 15 + (13 - 10) = 18.
			expect(receiver?.total).toBe(18)
			expect(receiver).toEqual(server)
			await store.close()
		})

		test('the entry state holds only the fields the entry restates', async () => {
			const store = await make()
			await store.setSchema(schema)
			const insert = op('alice', 1000, {
				type: 'insert',
				data: { owner: 'alice', likes: 1, total: 1 },
			})
			await store.applyRemoteOperation(insert)
			const row = await store.findRecord('posts', 'p1')
			const visible = { id: 'p1', owner: row?.owner, likes: row?.likes }
			const entry = await buildScopeEntryOperation({
				trigger: insert,
				row: visible,
				schema,
				timestamp: insert.timestamp,
				foldState: await store.getRecordFoldState?.('posts', 'p1'),
				schemaVersion: 1,
			})
			const state = deserializeFoldState(entry.foldState as string)
			expect(Object.keys(state.f).sort()).toEqual(['likes', 'owner'])
			// Per-field versions are derived from the fold state for older clients.
			expect(Object.keys(entry.fieldVersions ?? {}).sort()).toEqual(['likes', 'owner'])
			await store.close()
		})
	})
}
