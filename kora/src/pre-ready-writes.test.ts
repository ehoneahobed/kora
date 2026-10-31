import 'fake-indexeddb/auto'
import { op } from '@korajs/core'
import { runWithWriteObserver } from '@korajs/core/lite'
import type { WriteObserver } from '@korajs/core/lite'
import type { WriteOptions } from '@korajs/store'
import { describe, expect, it, vi } from 'vitest'
import { type LockManagerLike, PreReadyWriteQueue, type WriteTarget } from './pre-ready-writes'
import { type JournalEntry, type WriteJournal, openWriteJournal } from './write-journal'

let counter = 0
const freshDb = (): string => `queue-test-${++counter}`

function recordingStore(existing: Iterable<string> = []): {
	store: WriteTarget
	calls: string[]
	options: Array<WriteOptions | undefined>
} {
	const calls: string[] = []
	const options: Array<WriteOptions | undefined> = []
	const have = new Set(existing)
	const store: WriteTarget = {
		collection: (name) => ({
			findById: async (id) => (have.has(id) ? { id } : null),
			insert: async (data, opts) => {
				calls.push(`${name}.insert:${JSON.stringify(data)}`)
				options.push(opts)
				if (opts?.recordId) have.add(opts.recordId)
				return { id: opts?.recordId ?? 'new', ...data }
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
	return { store, calls, options }
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
		await queue.settled()
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
				return callback({})
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

	it('holds entries of another user, and entries made before anyone was known, when a user is signed in', async () => {
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
		await probe.append({ ...base, owner: 'alice', args: [{ title: 'alices' }] })
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			resolveOwner: async () => 'alice',
			now: () => 10 * 60 * 1000,
		})
		const { store, calls } = recordingStore()
		await queue.apply(store)
		expect(calls).toEqual(['todos.insert:{"title":"alices"}'])
		expect((await probe.list()).map((item) => item.owner)).toEqual([null, 'bob'])
		probe.close()
	})

	it('applies unowned entries in an app with no sign-in', async () => {
		const db = freshDb()
		const probe = journalFor(db)
		await probe.append({
			session: 'old',
			owner: null,
			at: 0,
			collection: 'todos',
			kind: 'insert',
			args: [{ title: 'anyone' }],
		})
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			now: () => 10 * 60 * 1000,
		})
		const { store, calls } = recordingStore()
		await queue.apply(store)
		expect(calls).toEqual(['todos.insert:{"title":"anyone"}'])
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

	it('fails waiting and later writes when the store will not open, and keeps the saved ones for the next start', async () => {
		const db = freshDb()
		const queue = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'a' })
		const pending = queue.enqueue('todos', 'insert', [{ title: 'x' }])
		const rejected = expect(pending).rejects.toMatchObject({
			code: 'WRITE_NOT_APPLIED',
			context: { savedForLater: true },
		})
		const probe = journalFor(db)
		await vi.waitFor(async () => expect(await probe.list()).toHaveLength(1))
		await queue.fail(new Error('no store'))
		await rejected
		// Kept: the next start applies it, and the caller was told so.
		expect(await probe.list()).toHaveLength(1)
		// A write made after the failure is refused at once, not queued forever.
		await expect(queue.enqueue('todos', 'insert', [{ title: 'late' }])).rejects.toMatchObject({
			code: 'WRITE_NOT_APPLIED',
		})
		expect(await probe.list()).toHaveLength(1)
		probe.close()
	})

	it('tells the caller a memory-only write is lost when the store will not open', async () => {
		const queue = new PreReadyWriteQueue({ dbName: freshDb(), locks: null, journal: null })
		const pending = queue.enqueue('todos', 'insert', [{ title: 'x' }])
		const rejected = expect(pending).rejects.toMatchObject({ context: { savedForLater: false } })
		await queue.fail(new Error('no store'))
		await rejected
	})

	it('rejects pending writes when the app is closed before it opened', async () => {
		const queue = new PreReadyWriteQueue({ dbName: freshDb(), locks: null, journal: null })
		const pending = queue.enqueue('todos', 'insert', [{ title: 'x' }])
		const rejected = expect(pending).rejects.toThrow('closed before the local database opened')
		await queue.close()
		await rejected
	})

	it('applies a queued write under the write observer that was current when it was made', async () => {
		const queue = new PreReadyWriteQueue({ dbName: freshDb(), locks: null, journal: null })
		const seen: Array<WriteObserver | null> = []
		const observer: WriteObserver = { onWrite: () => {} } as unknown as WriteObserver
		const pending = runWithWriteObserver(observer, () => queue.enqueue('todos', 'insert', [{}]))
		const { currentWriteObserver } = await import('@korajs/core/lite')
		const store: WriteTarget = {
			collection: () => ({
				findById: async () => null,
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

describe('PreReadyWriteQueue: privacy of the journal', () => {
	function rawJournalText(db: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(`kora-write-journal:${db}`)
			request.onerror = () => reject(request.error)
			request.onsuccess = () => {
				const conn = request.result
				const all = conn.transaction('entries', 'readonly').objectStore('entries').getAll()
				all.onsuccess = () => {
					conn.close()
					resolve(JSON.stringify(all.result))
				}
				all.onerror = () => reject(all.error)
			}
		})
	}

	it('keeps a write to a collection the journal may not hold out of IndexedDB entirely', async () => {
		const db = freshDb()
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'a',
			journalBlock: (collection) => (collection === 'vault' ? 'secret-field' : null),
		})
		const secret = queue.enqueue('vault', 'insert', [{ token: 'hunter2-plaintext' }])
		const plain = queue.enqueue('todos', 'insert', [{ title: 'visible' }])
		const probe = journalFor(db)
		await vi.waitFor(async () => expect(await probe.list()).toHaveLength(1))
		const text = await rawJournalText(db)
		expect(text).toContain('visible')
		expect(text).not.toContain('hunter2')
		const { store, calls } = recordingStore()
		await queue.apply(store)
		await Promise.all([secret, plain])
		// Held in memory and applied all the same, in order.
		expect(calls).toEqual([
			'vault.insert:{"token":"hunter2-plaintext"}',
			'todos.insert:{"title":"visible"}',
		])
		probe.close()
	})
})

describe('PreReadyWriteQueue: ordering and errors', () => {
	it('applies the entries a closed tab left before this session writes, oldest first', async () => {
		const db = freshDb()
		const probe = journalFor(db)
		await probe.append({
			session: 'old',
			owner: null,
			at: 0,
			collection: 'todos',
			kind: 'insert',
			args: [{ title: 'older' }],
		})
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			now: () => 10 * 60 * 1000,
		})
		const mine = queue.enqueue('todos', 'insert', [{ title: 'newer' }])
		const { store, calls } = recordingStore()
		await queue.apply(store)
		await mine
		expect(calls).toEqual(['todos.insert:{"title":"older"}', 'todos.insert:{"title":"newer"}'])
		probe.close()
	})

	it('holds a write made while the queue drains behind the ones before it', async () => {
		const queue = new PreReadyWriteQueue({ dbName: freshDb(), locks: null, journal: null })
		const events: string[] = []
		let releaseFirst: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const store: WriteTarget = {
			collection: () => ({
				findById: async () => null,
				insert: async (data) => {
					const title = String((data as { title: string }).title)
					events.push(`start:${title}`)
					if (title === 'first') await gate
					events.push(`end:${title}`)
					return data
				},
				insertMany: async () => [],
				update: async () => ({}),
				delete: async () => {},
			}),
		}
		const first = queue.enqueue('todos', 'insert', [{ title: 'first' }])
		const applying = queue.apply(store)
		await vi.waitFor(() => expect(events).toEqual(['start:first']))
		// A mutation that awaited something else and now writes: still inside the drain.
		expect(queue.acceptsDirectWrites).toBe(true)
		const second = queue.enqueue('todos', 'insert', [{ title: 'second' }])
		releaseFirst()
		await Promise.all([first, second, applying])
		expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second'])
	})

	it('rejects a write that fails to apply, applies the ones after it, and removes its journal entry', async () => {
		const db = freshDb()
		const queue = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'a' })
		const bad = queue.enqueue('todos', 'insert', [{ title: 'bad' }])
		const good = queue.enqueue('todos', 'insert', [{ title: 'good' }])
		const badRejected = expect(bad).rejects.toThrow('invalid title')
		const probe = journalFor(db)
		await vi.waitFor(async () => expect(await probe.list()).toHaveLength(2))
		const calls: string[] = []
		const store: WriteTarget = {
			collection: () => ({
				findById: async () => null,
				insert: async (data) => {
					const title = (data as { title: string }).title
					if (title === 'bad') throw new Error('invalid title')
					calls.push(title)
					return data
				},
				insertMany: async () => [],
				update: async () => ({}),
				delete: async () => {},
			}),
		}
		await queue.apply(store)
		await badRejected
		await expect(good).resolves.toMatchObject({ title: 'good' })
		expect(calls).toEqual(['good'])
		// The caller heard about the failure, so neither entry waits for a retry.
		expect(await probe.list()).toEqual([])
		probe.close()
	})
})

