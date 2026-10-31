import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import {
	type JournalFailureEvent,
	type JournalMemoryOnlyEvent,
	type LockManagerLike,
	PreReadyWriteQueue,
	type WriteTarget,
} from './pre-ready-writes'
import { type JournalEntry, type WriteJournal, openWriteJournal } from './write-journal'

let counter = 0
const freshDb = (): string => `replay-test-${++counter}`
const LATER = (): number => Date.now() + 10 * 60 * 1000

function journalFor(db: string): WriteJournal {
	const journal = openWriteJournal(db)
	if (!journal) throw new Error('IndexedDB should be available in this test')
	return journal
}

interface Op {
	type: 'insert' | 'update' | 'delete'
	nodeId: string
	timestamp: { wallTime: number }
}

/** A store that keeps the operation log of every record, like the real one. */
function loggedStore(): {
	store: WriteTarget
	log: Map<string, Op[]>
	calls: string[]
	add: (collection: string, id: string, op: Op) => void
	failWith: { error: unknown }
} {
	const log = new Map<string, Op[]>()
	const calls: string[] = []
	const failWith: { error: unknown } = { error: null }
	let clock = 1_000_000
	const key = (c: string, id: string): string => `${c}/${id}`
	const add = (c: string, id: string, op: Op): void => {
		log.set(key(c, id), [...(log.get(key(c, id)) ?? []), op])
	}
	const live = (c: string, id: string): boolean => {
		const ops = log.get(key(c, id)) ?? []
		return ops.length > 0 && ops[ops.length - 1]?.type !== 'delete'
	}
	const missing = (c: string, id: string): Error =>
		Object.assign(new Error(`Record "${id}" not found in collection "${c}"`), {
			code: 'RECORD_NOT_FOUND',
		})
	const store: WriteTarget = {
		getNodeId: () => 'me',
		getOperationsForRecord: async (c, id) => log.get(key(c, id)) ?? [],
		collection: (c) => ({
			findById: async (id) => (live(c, id) ? { id } : null),
			insert: async (data, options) => {
				if (failWith.error) throw failWith.error
				calls.push(`${c}.insert:${JSON.stringify(data)}`)
				const id = options?.recordId ?? 'generated'
				add(c, id, { type: 'insert', nodeId: 'me', timestamp: { wallTime: ++clock + Date.now() } })
				return { id }
			},
			insertMany: async () => [],
			update: async (id, data) => {
				if (failWith.error) throw failWith.error
				if (!live(c, id)) throw missing(c, id)
				calls.push(`${c}.update:${id}:${JSON.stringify(data)}`)
				add(c, id, { type: 'update', nodeId: 'me', timestamp: { wallTime: ++clock + Date.now() } })
				return { id }
			},
			delete: async (id) => {
				if (failWith.error) throw failWith.error
				if (!live(c, id)) throw missing(c, id)
				calls.push(`${c}.delete:${id}`)
				add(c, id, { type: 'delete', nodeId: 'me', timestamp: { wallTime: ++clock + Date.now() } })
			},
		}),
	}
	return { store, log, calls, add, failWith }
}

async function seedEntry(db: string, entry: Partial<JournalEntry>): Promise<number> {
	const journal = journalFor(db)
	const seq = await journal.append({
		session: 'old',
		owner: null,
		at: 0,
		collection: 'todos',
		kind: 'insert',
		args: [{ title: 'x' }],
		...entry,
	})
	journal.close()
	return seq
}

async function recoverWith(
	db: string,
	store: WriteTarget,
	options: Partial<ConstructorParameters<typeof PreReadyWriteQueue>[0]> = {},
): Promise<{ queue: PreReadyWriteQueue; events: Array<JournalFailureEvent | JournalMemoryOnlyEvent> }> {
	const events: Array<JournalFailureEvent | JournalMemoryOnlyEvent> = []
	const queue = new PreReadyWriteQueue({
		dbName: db,
		locks: null,
		session: 'mine',
		now: LATER,
		emit: (event) => events.push(event),
		...options,
	})
	await queue.apply(store)
	await queue.settled()
	return { queue, events }
}

const remaining = async (db: string): Promise<JournalEntry[]> => {
	const journal = journalFor(db)
	const all = await journal.list()
	journal.close()
	return all
}

