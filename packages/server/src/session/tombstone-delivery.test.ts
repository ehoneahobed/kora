import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { OperationBatchMessage, SyncMessage } from '@korajs/sync'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { describe, expect, test, vi } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { replayScopeSnapshots } from '../store/scope-snapshot'
import type { ServerStore } from '../store/server-store'
import { SqliteServerStore } from '../store/sqlite-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'
import type { AuthProvider } from '../types'
import { ClientSession } from './client-session'

/**
 * An operation after which the record is deleted (a delete, or a stale write that lands
 * on the tombstone) is delivered by what the session's view held of the record, never
 * by the operation's own values: a delete reaches every view that held a live version,
 * and a stale write reaches no view as a live record.
 */

const schema = defineSchema({
	version: 1,
	collections: { lessons: { fields: { title: t.string(), school: t.string() } } },
})

let sequence = 0
function op(
	id: string,
	type: Operation['type'],
	wallTime: number,
	data: Record<string, unknown> | null,
	nodeId = 'node-a',
): Operation {
	sequence += 1
	return {
		id,
		nodeId,
		type,
		collection: 'lessons',
		recordId: 'r',
		data,
		previousData: null,
		timestamp: { wallTime, logical: 0, nodeId },
		sequenceNumber: sequence,
		causalDeps: [],
		schemaVersion: 1,
	}
}

/**
 * r is inserted in school-0 and moved to school-1; the server deletes it (t=4000); a
 * device that was offline then uploads an older write (t=3500) moving it to school-0.
 */
function history(): Operation[] {
	return [
		op('ins', 'insert', 1000, { title: 'r', school: 'school-0' }),
		op('move', 'update', 2000, { school: 'school-1' }),
		op('del', 'delete', 4000, null),
		op('stale', 'update', 3500, { school: 'school-0' }, 'node-b'),
	]
}

const stores: Array<[string, () => ServerStore]> = [
	['memory', () => new MemoryServerStore('s')],
	['sqlite', () => new SqliteServerStore(drizzle(new Database(':memory:')), 's')],
]

async function seeded(make: () => ServerStore): Promise<ServerStore> {
	const store = make()
	await store.setSchema(schema)
	for (const operation of history()) await store.applyRemoteOperation(operation)
	return store
}

async function stream(store: ServerStore, school: string): Promise<string[]> {
	const auth: AuthProvider = {
		authenticate: async () => ({ userId: school, scopes: { lessons: { school } } }),
	}
	const { client, server } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((message) => messages.push(message))
	const session = new ClientSession({ sessionId: school, transport: server, store, auth })
	session.start()
	client.send({
		type: 'handshake',
		messageId: 'hs',
		nodeId: `device-${school}`,
		versionVector: {},
		schemaVersion: 1,
		authToken: 'token',
		lastDeliverySequence: 0,
	})
	const batches = (): OperationBatchMessage[] =>
		messages.filter((m): m is OperationBatchMessage => m.type === 'operation-batch')
	await vi.waitFor(() => expect(batches().some((batch) => batch.isFinal)).toBe(true))
	return batches().flatMap((batch) => batch.operations.map((sent) => sent.id))
}

describe.each(stores)('tombstone delivery (%s store)', (_name, make) => {
	test('snapshots record whether the record is deleted after each operation', async () => {
		const store = await seeded(make)
		const snapshots = await store.getOperationScopeSnapshots?.(['ins', 'move', 'del', 'stale'])
		expect(snapshots?.get('ins')?.deleted).toBe(false)
		expect(snapshots?.get('move')?.deleted).toBe(false)
		expect(snapshots?.get('del')?.deleted).toBe(true)
		// The stale write is older than the delete: the record stays deleted, although the
		// write's own values (school-0) are recorded as the post-image.
		expect(snapshots?.get('stale')).toMatchObject({ deleted: true, pre: null })
		expect(snapshots?.get('stale')?.post?.school).toBe('school-0')
		const deliveries = await store.getRecordDeliveries?.('lessons', 'r')
		expect(deliveries?.map((d) => d.operation.id)).toEqual(['ins', 'move', 'del', 'stale'])
		expect(deliveries?.map((d) => d.scopeSnapshot?.deleted)).toEqual([false, false, true, true])
		await store.close()
	})

	test('a view that held the record gets the delete, before the stale write', async () => {
		const store = await seeded(make)
		// school-0 held the inserted version; the delete is judged on school-1 values, and
		// the stale write is in school-0: the delete precedes it.
		expect(await stream(store, 'school-0')).toEqual(['ins', 'del', 'del', 'stale'])
		await store.close()
	})

	test('the view the record was deleted in gets the delete, not the stale write', async () => {
		const store = await seeded(make)
		const sent = await stream(store, 'school-1')
		// The move into school-1 is sent (after its scope entry, RT-19).
		expect(sent).toContain('move')
		expect(sent.slice(-2)).toEqual(['del', 'del'])
		expect(sent).not.toContain('stale')
		await store.close()
	})

	test('a view that never held the record gets nothing', async () => {
		const store = await seeded(make)
		expect(await stream(store, 'school-2')).toEqual([])
		await store.close()
	})
})

test('a replayed snapshot records the tombstone state like the live one', () => {
	const replayed = replayScopeSnapshots(schema, 'lessons', 'r', history(), {})
	expect([...replayed.values()].map((snapshot) => snapshot.deleted)).toEqual([
		false,
		false,
		true,
		true,
	])
})