describe('PreReadyWriteQueue: the journal outlives the apply', () => {
	it('still holds the entry while the write is being applied, and drops it after', async () => {
		const db = freshDb()
		const queue = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'a' })
		const pending = queue.enqueue('todos', 'insert', [{ title: 'in flight' }])
		const probe = journalFor(db)
		await vi.waitFor(async () => expect(await probe.list()).toHaveLength(1))
		let during = -1
		const store: WriteTarget = {
			collection: () => ({
				findById: async () => null,
				insert: async (data) => {
					during = (await probe.list()).length
					return data
				},
				insertMany: async () => [],
				update: async () => ({}),
				delete: async () => {},
			}),
		}
		await queue.apply(store)
		await pending
		await queue.settled()
		expect(during).toBe(1)
		expect(await probe.list()).toEqual([])
		probe.close()
	})
})

describe('PreReadyWriteQueue: replay is idempotent', () => {
	it('fixes the record id when the user acts and replays an insert onto the same record', async () => {
		const db = freshDb()
		const journal = journalFor(db)
		// The write is applied but the entry is not removed (the process died in between).
		vi.spyOn(journal, 'remove').mockRejectedValue(new Error('tab closed'))
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const first = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'a', journal })
		const pending = first.enqueue('todos', 'insert', [{ title: 'once' }])
		const shared = recordingStore()
		await first.apply(shared.store)
		await pending
		expect(shared.options[0]?.recordId).toMatch(/^[0-9a-f-]{36}$/)
		const probe = journalFor(db)
		const [kept] = await probe.list()
		expect(kept?.recordId).toBe(shared.options[0]?.recordId)

		// The next session replays the same entry twice over: the record exists, so nothing is written.
		for (const session of ['b', 'c']) {
			await new PreReadyWriteQueue({
				dbName: db,
				locks: null,
				session,
				journal: journalFor(db),
				// Entries carry the real clock; ten minutes later they are old enough to recover.
				now: () => Date.now() + 10 * 60 * 1000,
			}).apply(shared.store)
		}
		expect(shared.calls).toEqual(['todos.insert:{"title":"once"}'])
		error.mockRestore()
		probe.close()
	})

	it('gives every row of an insertMany its own fixed id', async () => {
		const queue = new PreReadyWriteQueue({ dbName: freshDb(), locks: null, journal: null })
		const pending = queue.enqueue('todos', 'insertMany', [[{ title: 'a' }, { title: 'b' }]])
		const seen: Array<WriteOptions | undefined> = []
		const store: WriteTarget = {
			collection: () => ({
				findById: async () => null,
				insert: async () => ({}),
				insertMany: async (_rows, options) => {
					seen.push(options)
					return []
				},
				update: async () => ({}),
				delete: async () => {},
			}),
		}
		await queue.apply(store)
		await pending
		expect(seen[0]?.recordIds).toHaveLength(2)
		expect(new Set(seen[0]?.recordIds).size).toBe(2)
		expect(seen[0]?.writtenAt).toBeTypeOf('number')
	})
})

