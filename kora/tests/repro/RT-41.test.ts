/**
 * RT-41 repro (Phase 2 red team, 2026-10-02): `app.storage.deleteDatabase()` decides
 * "unsynced" from the persisted outbound queue only (`hasUnsyncedOperations` counts
 * `_kora_sync_queue` rows when sync is configured). Since W3 the engine's source of
 * truth is the contiguous acknowledged prefix (`own_acked_through`): every own
 * operation above it is unsynced whether or not it was ever read into the queue. Own
 * operations that are not queued but not acknowledged exist in normal operation:
 *
 * - a device upgraded from beta.12 has no prefix yet; its whole history is pending
 *   the one-time re-upload (which RT-39 stretches over hours), queue empty;
 * - `pushOperation` is not awaited: an op committed just before the tab died is in
 *   the log but not the queue (the next start finds it by scanning above the prefix);
 * - a closed per-tab-isolation tab's writes (RT-40).
 *
 * In each case deleteDatabase (without `force`) deletes writes the server never got.
 *
 * Asserts the CORRECT behaviour (fails today).
 */
import { defineSchema, t } from '@korajs/core'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { hasUnsyncedOperations } from '../../src/storage-accessor'
import { StoreQueueStorage } from '../../src/store-queue-storage'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

let store: Store | null = null
afterEach(async () => {
	await store?.close()
	store = null
})

describe('RT-41: deleteDatabase unsynced check ignores the acknowledged prefix', () => {
	test('own ops above own_acked_through count as unsynced even when the queue is empty', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema, adapter })
		await store.open()
		// The outbound queue table exists (sync is configured) and is empty.
		await new StoreQueueStorage(adapter).load()
		await store.collection('todos').insert({ title: 'acknowledged' })
		await store.collection('todos').insert({ title: 'never reached the server' })
		// The server acknowledged only the first op; the second never got queued.
		await store.saveOwnAckedThrough(store.getNodeId(), 1)

		expect(await hasUnsyncedOperations(adapter, true)).toBe(true)
	})
})