describe('journal replay consults the operation log', () => {
	it('never resurrects a record that was deleted after the insert was queued', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'insert', recordId: 'r1', args: [{ title: 'ghost' }] })
		const { store, calls, add } = loggedStore()
		// Another tab (or sync) inserted and deleted the record before this start.
		add('todos', 'r1', { type: 'insert', nodeId: 'other', timestamp: { wallTime: 1 } })
		add('todos', 'r1', { type: 'delete', nodeId: 'other', timestamp: { wallTime: 2 } })
		await recoverWith(db, store)
		expect(calls).toEqual([])
		expect(await remaining(db)).toEqual([])
	})

	it('inserts a record the log has never seen, once', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'insert', recordId: 'r1', args: [{ title: 'new' }] })
		const { store, calls } = loggedStore()
		await recoverWith(db, store)
		await recoverWith(db, store)
		expect(calls).toEqual(['todos.insert:{"title":"new"}'])
	})

	it('does not overwrite an edit another device made after the user acted', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'update', args: ['r1', { title: 'stale' }], writtenAt: 100, at: 100 })
		const { store, calls, add } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'other', timestamp: { wallTime: 50 } })
		add('todos', 'r1', { type: 'update', nodeId: 'other', timestamp: { wallTime: 500 } })
		await recoverWith(db, store)
		expect(calls).toEqual([])
		expect(await remaining(db)).toEqual([])
	})

	it('applies an update nobody overtook', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'update', args: ['r1', { title: 'fresh' }], writtenAt: 100, at: 100 })
		const { store, calls, add } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'other', timestamp: { wallTime: 50 } })
		await recoverWith(db, store)
		expect(calls).toEqual(['todos.update:r1:{"title":"fresh"}'])
	})

	it('treats a delete of a record that is already gone as done, with no failure event', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'delete', args: ['r1'] })
		const { store, calls, add } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 1 } })
		add('todos', 'r1', { type: 'delete', nodeId: 'me', timestamp: { wallTime: 2 } })
		const { events } = await recoverWith(db, store)
		expect(calls).toEqual([])
		expect(events).toEqual([])
		expect(await remaining(db)).toEqual([])
	})

	it('treats an update of a record deleted meanwhile as done', async () => {
		const db = freshDb()
		// A newer delete by this device: RECORD_NOT_FOUND from the store, not a failure.
		await seedEntry(db, { kind: 'update', args: ['r1', { title: 'late' }], writtenAt: 1, at: 1 })
		const { store, add } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 0 } })
		add('todos', 'r1', { type: 'delete', nodeId: 'me', timestamp: { wallTime: 0 } })
		const { events } = await recoverWith(db, store)
		expect(events).toEqual([])
		expect(await remaining(db)).toEqual([])
	})

	it('does not apply an update twice when a pass died after applying it', async () => {
		const db = freshDb()
		const markedAt = Date.now() + 1000
		await seedEntry(db, {
			kind: 'update',
			args: ['r1', { title: 'once' }],
			writtenAt: 100,
			at: 100,
			applyingAt: markedAt,
		})
		const { store, calls, add } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 50 } })
		// The interrupted pass applied it after marking.
		add('todos', 'r1', { type: 'update', nodeId: 'me', timestamp: { wallTime: markedAt + 5 } })
		await recoverWith(db, store)
		expect(calls).toEqual([])
		expect(await remaining(db)).toEqual([])
	})
})