describe('PreReadyWriteQueue: recovery never blocks the open', () => {
	it('does not touch locks or the owner when the journal holds nothing from other sessions', async () => {
		const request = vi.fn(async (_n: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) =>
			cb({}),
		)
		const resolveOwner = vi.fn(async () => 'alice')
		const queue = new PreReadyWriteQueue({
			dbName: freshDb(),
			locks: { request },
			session: 'a',
			resolveOwner,
		})
		await queue.apply(recordingStore().store)
		expect(request).not.toHaveBeenCalled()
		expect(resolveOwner).not.toHaveBeenCalled()
	})

	it('still opens, and keeps the entries, when taking the recovery lock throws', async () => {
		const db = freshDb()
		const probe = journalFor(db)
		await probe.append({
			session: 'old',
			owner: null,
			at: 0,
			collection: 'todos',
			kind: 'insert',
			args: [{ title: 'left' }],
		})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const locks: LockManagerLike = {
			request: async () => {
				throw new Error('SecurityError: locks unavailable')
			},
		}
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks,
			session: 'mine',
			now: () => 10 * 60 * 1000,
		})
		const mine = queue.enqueue('todos', 'insert', [{ title: 'mine' }])
		const { store, calls } = recordingStore()
		await queue.apply(store)
		await mine
		await queue.settled()
		expect(calls).toEqual(['todos.insert:{"title":"mine"}'])
		expect(await probe.list()).toHaveLength(1)
		expect(warn).toHaveBeenCalled()
		warn.mockRestore()
		probe.close()
	})

	it('treats a user lookup that never settles as unknown instead of hanging', async () => {
		const db = freshDb()
		const probe = journalFor(db)
		await probe.append({
			session: 'old',
			owner: null,
			at: 0,
			collection: 'todos',
			kind: 'insert',
			args: [{}],
		})
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			resolveOwner: () => new Promise<string | undefined>(() => {}),
			ownerTimeoutMs: 1,
			now: () => 10 * 60 * 1000,
		})
		await queue.apply(recordingStore().store)
		probe.close()
	})

	it('skips recovery when another tab holds the recovery lock', async () => {
		const db = freshDb()
		const probe = journalFor(db)
		await probe.append({
			session: 'old',
			owner: null,
			at: 0,
			collection: 'todos',
			kind: 'insert',
			args: [{}],
		})
		const locks: LockManagerLike = {
			request: async (_name, options, callback) => {
				expect(options.ifAvailable).toBe(true)
				return callback(null)
			},
		}
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks,
			session: 'mine',
			now: () => 10 * 60 * 1000,
		})
		const { store, calls } = recordingStore()
		await queue.apply(store)
		expect(calls).toEqual([])
		expect(await probe.list()).toHaveLength(1)
		probe.close()
	})
})

