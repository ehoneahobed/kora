/**
 * Writes made before the store opened that wait for their owner follow the held-writes
 * contract: `status.heldOperations` / `heldNodes`, `app.sync.assignHeld`, `app.sync.discardHeld`,
 * and the pending count while they sit in memory. The three framework status hooks read the
 * status through `createSyncStatusController` over `app.sync.subscribeStatus`, so the test
 * reads it the same way.
 */
import 'fake-indexeddb/auto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type KoraEvent, defineSchema, t } from '@korajs/core'
import { runAllowingPreReadyWrites } from '@korajs/core/lite'
import { type SyncStatusInfo, createSyncStatusController } from '@korajs/sync'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'
import { openWriteJournal } from '../../src/write-journal'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

let dir = ''
let app: KoraApp | null = null
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'kora-held-'))
})
afterEach(async () => {
	await app?.close()
	app = null
	rmSync(dir, { recursive: true, force: true })
})

async function seed(dbName: string, entries: Array<Record<string, unknown>>): Promise<void> {
	const journal = openWriteJournal(dbName)
	if (!journal) throw new Error('IndexedDB expected')
	let n = 0
	for (const entry of entries) {
		await journal.append({
			opKey: `k-${dbName}-${++n}`,
			session: 'closed-tab',
			owner: null,
			at: Date.now() - 10 * 60 * 1000,
			collection: 'todos',
			kind: 'insert',
			args: [{ title: `seeded ${n}` }],
			recordId: `rec-${n}`,
			writtenAt: Date.now() - 10 * 60 * 1000,
			...entry,
		} as never)
	}
	journal.close()
}

function open(name: string, namespaced: boolean): KoraApp {
	return createApp({
		schema,
		store: {
			adapter: 'better-sqlite3',
			name,
			...(namespaced ? { namespaceByAuthUser: true } : {}),
		},
		sync: {
			url: 'wss://localhost:9999',
			authClient: {
				auth: async () => ({ token: 't' }),
				resolveUserId: async () => 'bob',
			},
		},
	})
}

describe('held journal writes through the held-writes contract', () => {
	test('pending count while queued, held nodes after open, assign and discard', async () => {
		const name = join(dir, 'held.db')
		await seed(name, [{ owner: null, ownerPending: true }, { owner: 'alice' }, { owner: 'alice' }])
		const events: KoraEvent[] = []
		app = open(name, true)
		app.events.on('journal:discarded', (event) => events.push(event))
		const sync = app.sync
		if (!sync) throw new Error('sync expected')

		// The status the hooks read, through their shared controller.
		const controller = createSyncStatusController({
			syncEngine: null,
			subscribeSyncStatus: sync.subscribeStatus,
			events: null,
		})
		const seen: SyncStatusInfo[] = []
		controller.subscribe(() => seen.push(controller.getSnapshot()))

		// A write made before the store opened is visible as pending while it waits in memory.
		// (A hook opens this scope for its mutation; the test does the same.)
		const insert = runAllowingPreReadyWrites(() =>
			(app as unknown as { todos: { insert: (d: object) => Promise<unknown> } }).todos.insert({
				title: 'early',
			}),
		)
		expect(sync.status.pendingOperations).toBe(1)
		await insert
		await app.ready

		const status = sync.status
		// Now a real operation waiting to upload: counted once, not twice.
		expect(status.pendingOperations).toBe(1)
		expect(status.heldOperations).toBe(3)
		const unassigned = status.heldNodes?.find((node) => node.nodeId === 'journal:unassigned')
		expect(unassigned).toMatchObject({
			reason: 'unassigned',
			principal: null,
			operationCount: 1,
			source: 'journal',
		})
		expect(unassigned?.writes?.[0]).toMatchObject({
			collection: 'todos',
			kind: 'insert',
			owner: null,
		})
		expect(typeof unassigned?.writes?.[0]?.writtenAt).toBe('number')
		expect(
			status.heldNodes?.find((node) => node.nodeId === 'journal:other-user:alice'),
		).toMatchObject({
			reason: 'other-user',
			principal: 'alice',
			operationCount: 2,
		})
		// The hooks' controller saw it, and an unchanged status keeps its identity.
		expect(controller.getSnapshot().heldOperations).toBe(3)
		expect(seen.length).toBeGreaterThan(0)
		expect(controller.getSnapshot()).toBe(controller.getSnapshot())
		expect((await sync.getHeldOperations()).map((node) => node.nodeId).sort()).toEqual([
			'journal:other-user:alice',
			'journal:unassigned',
		])

		// assignHeld applies the unattributed write into the signed-in user's database.
		await sync.assignHeld('journal:unassigned', 'current-user')
		const todos = (
			app as unknown as {
				todos: { where: (w: object) => { exec: () => Promise<Array<{ title: string }>> } }
			}
		).todos
		const titles = (await todos.where({}).exec()).map((todo) => todo.title).sort()
		expect(titles).toEqual(['early', 'seeded 1'])
		expect(sync.status.heldOperations).toBe(2)
		// Another user's writes cannot be assigned.
		await expect(sync.assignHeld('journal:other-user:alice', 'current-user')).rejects.toMatchObject(
			{
				context: { code: 'HELD_NODE_NOT_ASSIGNABLE' },
			},
		)

		// discardHeld removes them and announces the count.
		expect(await sync.discardHeld('journal:other-user:alice')).toBe(2)
		expect(sync.status.heldOperations).toBe(0)
		expect(sync.status.heldNodes).toEqual([])
		expect(events).toContainEqual(expect.objectContaining({ type: 'journal:discarded', count: 2 }))
		expect(controller.getSnapshot().heldOperations).toBe(0)
		controller.destroy()
	})
})