describe('a recovered write that fails', () => {
	it('is permanent for a generic storage error (ADAPTER_ERROR) and for a message that only sounds transient', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'insert', recordId: 'a', args: [{ title: 'a' }] })
		await seedEntry(db, { kind: 'insert', recordId: 'b', args: [{ title: 'b' }] })
		const { store, failWith } = loggedStore()
		const errors = [
			Object.assign(new Error('Execute failed'), { code: 'ADAPTER_ERROR' }),
			new Error('state "locked" is not allowed'),
		]
		let n = 0
		const original = store.collection('todos').insert
		store.collection = (name) => ({
			...loggedStore().store.collection(name),
			insert: async (...args: Parameters<typeof original>) => {
				failWith.error = errors[n++]
				throw failWith.error
			},
		})
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const { events } = await recoverWith(db, store)
		error.mockRestore()
		expect(events.map((e) => (e.type === 'journal:write-failed' ? e.permanent : null))).toEqual([
			true,
			true,
		])
		expect((await remaining(db)).every((entry) => entry.failed !== undefined)).toBe(true)
	})

	it('gives up on a transient failure after five attempts and keeps the entry as failed', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'insert', recordId: 'a', args: [{ title: 'a' }], attempts: 4 })
		const { store, failWith } = loggedStore()
		failWith.error = Object.assign(new Error('busy'), { code: 'WORKER_TIMEOUT' })
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const { events } = await recoverWith(db, store)
		error.mockRestore()
		expect(events[0]).toMatchObject({ type: 'journal:write-failed', permanent: true })
		expect((await remaining(db))[0]?.failed).toBeDefined()
	})

	it('counts the attempt and keeps a transient failure for the next start', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'insert', recordId: 'a', args: [{ title: 'a' }] })
		const { store, failWith } = loggedStore()
		failWith.error = Object.assign(new Error('busy'), { code: 'WORKER_TIMEOUT' })
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		await recoverWith(db, store)
		error.mockRestore()
		const [entry] = await remaining(db)
		expect(entry).toMatchObject({ attempts: 1 })
		expect(entry?.failed).toBeUndefined()
	})

	it('stops the pass at a transient failure: a later entry never lands before the earlier one', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'update', args: ['r1', { title: 'first' }], writtenAt: 1, at: 1 })
		await seedEntry(db, { kind: 'update', args: ['r1', { title: 'second' }], writtenAt: 2, at: 2 })
		const { store, calls, add, failWith } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 0 } })
		failWith.error = Object.assign(new Error('busy'), { code: 'WORKER_TIMEOUT' })
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		await recoverWith(db, store)
		error.mockRestore()
		expect(calls).toEqual([])
		const left = await remaining(db)
		expect(left).toHaveLength(2)
		expect(left[1]?.attempts).toBeUndefined()
	})

	it('holds this session\'s write to a record whose older write is still waiting, saved for the next start', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'update', args: ['r1', { title: 'older' }], writtenAt: 1, at: 1 })
		const { store, calls, add, failWith } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 0 } })
		failWith.error = Object.assign(new Error('busy'), { code: 'WORKER_TIMEOUT' })
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const queue = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'mine', now: LATER })
		const live = queue.enqueue('todos', 'update', ['r1', { title: 'newer' }])
		const rejected = live.catch((e: unknown) => e)
		await queue.apply(store)
		error.mockRestore()
		expect(await rejected).toMatchObject({ code: 'WRITE_NOT_APPLIED', context: { savedForLater: true } })
		expect(calls).toEqual([])
		await queue.settled()
		expect(await remaining(db)).toHaveLength(2)
	})
})

