import 'fake-indexeddb/auto'
import { op } from '@korajs/core'
import { runWithWriteObserver } from '@korajs/core/lite'
import type { WriteObserver } from '@korajs/core/lite'
import { describe, expect, it, vi } from 'vitest'
import { type LockManagerLike, PreReadyWriteQueue, type WriteTarget } from './pre-ready-writes'
import { type JournalEntry, type WriteJournal, openWriteJournal } from './write-journal'

let counter = 0
const freshDb = (): string => `queue-test-${++counter}`

function recordingStore(): { store: WriteTarget; calls: string[] } {
	const calls: string[] = []
	const store: WriteTarget = {
		collection: (name) => ({
			insert: async (data) => {
				calls.push(`${name}.insert:${JSON.stringify(data)}`)
				return { id: 'new', ...data }
			},
			insertMany: async (rows) => {
				calls.push(`${name}.insertMany:${rows.length}`)
				return []
			},
			update: async (id, data) => {
				calls.push(`${name}.update:${id}:${JSON.stringify(data)}`)
				return { id, ...data }
			},
			delete: async (id) => {
				calls.push(`${name}.delete:${id}`)
			},
		}),
	}
	return { store, calls }
}

function journalFor(db: string): WriteJournal {
	const journal = openWriteJournal(db)
	if (!journal) throw new Error('IndexedDB should be available in this test')
	return journal
}

