/**
 * RT-20 repro (red team round 3, 2026-10-02): a schema change that adds a scope
 * field hides history from fresh devices.
 *
 * Scope snapshots (RT-14) are captured with the schema in force when an operation is
 * applied and only backfilled where missing. After a migration adds `orgId` and a
 * sync rule on it, every snapshot captured under v1 lacks `orgId`, so download
 * visibility fails closed for the record's whole history and a fresh device of the
 * org receives none of it.
 *
 * Asserts the CORRECT behaviour (fails before the fix): when the set of fields
 * snapshots capture changes, snapshots are recomputed from the log; and a snapshot
 * that lacks a scope field falls back to the record's current row, while a snapshot
 * that has the field and mismatches still fails closed.
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createHarness, makeOp } from './rt-fixture'

const v1 = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

const v2 = defineSchema({
	version: 2,
	collections: { todos: { fields: { title: t.string(), orgId: t.string().optional() } } },
	sync: { todos: { where: { orgId: 'orgId' } } },
})

const auth = new TokenAuthProvider({
	validate: async (token) => {
		const org = token.split('-')[0] ?? ''
		return { userId: `${org}-user`, scopes: { $claims: { orgId: org } } }
	},
})

function deliveredIds(messages: SyncMessage[]): string[] {
	return messages.flatMap((m) =>
		m.type === 'operation-batch' ? (m.operations as Operation[]).map((op) => op.id) : [],
	)
}

describe('RT-20: scope-field migration keeps history visible', () => {
	test('v1 -> v2 adds an orgId scope: a fresh device sees the full history', async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(v1)
		const insert = makeOp('legacy-node', 1, {
			collection: 'todos',
			recordId: 'todo-1',
			data: { title: 'first' },
			schemaVersion: 1,
		})
		const edit = makeOp('legacy-node', 2, {
			type: 'update',
			collection: 'todos',
			recordId: 'todo-1',
			data: { title: 'second' },
			previousData: { title: 'first' },
			causalDeps: [insert.id],
			schemaVersion: 1,
		})
		await store.applyRemoteOperation(insert)
		await store.applyRemoteOperation(edit)

		// The v2 migration: the new scope field is set on existing records.
		await store.setSchema(v2)
		const harness = await createHarness(v2, auth, {}, store)
		const migrate = await harness.server
			.getKoraContext()
			.apply({ collection: 'todos', type: 'update', recordId: 'todo-1', data: { orgId: 'acme' } })
		expect(migrate.ok).toBe(true)

		const fresh = await harness.login('acme-token', 'acme-node', {
			lastDeliverySequence: 0,
			schemaVersion: 2,
		} as Partial<SyncMessage>)
		const ids = deliveredIds(fresh.messages)
		expect(ids).toContain(insert.id)
		expect(ids).toContain(edit.id)

		// Another org still sees nothing of it.
		const other = await harness.login('beta-token', 'beta-node', {
			lastDeliverySequence: 0,
			schemaVersion: 2,
		} as Partial<SyncMessage>)
		expect(deliveredIds(other.messages)).not.toContain(insert.id)
		expect(deliveredIds(other.messages)).not.toContain(edit.id)
	})

	test('snapshots are recomputed when the captured fields change (history judged per op)', async () => {
		// Clients ahead of the server already wrote orgId before the server schema had it.
		const store = new MemoryServerStore('server-1')
		await store.setSchema(v1)
		const insert = makeOp('client-node', 1, {
			collection: 'todos',
			recordId: 'todo-1',
			data: { title: 'acme plan', orgId: 'acme' },
		})
		const moved = makeOp('client-node', 2, {
			type: 'update',
			collection: 'todos',
			recordId: 'todo-1',
			data: { orgId: 'beta' },
			previousData: { orgId: 'acme' },
			causalDeps: [insert.id],
		})
		await store.applyRemoteOperation(insert)
		await store.applyRemoteOperation(moved)
		await store.setSchema(v2)

		const snapshots = await store.getOperationScopeSnapshots([insert.id, moved.id])
		expect(snapshots.get(insert.id)?.post?.orgId).toBe('acme')
		expect(snapshots.get(moved.id)?.post?.orgId).toBe('beta')

		// Acme's history stays with acme; beta does not receive acme's pre-move insert.
		const harness = await createHarness(v2, auth, {}, store)
		const acme = await harness.login('acme-token', 'acme-node', {
			lastDeliverySequence: 0,
			schemaVersion: 2,
		} as Partial<SyncMessage>)
		expect(deliveredIds(acme.messages)).toContain(insert.id)
		const beta = await harness.login('beta-token', 'beta-node', {
			lastDeliverySequence: 0,
			schemaVersion: 2,
		} as Partial<SyncMessage>)
		expect(deliveredIds(beta.messages)).not.toContain(insert.id)
	})
})