describe('the journal never holds the open', () => {
	it('treats a journal that never answers as not journaled, and still applies the write', async () => {
		vi.useFakeTimers()
		try {
			const never = new Promise<number>(() => {})
			const stuck: WriteJournal = {
				append: () => never,
				list: () => never as unknown as Promise<JournalEntry[]>,
				remove: () => never as unknown as Promise<void>,
				markFailed: () => never as unknown as Promise<void>,
				update: () => never as unknown as Promise<void>,
				close: () => {},
				destroy: () => never as unknown as Promise<void>,
			}
			const events: Array<JournalFailureEvent | JournalMemoryOnlyEvent> = []
			const queue = new PreReadyWriteQueue({
				dbName: freshDb(),
				locks: null,
				journal: stuck,
				emit: (event) => events.push(event),
			})
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const done = queue.enqueue('todos', 'insert', [{ title: 'x' }])
			const { store, calls } = loggedStore()
			const applied = queue.apply(store)
			await vi.advanceTimersByTimeAsync(10_000)
			await applied
			await done
			warn.mockRestore()
			expect(calls).toEqual(['todos.insert:{"title":"x"}'])
			expect(events).toContainEqual(
				expect.objectContaining({ type: 'journal:memory-only', reason: 'journal-timeout' }),
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it('rejects waiting writes when the store fails to open even if the journal never answers', async () => {
		vi.useFakeTimers()
		try {
			const never = new Promise<number>(() => {})
			const stuck = {
				append: () => never,
				list: () => never,
				remove: () => never,
				markFailed: () => never,
				update: () => never,
				close: () => {},
				destroy: () => never,
			} as unknown as WriteJournal
			const queue = new PreReadyWriteQueue({ dbName: freshDb(), locks: null, journal: stuck })
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const waiting = queue.enqueue('todos', 'insert', [{ title: 'x' }]).catch((e: unknown) => e)
			const failing = queue.fail(new Error('open failed'))
			await vi.advanceTimersByTimeAsync(10_000)
			await failing
			warn.mockRestore()
			expect(await waiting).toMatchObject({ code: 'WRITE_NOT_APPLIED' })
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('the owner of a saved write', () => {
	it('is saved at once with an owner-pending mark, and patched when the user is known', async () => {
		const db = freshDb()
		let answer: (value: string) => void = () => {}
		const owner = new Promise<string>((resolve) => {
			answer = resolve
		})
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'a',
			resolveOwner: () => owner,
		})
		void queue.enqueue('todos', 'insert', [{ title: 'x' }]).catch(() => {})
		const probe = journalFor(db)
		await vi.waitFor(async () => {
			const [entry] = await probe.list()
			expect(entry).toMatchObject({ owner: null, ownerPending: true })
		})
		answer('alice')
		await vi.waitFor(async () => {
			const [entry] = await probe.list()
			expect(entry).toMatchObject({ owner: 'alice', ownerPending: false })
		})
		probe.close()
	})

	it('does not remember a timeout as "nobody": a later look finds the user', async () => {
		// Only the timeout is faked: the IndexedDB stand-in runs on its own scheduler.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		try {
			const db = freshDb()
			await seedEntry(db, { owner: 'alice', kind: 'insert', recordId: 'r1', args: [{ title: 'hers' }] })
			let calls = 0
			const queue = new PreReadyWriteQueue({
				dbName: db,
				locks: null,
				session: 'mine',
				now: LATER,
				resolveOwner: () => {
					calls++
					return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve('alice')
				},
			})
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			void queue.enqueue('todos', 'insert', [{ title: 'first' }]).catch(() => {})
			// The first lookup starts once the write is saved, and times out.
			await vi.waitFor(() => expect(calls).toBe(1))
			await vi.advanceTimersByTimeAsync(5000)
			const { store, calls: applied } = loggedStore()
			await queue.apply(store)
			warn.mockRestore()
			// Recovery asked again, found alice, and applied her entry.
			expect(applied).toContain('todos.insert:{"title":"hers"}')
		} finally {
			vi.useRealTimers()
		}
	})

	it('holds an unowned write when each user has a database of their own', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: null, ownerPending: true, recordId: 'r1', args: [{ title: 'who' }] })
		const { store, calls } = loggedStore()
		const { events } = await recoverWith(db, store, {
			resolveOwner: async () => 'alice',
			namespacedByUser: true,
		})
		expect(calls).toEqual([])
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'journal:write-failed', permanent: false }),
		)
		expect(await remaining(db)).toHaveLength(1)
	})

	it('lets the first signed-in user claim an unowned write when the database is shared', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: null, ownerPending: true, recordId: 'r1', args: [{ title: 'who' }] })
		const { store, calls } = loggedStore()
		await recoverWith(db, store, { resolveOwner: async () => 'alice', namespacedByUser: false })
		expect(calls).toEqual(['todos.insert:{"title":"who"}'])
	})
})

describe('writes held in memory only are announced', () => {
	it('names the reason for an atomic helper, a file value and a blocked collection', async () => {
		const { op } = await import('@korajs/core')
		const events: Array<JournalFailureEvent | JournalMemoryOnlyEvent> = []
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const queue = new PreReadyWriteQueue({
			dbName: freshDb(),
			locks: null,
			emit: (event) => events.push(event),
			journalBlock: (collection) => (collection === 'vault' ? 'secret-field' : null),
		})
		const pending = [
			queue.enqueue('todos', 'update', ['r1', { count: op.increment(1) }]),
			queue.enqueue('todos', 'insert', [{ photo: new Blob(['x'.repeat(1000)]) }]),
			queue.enqueue('vault', 'insert', [{ token: 't' }]),
		].map((write) => write.catch(() => {}))
		const reasons = events.map((e) => (e.type === 'journal:memory-only' ? e.reason : null))
		expect(reasons).toEqual(['atomic-operation', 'binary-value', 'secret-field'])
		expect(queue.memoryOnlyCount).toBe(3)
		// One dev warning per reason, not per write.
		expect(warn).toHaveBeenCalledTimes(3)
		await queue.close()
		await Promise.all(pending)
		warn.mockRestore()
		// Nothing of a file or a blocked collection reached IndexedDB.
		expect(await remaining(queue['options'].dbName)).toEqual([])
	})
})