describe('PreReadyWriteQueue', () => {
	it('applies queued writes in call order once the store opens, and resolves each', async () => {
		const db = freshDb()
		const queue = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'a' })
		const first = queue.enqueue('todos', 'insert', [{ title: 'one' }])
		const second = queue.enqueue('todos', 'update', ['x', { title: 'two' }])
		expect(queue.size).toBe(2)
		const { store, calls } = recordingStore()
		await queue.apply(store)
		expect(await first).toMatchObject({ title: 'one' })
		expect(await second).toMatchObject({ id: 'x' })
		expect(calls).toEqual(['todos.insert:{"title":"one"}', 'todos.update:x:{"title":"two"}'])
		expect(queue.size).toBe(0)
	})

	it('passes writes straight through after the store opened', async () => {
		const queue = new PreReadyWriteQueue({ dbName: freshDb(), locks: null, journal: null })
		const { store, calls } = recordingStore()
		await queue.apply(store)
		await queue.enqueue('todos', 'delete', ['gone'])
		expect(calls).toEqual(['todos.delete:gone'])
	})

	it('saves a write to the journal before the store opens and forgets it once applied', async () => {
		const db = freshDb()
		const queue = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'a' })
		const pending = queue.enqueue('todos', 'insert', [{ title: 'kept' }])
		const probe = journalFor(db)
		await vi.waitFor(async () => expect(await probe.list()).toHaveLength(1))
		await queue.apply(recordingStore().store)
		await pending
		expect(await probe.list()).toEqual([])
		probe.close()
	})

	it('applies what a closed tab left behind (tab-close recovery)', async () => {
		const db = freshDb()
		// The first page queues a write and is closed before the store opens: no apply().
		const closed = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'closed',
			now: () => 0,
		})
		void closed.enqueue('todos', 'insert', [{ title: 'survivor' }])
		const probe = journalFor(db)
		await vi.waitFor(async () => expect(await probe.list()).toHaveLength(1))

		const next = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'next',
			now: () => 10 * 60 * 1000,
		})
		const { store, calls } = recordingStore()
		await next.apply(store)
		expect(calls).toEqual(['todos.insert:{"title":"survivor"}'])
		expect(await probe.list()).toEqual([])
		probe.close()
	})

	it('leaves a recent entry of another session alone when locks cannot tell (it may be live)', async () => {
		const db = freshDb()
		const other = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'other',
			now: () => 1000,
		})
		void other.enqueue('todos', 'insert', [{ title: 'live' }])
		const probe = journalFor(db)
		await vi.waitFor(async () => expect(await probe.list()).toHaveLength(1))
		const mine = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			now: () => 2000,
		})
		const { store, calls } = recordingStore()
		await mine.apply(store)
		expect(calls).toEqual([])
		expect(await probe.list()).toHaveLength(1)
		probe.close()
	})

	it('uses Web Locks: an entry of a session that still holds its lock is left alone', async () => {
		const db = freshDb()
		const held = new Set<string>(['kora-journal-session:alive'])
		const locks: LockManagerLike = {
			request: async (name, _options, callback) => {
				if (name.startsWith('kora-journal-session:')) return new Promise<never>(() => {})
				return callback()
			},
			query: async () => ({ held: [...held].map((name) => ({ name })) }),
		}
		const probe = journalFor(db)
		const base: JournalEntry = {
			session: 'alive',
			owner: null,
			at: 0,
			collection: 'todos',
			kind: 'insert',
			args: [{ title: 'a' }],
		}
		await probe.append(base)
		await probe.append({ ...base, session: 'dead', args: [{ title: 'b' }] })
		const queue = new PreReadyWriteQueue({ dbName: db, locks, session: 'mine', now: () => 5 })
		const { store, calls } = recordingStore()
		await queue.apply(store)
		expect(calls).toEqual(['todos.insert:{"title":"b"}'])
		expect((await probe.list()).map((item) => item.session)).toEqual(['alive'])
		probe.close()
	})

	it('waits for another user to claim their entries, and applies the unowned ones', async () => {
		const db = freshDb()
		const probe = journalFor(db)
		const base: JournalEntry = {
			session: 'old',
			owner: null,
			at: 0,
			collection: 'todos',
			kind: 'insert',
			args: [{ title: 'anyone' }],
		}
		await probe.append(base)
		await probe.append({ ...base, owner: 'bob', args: [{ title: 'bobs' }] })
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			resolveOwner: async () => 'alice',
			now: () => 10 * 60 * 1000,
		})
		const { store, calls } = recordingStore()
		await queue.apply(store)
		expect(calls).toEqual(['todos.insert:{"title":"anyone"}'])
		expect((await probe.list()).map((item) => item.owner)).toEqual(['bob'])
		probe.close()
	})

	it('drops another user entry nobody claimed in 30 days, with a warning', async () => {
		const db = freshDb()
		const probe = journalFor(db)
		await probe.append({
			session: 'old',
			owner: 'bob',
			at: 0,
			collection: 'todos',
			kind: 'insert',
			args: [{ title: 'x' }],
		})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			resolveOwner: async () => 'alice',
			now: () => 31 * 24 * 60 * 60 * 1000,
		})
		await queue.apply(recordingStore().store)
		expect(await probe.list()).toEqual([])
		expect(warn).toHaveBeenCalled()
		warn.mockRestore()
		probe.close()
	})

	it('keeps a recovered write that cannot be applied, marked failed, and never retries it', async () => {
		const db = freshDb()
		const probe = journalFor(db)
		await probe.append({
			session: 'old',
			owner: null,
			at: 0,
			collection: 'gone',
			kind: 'insert',
			args: [{}],
		})
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			now: () => 10 * 60 * 1000,
		})
		const throwing: WriteTarget = {
			collection: () => {
				throw new Error('no such collection')
			},
		}
		await queue.apply(throwing)
		const [kept] = await probe.list()
		expect(kept?.failed).toContain('no such collection')
		const again = recordingStore()
		await new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'third',
			now: () => 20 * 60 * 1000,
		}).apply(again.store)
		expect(again.calls).toEqual([])
		error.mockRestore()
		probe.close()
	})

	it('does not journal writes that carry atomic helpers (they wait in memory only)', async () => {
		const db = freshDb()
		const journal = journalFor(db)
		const append = vi.spyOn(journal, 'append')
		const queue = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'a', journal })
		const plain = queue.enqueue('counters', 'update', ['c', { label: 'x' }])
		const atomic = queue.enqueue('counters', 'update', ['c', { n: op.increment(1) }])
		const { store, calls } = recordingStore()
		await queue.apply(store)
		await Promise.all([plain, atomic])
		// Only the plain write was saved; both were applied, in order.
		expect(append).toHaveBeenCalledTimes(1)
		expect(calls).toHaveLength(2)
		journal.close()
	})

	it('fails waiting writes and drops their journal entries when the store will not open', async () => {
		const db = freshDb()
		const queue = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'a' })
		const pending = queue.enqueue('todos', 'insert', [{ title: 'x' }])
		const rejected = expect(pending).rejects.toThrow('no store')
		const probe = journalFor(db)
		await vi.waitFor(async () => expect(await probe.list()).toHaveLength(1))
		await queue.fail(new Error('no store'))
		await rejected
		expect(await probe.list()).toEqual([])
		probe.close()
	})

	it('applies a queued write under the write observer that was current when it was made', async () => {
		const queue = new PreReadyWriteQueue({ dbName: freshDb(), locks: null, journal: null })
		const seen: Array<WriteObserver | null> = []
		const observer: WriteObserver = { onWrite: () => {} } as unknown as WriteObserver
		const pending = runWithWriteObserver(observer, () => queue.enqueue('todos', 'insert', [{}]))
		const { currentWriteObserver } = await import('@korajs/core/lite')
		const store: WriteTarget = {
			collection: () => ({
				insert: async () => {
					seen.push(currentWriteObserver())
					return {}
				},
				insertMany: async () => [],
				update: async () => ({}),
				delete: async () => {},
			}),
		}
		await queue.apply(store)
		await pending
		expect(seen).toEqual([observer])
	})
})