describe('PreReadyWriteQueue: a recovered write that fails', () => {
	const stale = (title: string): JournalEntry => ({
		session: 'old',
		owner: null,
		at: 0,
		collection: 'todos',
		kind: 'insert',
		args: [{ title }],
	})
	const failing = (error: Error): WriteTarget => ({
		collection: () => ({
			findById: async () => null,
			insert: async () => {
				throw error
			},
			insertMany: async () => [],
			update: async () => ({}),
			delete: async () => {},
		}),
	})

	it('keeps a transient failure for the next start and reports it as retryable', async () => {
		const db = freshDb()
		const probe = journalFor(db)
		await probe.append(stale('later'))
		const events: Array<{ permanent: boolean; message: string }> = []
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const busy = Object.assign(new Error('storage is not durable'), {
			code: 'STORAGE_DURABILITY_LOST',
		})
		await new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			now: () => 10 * 60 * 1000,
			emit: (event) => events.push(event),
		}).apply(failing(busy))
		const [kept] = await probe.list()
		expect(kept?.failed).toBeUndefined()
		expect(events).toMatchObject([{ permanent: false, message: 'storage is not durable' }])
		// The next start tries it again and it goes through.
		const next = recordingStore()
		await new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'third',
			now: () => 20 * 60 * 1000,
		}).apply(next.store)
		expect(next.calls).toEqual(['todos.insert:{"title":"later"}'])
		expect(await probe.list()).toEqual([])
		error.mockRestore()
		probe.close()
	})

	it('marks a permanent failure, reports it, and prunes it after 30 days', async () => {
		const db = freshDb()
		const probe = journalFor(db)
		await probe.append(stale('broken'))
		const events: Array<{ permanent: boolean }> = []
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		await new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			now: () => 10 * 60 * 1000,
			emit: (event) => events.push(event),
		}).apply(failing(new Error('Field "title" is required')))
		expect(events).toMatchObject([{ permanent: true }])
		expect((await probe.list())[0]?.failed).toContain('required')
		// A later start does not retry it, and drops it once it is a month old.
		const again = recordingStore()
		await new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'third',
			now: () => 31 * 24 * 60 * 60 * 1000,
		}).apply(again.store)
		expect(again.calls).toEqual([])
		expect(await probe.list()).toEqual([])
		error.mockRestore()
		probe.close()
	})
})
