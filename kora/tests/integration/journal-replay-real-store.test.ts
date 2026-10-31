/**
 * Replaying several journal entries for one record against a real store: the pass must not
 * mistake the operations an earlier entry of the same pass just wrote for later edits.
 */
import 'fake-indexeddb/auto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PreReadyWriteQueue, type WriteTarget } from '../../src/pre-ready-writes'
import { type JournalEntry, openWriteJournal } from '../../src/write-journal'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), done: t.boolean().default(false) } } },
})

let dir = ''
let counter = 0
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'kora-replay-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function replay(
	entries: (id: string, t0: number) => Array<Partial<JournalEntry>>,
	prepare?: (store: Store, id: string, t0: number) => Promise<void>,
): Promise<{ store: Store; id: string }> {
	const name = `real-${++counter}`
	const store = new Store({
		schema,
		adapter: new BetterSqlite3Adapter(join(dir, `${name}.db`)),
		nodeId: 'dev',
	})
	await store.open()
	const rec = (await store.collection('todos').insert({ title: 'orig' })) as { id: string }
	await new Promise((resolve) => setTimeout(resolve, 20))
	const t0 = Date.now()
	await prepare?.(store, rec.id, t0)
	const journal = openWriteJournal(name)
	if (!journal) throw new Error('IndexedDB expected')
	let n = 0
	for (const entry of entries(rec.id, t0)) {
		await journal.append({
			opKey: `${name}-${++n}`,
			session: 'old',
			owner: null,
			at: t0 + n * 10,
			writtenAt: t0 + n * 10,
			collection: 'todos',
			kind: 'update',
			args: [],
			...entry,
		} as JournalEntry)
	}
	// The tab was closed; real time passes before the next start.
	await new Promise((resolve) => setTimeout(resolve, 100))
	const queue = new PreReadyWriteQueue({
		dbName: name,
		locks: null,
		journal,
		session: 'new',
		now: () => Date.now() + 10 * 60_000,
	})
	await queue.apply(store as unknown as WriteTarget)
	await queue.settled()
	return { store, id: rec.id }
}

describe('journal replay against a real store', () => {
	it('title A then title B ends as B', async () => {
		const { store, id } = await replay((rid) => [
			{ args: [rid, { title: 'A' }] },
			{ args: [rid, { title: 'B' }] },
		])
		expect((await store.collection('todos').findById(id))?.title).toBe('B')
		await store.close()
	})

	it('update then delete leaves the record deleted', async () => {
		const { store, id } = await replay((rid) => [
			{ args: [rid, { title: 'A' }] },
			{ kind: 'delete', args: [rid] },
		])
		expect(await store.collection('todos').findById(id)).toBeNull()
		await store.close()
	})

	it('toggling twice ends as the last toggle', async () => {
		const { store, id } = await replay((rid) => [
			{ args: [rid, { done: true }] },
			{ args: [rid, { done: false }] },
		])
		expect((await store.collection('todos').findById(id))?.done).toBe(false)
		await store.close()
	})

	it('insert, update, delete of a new record ends deleted', async () => {
		const { store } = await replay((_rid) => [
			{ kind: 'insert', recordId: 'new-1', args: [{ title: 'n' }] },
			{ args: ['new-1', { title: 'n2' }] },
			{ kind: 'delete', args: ['new-1'] },
		])
		expect(await store.collection('todos').findById('new-1')).toBeNull()
		await store.close()
	})
})