describe('the journal follows the database', () => {
	it('is deleted when the database is wiped', async () => {
		const db = freshDb()
		await seedEntry(db, { recordId: 'r1' })
		const queue = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'a' })
		await queue.discardJournal()
		expect(await remaining(db)).toEqual([])
	})

	it('releases the page-lifetime session lock when the app is closed before it opened', async () => {
		const held = new Set<string>()
		const releases: string[] = []
		const locks: LockManagerLike = {
			request: (name, _options, callback) => {
				held.add(name)
				return Promise.resolve(callback({})).then(() => {
					held.delete(name)
					releases.push(name)
				})
			},
		}
		const queue = new PreReadyWriteQueue({ dbName: freshDb(), locks, session: 's1' })
		const write = queue.enqueue('todos', 'insert', [{ title: 'x' }]).catch(() => {})
		await vi.waitFor(() => expect(held.has('kora-journal-session:s1')).toBe(true))
		await queue.close()
		await write
		await vi.waitFor(() => expect(releases).toEqual(['kora-journal-session:s1']))
	})
})

describe('two tabs', () => {
	/** Web Locks as the browser has them: an exclusive lock queues, `ifAvailable` does not wait. */
	function lockManager(): LockManagerLike {
		const held = new Set<string>()
		return {
			request: async (name, options, callback) => {
				if (held.has(name)) {
					if (options.ifAvailable) return callback(null)
					// A real queue would wait for the holder; the tests that need this never resolve.
					return new Promise(() => {})
				}
				held.add(name)
				try {
					return await callback({})
				} finally {
					held.delete(name)
				}
			},
		}
	}

	it('a tab that finds the recovery lock taken skips recovery instead of waiting for the other', async () => {
		const db = freshDb()
		await seedEntry(db, { recordId: 'r1', args: [{ title: 'mine-to-recover' }] })
		const locks = lockManager()
		const first = loggedStore()
		const release: { go: () => void } = { go: () => {} }
		const gate = new Promise<void>((resolve) => {
			release.go = resolve
		})
		// Tab A applies the entry but is held inside the insert, with the recovery lock.
		const blocking: WriteTarget = {
			...first.store,
			collection: (name) => ({
				...first.store.collection(name),
				insert: async (...args) => {
					await gate
					return first.store.collection(name).insert(...args)
				},
			}),
		}
		const a = new PreReadyWriteQueue({ dbName: db, locks, session: 'A', now: LATER })
		const aDone = a.apply(blocking)
		await vi.waitFor(() => expect(true).toBe(true))
		const second = loggedStore()
		const b = new PreReadyWriteQueue({ dbName: db, locks, session: 'B', now: LATER })
		let bOpened = false
		const bDone = b.apply(second.store).then(() => {
			bOpened = true
		})
		// B opens while A still holds the lock, and applied nothing of the journal.
		await vi.waitFor(() => expect(bOpened).toBe(true))
		expect(second.calls).toEqual([])
		release.go()
		await aDone
		await bDone
		expect(first.calls).toEqual(['todos.insert:{"title":"mine-to-recover"}'])
	})
})

describe('sign-out and wipe', () => {
	it('clears the failed writes kept for the previous user, not those waiting for another', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: 'alice', failed: 'boom' })
		await seedEntry(db, { owner: 'bob', failed: 'boom' })
		await seedEntry(db, { owner: 'alice', recordId: 'live' })
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			resolveOwner: async () => 'alice',
		})
		// The queue learns who is signed in by saving a write, as a real session does.
		const write = queue.enqueue('todos', 'insert', [{ title: 'x' }]).catch(() => {})
		await vi.waitFor(async () => expect((await remaining(db)).length).toBeGreaterThan(3))
		await vi.waitFor(() => expect(queue['knownOwner']).toEqual({ owner: 'alice' }))
		await queue.noteSignedInUser('bob')
		const left = await remaining(db)
		expect(left.filter((e) => e.failed !== undefined).map((e) => e.owner)).toEqual(['bob'])
		await queue.close()
		await write
	})

	it('lets go of the connection once the writes are applied, so a wipe is not blocked', async () => {
		const db = freshDb()
		const journal = journalFor(db)
		const close = vi.spyOn(journal, 'close')
		const queue = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'a', journal })
		const pending = queue.enqueue('todos', 'insert', [{ title: 'x' }])
		await queue.apply(loggedStore().store)
		await pending
		await vi.waitFor(() => expect(close).toHaveBeenCalled())
	})
})
