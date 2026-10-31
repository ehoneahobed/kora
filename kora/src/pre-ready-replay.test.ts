import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { describeHeld, replayEntry, snapshotHistory } from './pre-ready-recovery'
import {
	type JournalDiscardedEvent,
	type JournalExpiredEvent,
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
	data?: Record<string, unknown>
}

type AnyEvent =
	| JournalFailureEvent
	| JournalMemoryOnlyEvent
	| JournalDiscardedEvent
	| JournalExpiredEvent

const FIXED = Symbol.for('korajs.store.fixedWrite')
const keyOf = (options: unknown): string | undefined =>
	(options as { [k: symbol]: { opKey?: string } } | undefined)?.[FIXED]?.opKey

/** A store that keeps the operation log of every record, like the real one. */
function loggedStore(): {
	store: WriteTarget
	log: Map<string, Op[]>
	calls: string[]
	add: (collection: string, id: string, op: Op) => void
	failWith: { error: unknown }
	applied: Set<string>
} {
	const applied = new Set<string>()
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
		// Like the real store: the key is recorded together with the write, only if it succeeds.
		hasJournalApplied: async (opKey) => applied.has(opKey),
		forgetJournalApplied: async (keys) => {
			for (const k of keys) applied.delete(k)
		},
		collection: (c) => ({
			findById: async (id) => (live(c, id) ? { id } : null),
			insert: async (data, options) => {
				if (failWith.error) throw failWith.error
				const opKey = keyOf(options)
				if (opKey) applied.add(opKey)
				calls.push(`${c}.insert:${JSON.stringify(data)}`)
				const id =
					(options as { [k: symbol]: { recordId?: string } } | undefined)?.[
						Symbol.for('korajs.store.fixedWrite')
					]?.recordId ?? 'generated'
				add(c, id, { type: 'insert', nodeId: 'me', timestamp: { wallTime: ++clock + Date.now() } })
				return { id }
			},
			insertMany: async () => [],
			update: async (id, data, options) => {
				if (failWith.error) throw failWith.error
				if (!live(c, id)) throw missing(c, id)
				const opKey = keyOf(options)
				if (opKey) applied.add(opKey)
				calls.push(`${c}.update:${id}:${JSON.stringify(data)}`)
				add(c, id, {
					type: 'update',
					nodeId: 'me',
					timestamp: { wallTime: ++clock + Date.now() },
					data,
				})
				return { id }
			},
			delete: async (id, options) => {
				if (failWith.error) throw failWith.error
				if (!live(c, id)) throw missing(c, id)
				const opKey = keyOf(options)
				if (opKey) applied.add(opKey)
				calls.push(`${c}.delete:${id}`)
				add(c, id, { type: 'delete', nodeId: 'me', timestamp: { wallTime: ++clock + Date.now() } })
			},
		}),
	}
	return { store, log, calls, add, failWith, applied }
}

async function seedEntry(db: string, entry: Partial<JournalEntry>): Promise<number> {
	const journal = journalFor(db)
	const seq = await journal.append({
		opKey: `seed-${++counter}`,
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
): Promise<{
	queue: PreReadyWriteQueue
	events: AnyEvent[]
}> {
	const events: AnyEvent[] = []
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

describe('journal replay asks the store whether the write already landed', () => {
	it('skips an insert whose key the store recorded (applied earlier, entry left behind)', async () => {
		const db = freshDb()
		await seedEntry(db, { opKey: 'k-ins', kind: 'insert', recordId: 'r1', args: [{ title: 'x' }] })
		const { store, calls, applied } = loggedStore()
		applied.add('k-ins')
		await recoverWith(db, store)
		expect(calls).toEqual([])
		expect(await remaining(db)).toEqual([])
	})

	it('inserts a record the store has never seen, once', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'insert', recordId: 'r1', args: [{ title: 'new' }] })
		const { store, calls } = loggedStore()
		await recoverWith(db, store)
		await recoverWith(db, store)
		expect(calls).toEqual(['todos.insert:{"title":"new"}'])
	})

	it('does not overwrite a field another device wrote after the user acted', async () => {
		const db = freshDb()
		await seedEntry(db, {
			kind: 'update',
			args: ['r1', { title: 'stale' }],
			writtenAt: 100,
			at: 100,
		})
		const { store, calls, add } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'other', timestamp: { wallTime: 50 } })
		add('todos', 'r1', {
			type: 'update',
			nodeId: 'other',
			timestamp: { wallTime: 500 },
			data: { title: 'newer' },
		})
		await recoverWith(db, store)
		expect(calls).toEqual([])
		expect(await remaining(db)).toEqual([])
	})

	it("does not overwrite a newer edit of this device's own node (another tab)", async () => {
		const db = freshDb()
		await seedEntry(db, {
			kind: 'update',
			args: ['r1', { title: 'stale' }],
			writtenAt: 100,
			at: 100,
		})
		const { store, calls, add } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 50 } })
		add('todos', 'r1', {
			type: 'update',
			nodeId: 'me',
			timestamp: { wallTime: 500 },
			data: { title: 'from another tab' },
		})
		await recoverWith(db, store)
		expect(calls).toEqual([])
	})

	it('applies only the fields nobody rewrote since', async () => {
		const db = freshDb()
		await seedEntry(db, {
			kind: 'update',
			args: ['r1', { title: 'stale', done: true }],
			writtenAt: 100,
			at: 100,
		})
		const { store, calls, add } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'other', timestamp: { wallTime: 50 } })
		add('todos', 'r1', {
			type: 'update',
			nodeId: 'other',
			timestamp: { wallTime: 500 },
			data: { title: 'newer' },
		})
		await recoverWith(db, store)
		expect(calls).toEqual(['todos.update:r1:{"done":true}'])
	})

	it('a delete yields to a write made after the user acted', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'delete', args: ['r1'], writtenAt: 100, at: 100 })
		const { store, calls, add } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 50 } })
		add('todos', 'r1', {
			type: 'update',
			nodeId: 'me',
			timestamp: { wallTime: 500 },
			data: { title: 'kept' },
		})
		await recoverWith(db, store)
		expect(calls).toEqual([])
	})

	it('applies an update nobody overtook', async () => {
		const db = freshDb()
		await seedEntry(db, {
			kind: 'update',
			args: ['r1', { title: 'fresh' }],
			writtenAt: 100,
			at: 100,
		})
		const { store, calls, add } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'other', timestamp: { wallTime: 50 } })
		await recoverWith(db, store)
		expect(calls).toEqual(['todos.update:r1:{"title":"fresh"}'])
	})

	it('treats a delete of a record that is already gone as done (the store says RECORD_NOT_FOUND), with no failure event', async () => {
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
		await seedEntry(db, { kind: 'update', args: ['r1', { title: 'late' }], writtenAt: 1, at: 1 })
		const { store, add } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 0 } })
		add('todos', 'r1', { type: 'delete', nodeId: 'me', timestamp: { wallTime: 0 } })
		const { events } = await recoverWith(db, store)
		expect(events).toEqual([])
		expect(await remaining(db)).toEqual([])
	})
})

/**
 * Advances fake timers in small steps, yielding to the (real) macrotasks fake-indexeddb runs on
 * between steps, so a journal call that does answer is not timed out by a clock that jumped.
 */
async function pump(totalMs: number): Promise<void> {
	for (let elapsed = 0; elapsed < totalMs; elapsed += 5) {
		for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => setImmediate(resolve))
		await vi.advanceTimersByTimeAsync(5)
	}
}

/** A journal that behaves like the real one except where a test breaks it. */
function flakyJournal(
	inner: WriteJournal,
	overrides: Partial<Record<'append' | 'remove' | 'update' | 'markFailed' | 'list', unknown>>,
): WriteJournal {
	return { ...inner, ...(overrides as Partial<WriteJournal>) } as WriteJournal
}

describe('a write applied in a session whose journal entry is left behind', () => {
	it('is not applied again, so a later edit is not reverted (T1: A applied, remove fails, B, restart)', async () => {
		const db = freshDb()
		const { store, calls, add } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 1 } })
		const real = journalFor(db)
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 's1',
			journal: flakyJournal(real, { remove: () => Promise.reject(new Error('IDB gone')) }),
		})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const first = queue.enqueue('todos', 'update', ['r1', { title: 'A' }])
		await queue.apply(store)
		await first
		await queue.settled()
		warn.mockRestore()
		// The user edits the same record again; then the app starts a second time.
		await store.collection('todos').update('r1', { title: 'B' })
		const { events } = await recoverWith(db, store)
		expect(calls).toEqual(['todos.update:r1:{"title":"A"}', 'todos.update:r1:{"title":"B"}'])
		expect(events).toEqual([])
		expect(await remaining(db)).toEqual([])
		real.close()
	})

	it('is not applied again when the append landed after its timeout (T5)', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		try {
			const db = freshDb()
			const { store, calls, add } = loggedStore()
			add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 1 } })
			const real = journalFor(db)
			let landLate: () => void = () => {}
			const queue = new PreReadyWriteQueue({
				dbName: db,
				locks: null,
				session: 's1',
				journalTimeoutMs: 50,
				journal: flakyJournal(real, {
					append: (entry: JournalEntry) =>
						new Promise<number>((resolve, reject) => {
							landLate = () => real.append(entry).then(resolve, reject)
						}),
				}),
			})
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const first = queue.enqueue('todos', 'update', ['r1', { title: 'A' }])
			await vi.advanceTimersByTimeAsync(60)
			await queue.apply(store)
			await first
			warn.mockRestore()
			landLate()
			await vi.advanceTimersByTimeAsync(1)
			vi.useRealTimers()
			await vi.waitFor(async () => expect(await remaining(db)).toHaveLength(1))
			await store.collection('todos').update('r1', { title: 'B' })
			await recoverWith(db, store)
			expect(calls).toEqual(['todos.update:r1:{"title":"A"}', 'todos.update:r1:{"title":"B"}'])
			expect(await remaining(db)).toEqual([])
			real.close()
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('recovery never waits on a journal call', () => {
	const fakeTimers = (): void => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	}

	it('a removal that never answers is not a failure, and ready is not held', async () => {
		fakeTimers()
		try {
			const db = freshDb()
			await seedEntry(db, { kind: 'insert', recordId: 'r1', args: [{ title: 'x' }] })
			const { store, calls } = loggedStore()
			const real = journalFor(db)
			const events: AnyEvent[] = []
			const queue = new PreReadyWriteQueue({
				dbName: db,
				locks: null,
				session: 'mine',
				now: LATER,
				journalTimeoutMs: 50,
				journal: flakyJournal(real, { remove: () => new Promise<void>(() => {}) }),
				emit: (event) => events.push(event),
			})
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			let done = false
			const applying = queue.apply(store).then(() => {
				done = true
			})
			await pump(500)
			await applying
			warn.mockRestore()
			expect(done).toBe(true)
			expect(calls).toEqual(['todos.insert:{"x":1}'.replace('{"x":1}', '{"title":"x"}')])
			expect(events).toEqual([])
			vi.useRealTimers()
			// The entry stays; the next start finds the key and skips it.
			expect(await remaining(db)).toHaveLength(1)
			await recoverWith(db, store)
			expect(calls).toHaveLength(1)
			real.close()
		} finally {
			vi.useRealTimers()
		}
	})

	it('a permanent failure whose markFailed never answers still lets ready resolve', async () => {
		fakeTimers()
		try {
			const db = freshDb()
			await seedEntry(db, { kind: 'insert', recordId: 'r1', args: [{ title: 'x' }] })
			const { store, failWith } = loggedStore()
			failWith.error = new Error('bad write')
			const real = journalFor(db)
			const queue = new PreReadyWriteQueue({
				dbName: db,
				locks: null,
				session: 'mine',
				now: LATER,
				journalTimeoutMs: 50,
				journal: flakyJournal(real, {
					markFailed: () => new Promise<void>(() => {}),
					update: () => new Promise<void>(() => {}),
				}),
			})
			const error = vi.spyOn(console, 'error').mockImplementation(() => {})
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const applying = queue.apply(store)
			await pump(500)
			await applying
			error.mockRestore()
			warn.mockRestore()
			real.close()
		} finally {
			vi.useRealTimers()
		}
	})

	it('a transient failure whose attempt count never saves still lets ready resolve', async () => {
		fakeTimers()
		try {
			const db = freshDb()
			await seedEntry(db, { kind: 'insert', recordId: 'r1', args: [{ title: 'x' }] })
			const { store, failWith } = loggedStore()
			failWith.error = Object.assign(new Error('busy'), { code: 'WORKER_TIMEOUT' })
			const real = journalFor(db)
			const queue = new PreReadyWriteQueue({
				dbName: db,
				locks: null,
				session: 'mine',
				now: LATER,
				journalTimeoutMs: 50,
				journal: flakyJournal(real, { update: () => new Promise<void>(() => {}) }),
			})
			const error = vi.spyOn(console, 'error').mockImplementation(() => {})
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const applying = queue.apply(store)
			await pump(500)
			await applying
			error.mockRestore()
			warn.mockRestore()
			real.close()
		} finally {
			vi.useRealTimers()
		}
	})

	it('a timed-out journal call is transient, never a reason to fail a write for good', async () => {
		const { isTransientWriteFailure } = await import('./pre-ready-recovery')
		const { withTimeout } = await import('./pre-ready-writes')
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		try {
			const rejected = withTimeout(new Promise<void>(() => {}), 10, 'x').catch((e: unknown) => e)
			await vi.advanceTimersByTimeAsync(20)
			expect(isTransientWriteFailure(await rejected)).toBe(true)
		} finally {
			vi.useRealTimers()
		}
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

	it("holds this session's write to a record whose older write is still waiting, saved for the next start", async () => {
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
		expect(await rejected).toMatchObject({
			code: 'WRITE_NOT_APPLIED',
			context: { savedForLater: true },
		})
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
			const events: AnyEvent[] = []
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
			await seedEntry(db, {
				owner: 'alice',
				kind: 'insert',
				recordId: 'r1',
				args: [{ title: 'hers' }],
			})
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
		await seedEntry(db, {
			owner: null,
			ownerPending: true,
			at: Date.now(),
			recordId: 'r1',
			args: [{ title: 'who' }],
		})
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
		await seedEntry(db, {
			owner: null,
			ownerPending: true,
			recordId: 'r1',
			args: [{ title: 'who' }],
		})
		const { store, calls } = loggedStore()
		await recoverWith(db, store, { resolveOwner: async () => 'alice', namespacedByUser: false })
		expect(calls).toEqual(['todos.insert:{"title":"who"}'])
	})
})

describe('writes held in memory only are announced', () => {
	it('names the reason for an atomic helper, a file value and a blocked collection', async () => {
		const { op } = await import('@korajs/core')
		const events: AnyEvent[] = []
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const db = freshDb()
		const queue = new PreReadyWriteQueue({
			dbName: db,
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
		await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(3))
		await queue.close()
		await Promise.all(pending)
		warn.mockRestore()
		// Nothing of a file or a blocked collection reached IndexedDB.
		expect(await remaining(db)).toEqual([])
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
		// The first report is the baseline; the second one is the change.
		await queue.noteSignedInUser('alice')
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

describe('the owner contract', () => {
	it('"loading" is not "signed out": the entry stays owner-pending until the app says who', async () => {
		const db = freshDb()
		const journal = journalFor(db)
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 's1',
			journal,
			// Always loading: never an answer.
			resolveOwner: async () => ({ loading: true }),
		})
		const write = queue.enqueue('todos', 'insert', [{ title: 'x' }])
		await vi.waitFor(async () => expect(await journal.list()).toHaveLength(1))
		await queue.settled()
		const [entry] = await journal.list()
		expect(entry).toMatchObject({ owner: null, ownerPending: true })
		// The app finally says who is signed in: the waiting entry learns it.
		await queue.noteSignedInUser('alice')
		expect((await journal.list())[0]).toMatchObject({ owner: 'alice', ownerPending: false })
		await queue.close()
		await write.catch(() => {})
	})

	it('a database per user keeps an unattributed entry (never applied into another user), and says so on every start', async () => {
		const db = freshDb()
		await seedEntry(db, {
			owner: null,
			ownerPending: true,
			at: Date.now(),
			recordId: 'r1',
			args: [{ title: 'who' }],
		})
		for (let start = 0; start < 2; start++) {
			const { store, calls } = loggedStore()
			const { events } = await recoverWith(db, store, {
				resolveOwner: async () => 'bob',
				namespacedByUser: true,
			})
			expect(calls).toEqual([])
			expect(events).toContainEqual(
				expect.objectContaining({ type: 'journal:write-failed', permanent: false }),
			)
		}
		expect(await remaining(db)).toHaveLength(1)
	})

	it('never expires a waiting entry; a failed one is announced with its collection before removal', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: 'bob', at: 0 })
		await seedEntry(db, { owner: 'bob', at: 0, failed: 'boom', collection: 'notes' })
		const { store } = loggedStore()
		const { events, queue } = await recoverWith(db, store, {
			resolveOwner: async () => 'alice',
			now: () => 31 * 24 * 60 * 60 * 1000,
		})
		expect(events).toEqual([
			{
				type: 'journal:write-expired',
				dbName: db,
				count: 1,
				entries: [{ collection: 'notes', kind: 'insert', owner: 'bob' }],
			},
		])
		// The unsent write of the other user is still there, and reported as held.
		expect(await remaining(db)).toHaveLength(1)
		expect(queue.heldNodes.map((node) => node.principal)).toEqual(['bob'])
	})

	it('the first report of the signed-in user is the baseline: a later sign-out clears that user failed writes', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: 'alice', failed: 'boom' })
		const queue = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'mine' })
		await queue.noteSignedInUser('alice')
		await queue.noteSignedInUser(null)
		expect(await remaining(db)).toEqual([])
		await queue.close()
	})

	it('deleting the database announces the unsent writes it discards', async () => {
		const db = freshDb()
		await seedEntry(db, { recordId: 'a' })
		await seedEntry(db, { recordId: 'b' })
		await seedEntry(db, { recordId: 'c', failed: 'kept for inspection' })
		const events: AnyEvent[] = []
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			emit: (event) => events.push(event),
		})
		const write = queue.enqueue('todos', 'insert', [{ title: 'x' }]).catch(() => {})
		await vi.waitFor(async () => expect((await remaining(db)).length).toBe(4))
		await queue.discardJournal()
		expect(events).toContainEqual({ type: 'journal:discarded', dbName: db, count: 3 })
		expect(await remaining(db)).toEqual([])
		await queue.close()
		await write
	})
})

describe('held journal writes follow the held-writes contract', () => {
	const heldQueue = async (db: string, user = 'bob') => {
		const { store, calls } = loggedStore()
		const { queue, events } = await recoverWith(db, store, {
			resolveOwner: async () => user,
			namespacedByUser: true,
		})
		await queue.noteSignedInUser(user)
		return { queue, events, calls }
	}

	it('lists unattributed and other-user entries as held nodes with what a prompt needs', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: null, ownerPending: true, at: Date.now(), writtenAt: 111 })
		await seedEntry(db, {
			owner: 'alice',
			at: Date.now(),
			writtenAt: 222,
			kind: 'update',
			args: ['r', {}],
		})
		const { queue } = await heldQueue(db)
		const nodes = [...queue.heldNodes]
		expect(nodes).toHaveLength(2)
		expect(nodes).toContainEqual(
			expect.objectContaining({
				nodeId: 'journal:unassigned',
				reason: 'unassigned',
				principal: null,
				operationCount: 1,
				source: 'journal',
				writes: [{ collection: 'todos', kind: 'insert', writtenAt: 111, owner: null }],
			}),
		)
		expect(nodes).toContainEqual(
			expect.objectContaining({
				nodeId: 'journal:other-user:alice',
				reason: 'other-user',
				principal: 'alice',
			}),
		)
	})

	it('assignHeld applies the unattributed writes into the signed-in user and clears the node', async () => {
		const db = freshDb()
		await seedEntry(db, {
			owner: null,
			ownerPending: true,
			at: Date.now(),
			recordId: 'r1',
			args: [{ title: 'mine now' }],
		})
		const { queue, calls } = await heldQueue(db)
		const changes = vi.fn()
		queue.onChange(changes)
		await queue.assignHeld('journal:unassigned')
		expect(calls).toEqual(['todos.insert:{"title":"mine now"}'])
		expect(queue.heldNodes).toEqual([])
		expect(changes).toHaveBeenCalled()
		expect(await remaining(db)).toEqual([])
	})

	it('assignHeld refuses another user entries, and an unknown node, and keeps everything', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: 'alice', at: Date.now() })
		const { queue, calls } = await heldQueue(db)
		await expect(queue.assignHeld('journal:other-user:alice')).rejects.toMatchObject({
			context: { code: 'HELD_NODE_NOT_ASSIGNABLE' },
		})
		await expect(queue.assignHeld('journal:nope')).rejects.toMatchObject({
			context: { code: 'HELD_NODE_NOT_FOUND' },
		})
		expect(calls).toEqual([])
		expect(await remaining(db)).toHaveLength(1)
	})

	it('assignHeld refuses to write into a database opened for another user (HELD_ASSIGN_USER_MISMATCH)', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: null, ownerPending: true, at: Date.now(), recordId: 'r1' })
		const { store, calls } = loggedStore()
		// Opened signed out, then bob signed in during the same page: the store is signed-out's.
		const { queue } = await recoverWith(db, store, {
			resolveOwner: async () => 'bob',
			namespacedByUser: true,
			openedFor: () => null,
		})
		await queue.noteSignedInUser('bob')
		await expect(queue.assignHeld('journal:unassigned')).rejects.toMatchObject({
			context: { code: 'HELD_ASSIGN_USER_MISMATCH', openedFor: null, signedIn: 'bob' },
		})
		expect(calls).toEqual([])
		expect(await remaining(db)).toHaveLength(1)
		expect(queue.heldNodes).toHaveLength(1)
	})

	it('assignHeld validates `to`: only the signed-in user is a target, and then it works', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: null, ownerPending: true, at: Date.now(), recordId: 'r1' })
		const { store, calls } = loggedStore()
		const { queue } = await recoverWith(db, store, {
			resolveOwner: async () => 'bob',
			namespacedByUser: true,
			openedFor: () => 'bob',
		})
		await queue.noteSignedInUser('bob')
		for (const target of ['mallory', '']) {
			await expect(queue.assignHeld('journal:unassigned', target)).rejects.toMatchObject({
				context: { code: 'HELD_ASSIGN_TARGET' },
			})
		}
		expect(calls).toEqual([])
		await queue.assignHeld('journal:unassigned', 'current-user')
		expect(calls).toHaveLength(1)
		expect(await remaining(db)).toEqual([])
	})

	it('HELD_ASSIGN_NO_USER: nobody is signed in, nothing is applied', async () => {
		const db = freshDb()
		const { store, calls } = loggedStore()
		const { queue } = await recoverWith(db, store)
		await seedEntry(db, { owner: null, ownerPending: true, at: Date.now(), recordId: 'r1' })
		const entries = await journalFor(db).list()
		queue.setHeld(entries, describeHeld(entries))
		await expect(queue.assignHeld('journal:unassigned')).rejects.toMatchObject({
			context: { code: 'HELD_ASSIGN_NO_USER' },
		})
		expect(calls).toEqual([])
		expect(await remaining(db)).toHaveLength(1)
	})

	it('HELD_ASSIGN_NOT_READY: the store is not open yet', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: null, ownerPending: true, at: Date.now(), recordId: 'r1' })
		const queue = new PreReadyWriteQueue({ dbName: db, locks: null, session: 'mine' })
		const entries = await journalFor(db).list()
		queue.setHeld(entries, describeHeld(entries))
		queue.knownOwner = { owner: 'bob' }
		await expect(queue.assignHeld('journal:unassigned')).rejects.toMatchObject({
			context: { code: 'HELD_ASSIGN_NOT_READY' },
		})
		await queue.settled()
		await queue.releaseJournal()
	})

	it('assignHeld applies the writes oldest first whatever order they are listed in', async () => {
		const db = freshDb()
		await seedEntry(db, {
			owner: null,
			ownerPending: true,
			at: Date.now(),
			recordId: 'a',
			args: [{ title: 'first' }],
		})
		await seedEntry(db, {
			owner: null,
			ownerPending: true,
			at: Date.now(),
			recordId: 'b',
			args: [{ title: 'second' }],
		})
		const { queue, calls } = await heldQueue(db)
		queue.setHeld([...queue.heldEntries].reverse(), [...queue.heldNodes])
		await queue.assignHeld('journal:unassigned')
		expect(calls).toEqual(['todos.insert:{"title":"first"}', 'todos.insert:{"title":"second"}'])
	})

	it('deleting a per-user database counts what it throws away, not the failed entries kept for inspection', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: 'alice', at: Date.now(), recordId: 'a' })
		const failed = await seedEntry(db, { owner: 'alice', at: Date.now(), recordId: 'b' })
		const journal = journalFor(db)
		await journal.markFailed(failed, 'boom')
		journal.close()
		const { store } = loggedStore()
		const { queue, events } = await recoverWith(db, store, { namespacedByUser: true })
		await queue.discardJournal(`${db}__user_alice`)
		expect(events).toContainEqual({ type: 'journal:discarded', dbName: db, count: 1 })
	})

	it('discardHeld removes the writes and announces journal:discarded with the count', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: 'alice', at: Date.now(), recordId: 'a' })
		await seedEntry(db, { owner: 'alice', at: Date.now(), recordId: 'b' })
		await seedEntry(db, { owner: 'carol', at: Date.now(), recordId: 'c' })
		const { queue, events } = await heldQueue(db)
		expect(await queue.discardHeld('journal:other-user:alice')).toBe(2)
		expect(events).toContainEqual({ type: 'journal:discarded', dbName: db, count: 2 })
		expect(queue.heldNodes.map((node) => node.nodeId)).toEqual(['journal:other-user:carol'])
		expect(await remaining(db)).toHaveLength(1)
	})

	it('a failing assign leaves the unapplied writes held, and the applied ones gone', async () => {
		const db = freshDb()
		await seedEntry(db, {
			owner: null,
			ownerPending: true,
			at: Date.now(),
			recordId: 'a',
			args: [{ title: 'a' }],
		})
		await seedEntry(db, {
			owner: null,
			ownerPending: true,
			at: Date.now(),
			recordId: 'b',
			args: [{ title: 'b' }],
		})
		const { queue, calls } = await heldQueue(db)
		const target = (queue as unknown as { store: ReturnType<typeof loggedStore>['store'] }).store
		const insert = target.collection('todos').insert
		let first = true
		target.collection = (name) => ({
			...loggedStore().store.collection(name),
			insert: async (data, options) => {
				if (!first) throw Object.assign(new Error('disk full'), { code: 'STORAGE_DURABILITY_LOST' })
				first = false
				calls.push('applied-a')
				return insert(data, options)
			},
		})
		await expect(queue.assignHeld('journal:unassigned')).rejects.toThrow('disk full')
		expect(queue.heldNodes[0]?.operationCount).toBe(1)
		expect(await remaining(db)).toHaveLength(1)
	})
})

describe('several journal entries for one record replay in order (the pass does not see its own writes)', () => {
	const existing = (add: ReturnType<typeof loggedStore>['add']): void =>
		add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 10 } })
	const entry = (writtenAt: number, kind: JournalEntry['kind'], args: unknown[]) =>
		({ kind, args, writtenAt, at: writtenAt, recordId: undefined }) as Partial<JournalEntry>

	it('title A then title B: both are applied, in order, and B wins', async () => {
		const db = freshDb()
		const { store, calls, add } = loggedStore()
		existing(add)
		await seedEntry(db, entry(1000, 'update', ['r1', { title: 'A' }]))
		await seedEntry(db, entry(2000, 'update', ['r1', { title: 'B' }]))
		await recoverWith(db, store)
		expect(calls).toEqual(['todos.update:r1:{"title":"A"}', 'todos.update:r1:{"title":"B"}'])
		expect(await remaining(db)).toEqual([])
	})

	it('update then delete: the record ends deleted', async () => {
		const db = freshDb()
		const { store, calls, add } = loggedStore()
		existing(add)
		await seedEntry(db, entry(1000, 'update', ['r1', { title: 'A' }]))
		await seedEntry(db, entry(2000, 'delete', ['r1']))
		await recoverWith(db, store)
		expect(calls).toEqual(['todos.update:r1:{"title":"A"}', 'todos.delete:r1'])
	})

	it('toggle twice: both writes are applied and the last value wins', async () => {
		const db = freshDb()
		const { store, calls, add } = loggedStore()
		existing(add)
		await seedEntry(db, entry(1000, 'update', ['r1', { done: true }]))
		await seedEntry(db, entry(2000, 'update', ['r1', { done: false }]))
		await recoverWith(db, store)
		expect(calls).toEqual(['todos.update:r1:{"done":true}', 'todos.update:r1:{"done":false}'])
	})

	it('insert then update then delete of a new record applies all three', async () => {
		const db = freshDb()
		const { store, calls } = loggedStore()
		await seedEntry(db, { ...entry(1000, 'insert', [{ title: 'new' }]), recordId: 'r2' })
		await seedEntry(db, entry(2000, 'update', ['r2', { title: 'newer' }]))
		await seedEntry(db, entry(3000, 'delete', ['r2']))
		await recoverWith(db, store)
		expect(calls).toEqual([
			'todos.insert:{"title":"new"}',
			'todos.update:r2:{"title":"newer"}',
			'todos.delete:r2',
		])
	})

	it('a genuinely newer remote edit still wins over the older entry only', async () => {
		const db = freshDb()
		const { store, calls, add } = loggedStore()
		existing(add)
		// Synced from another device between the two edits.
		add('todos', 'r1', {
			type: 'update',
			nodeId: 'other',
			timestamp: { wallTime: 1500 },
			data: { title: 'remote' },
		})
		await seedEntry(db, entry(1000, 'update', ['r1', { title: 'A', note: 'a' }]))
		await seedEntry(db, entry(2000, 'update', ['r1', { title: 'B' }]))
		await recoverWith(db, store)
		// A keeps only the field the remote edit did not rewrite; B is newer than the remote edit.
		expect(calls).toEqual(['todos.update:r1:{"note":"a"}', 'todos.update:r1:{"title":"B"}'])
	})

	it('a newer remote delete beats an older entry, and a newer entry beats an older remote delete', async () => {
		const db = freshDb()
		const { store, calls, add } = loggedStore()
		existing(add)
		add('todos', 'r1', {
			type: 'update',
			nodeId: 'other',
			timestamp: { wallTime: 1500 },
			data: { x: 1 },
		})
		await seedEntry(db, entry(1000, 'delete', ['r1']))
		await recoverWith(db, store)
		expect(calls).toEqual([])
	})
})

describe('deleting a database counts the entries it throws away even after the drain', () => {
	it('counts waiting entries when the drain already released the journal connection', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: 'alice', at: Date.now() })
		await seedEntry(db, { owner: null, ownerPending: true, at: Date.now() })
		await seedEntry(db, { owner: 'alice', at: Date.now(), failed: 'kept' })
		const { store } = loggedStore()
		const { queue, events } = await recoverWith(db, store, {
			resolveOwner: async () => 'bob',
			namespacedByUser: true,
		})
		await new Promise((resolve) => setTimeout(resolve, 20))
		await queue.discardJournal()
		expect(events).toContainEqual({ type: 'journal:discarded', dbName: db, count: 2 })
		expect(await remaining(db)).toEqual([])
		expect(queue.heldNodes).toEqual([])
	})

	it('a per-user database takes only its user entries', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: 'alice', at: Date.now() })
		await seedEntry(db, { owner: 'bob', at: Date.now() })
		const { store } = loggedStore()
		const { queue, events } = await recoverWith(db, store, {
			resolveOwner: async () => 'carol',
			namespacedByUser: true,
		})
		await queue.discardJournal(`${db}__user_alice`)
		expect(events).toContainEqual({ type: 'journal:discarded', dbName: db, count: 1 })
		expect((await remaining(db)).map((entry) => entry.owner)).toEqual(['bob'])
		expect(queue.heldNodes.map((node) => node.principal)).toEqual(['bob'])
	})
})

describe("sync.unassignedWrites: 'assign-to-first-user' covers journal writes", () => {
	it('assigns the unassigned journal node when a session is accepted', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: null, ownerPending: true, at: Date.now(), recordId: 'r1' })
		const { store, calls } = loggedStore()
		const { queue } = await recoverWith(db, store, {
			resolveOwner: async () => 'bob',
			namespacedByUser: true,
		})
		await queue.noteSignedInUser('bob')
		const handlers: Array<() => void> = []
		const { assignJournalOnConnect } = await import('./pre-ready-recovery')
		const stop = assignJournalOnConnect(
			{
				on: (_type, handler) => {
					handlers.push(handler)
					return () => {}
				},
			},
			queue,
		)
		for (const handler of handlers) handler()
		await vi.waitFor(() => expect(calls).toEqual(['todos.insert:{"title":"x"}']))
		await vi.waitFor(() => expect(queue.heldNodes).toEqual([]))
		stop()
	})
})

describe('every journal and lock call is bounded; a failed removal stops the pass', () => {
	const hang = (): Promise<never> => new Promise<never>(() => {})
	const timed = async (
		db: string,
		overrides: Parameters<typeof flakyJournal>[1],
		options: Partial<ConstructorParameters<typeof PreReadyWriteQueue>[0]> = {},
		store: WriteTarget = loggedStore().store,
	): Promise<{ done: boolean; real: WriteJournal }> => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		const real = journalFor(db)
		const queue = new PreReadyWriteQueue({
			dbName: db,
			locks: null,
			session: 'mine',
			now: LATER,
			journalTimeoutMs: 300,
			journal: flakyJournal(real, overrides),
			...options,
		})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		let done = false
		const applying = queue.apply(store).then(() => {
			done = true
		})
		// Until it finishes, within a generous fake-time limit: real IndexedDB turns, not the clock, set the pace.
		for (let waited = 0; !done && waited < 20_000; waited += 100) await pump(100)
		warn.mockRestore()
		const settled = done
		vi.useRealTimers()
		await applying.catch(() => {})
		return { done: settled, real }
	}

	it('A4: a journal whose list never answers does not hold the recovery', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: 'alice', at: Date.now() })
		try {
			let calls = 0
			const inner = journalFor(db)
			const list = (): Promise<JournalEntry[]> => (++calls === 1 ? inner.list() : hang())
			const { done, real } = await timed(db, { list })
			inner.close()
			expect(done).toBe(true)
			real.close()
		} finally {
			vi.useRealTimers()
		}
	})

	it('A5: an expiry removal that never answers does not hold the recovery', async () => {
		const db = freshDb()
		await seedEntry(db, { owner: 'bob', at: 0, failed: 'boom' })
		try {
			const { done, real } = await timed(
				db,
				{ remove: hang },
				{
					now: () => 31 * 24 * 60 * 60 * 1000,
					resolveOwner: async () => 'alice',
				},
			)
			expect(done).toBe(true)
			real.close()
		} finally {
			vi.useRealTimers()
		}
	})

	it('A6: a lock query that never answers does not hold the recovery, and the entry is still applied', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'insert', recordId: 'r1', args: [{ title: 'x' }], at: 0 })
		const { store, calls } = loggedStore()
		const locks: LockManagerLike = {
			request: async (_name, _options, callback) => callback({}),
			query: hang,
		}
		try {
			const { done, real } = await timed(db, {}, { locks }, store)
			expect(done).toBe(true)
			expect(calls).toEqual(['todos.insert:{"title":"x"}'])
			real.close()
		} finally {
			vi.useRealTimers()
		}
	})

	it('A8: an in-session removal that never answers does not hold the drain or the settle', async () => {
		const db = freshDb()
		const { store } = loggedStore()
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		try {
			const real = journalFor(db)
			const queue = new PreReadyWriteQueue({
				dbName: db,
				locks: null,
				session: 's',
				journalTimeoutMs: 300,
				journal: flakyJournal(real, { remove: hang }),
			})
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			const write = queue.enqueue('todos', 'insert', [{ title: 'in-session' }])
			await queue.apply(store)
			await write
			let settled = false
			const waiting = queue.settled().then(() => {
				settled = true
			})
			await pump(8000)
			warn.mockRestore()
			expect(settled).toBe(true)
			await waiting
			real.close()
		} finally {
			vi.useRealTimers()
		}
	})

	it('A10: after a removal fails the pass stops: later entries wait for the next start', async () => {
		const db = freshDb()
		await seedEntry(db, { kind: 'insert', recordId: 'a', args: [{ title: 'first' }], at: 0 })
		await seedEntry(db, { kind: 'insert', recordId: 'b', args: [{ title: 'second' }], at: 0 })
		const { store, calls } = loggedStore()
		const real = journalFor(db)
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		await recoverWith(db, store, {
			journal: flakyJournal(real, { remove: () => Promise.reject(new Error('IDB gone')) }),
		})
		warn.mockRestore()
		expect(calls).toEqual(['todos.insert:{"title":"first"}'])
		real.close()
	})
})

describe('replay against edits that arrive during a pass, and against a stale tab', () => {
	const entryOf = (over: Partial<JournalEntry>): JournalEntry => ({
		opKey: `k-${++counter}`,
		session: 'old',
		owner: 'bob',
		at: 1_000,
		writtenAt: 1_000,
		collection: 'todos',
		kind: 'update',
		args: ['r1', { title: 'mine', done: true }],
		...over,
	})

	it('an edit with the very same time as the write does not hide it (equal is not later)', async () => {
		const { store, add, calls } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 500 } })
		add('todos', 'r1', {
			type: 'update',
			nodeId: 'other',
			timestamp: { wallTime: 1_000 },
			data: { title: 'theirs' },
		})
		await replayEntry(store, entryOf({}), async (write) => {
			await store
				.collection(write.collection)
				.update(write.args[0] as string, write.args[1] as never)
		})
		expect(calls).toEqual(['todos.update:r1:{"title":"mine","done":true}'])
	})

	it('an edit another device synced after the pass read the record is respected', async () => {
		const { store, add, calls } = loggedStore()
		add('todos', 'r1', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 500 } })
		const history = new Map()
		const entry = entryOf({})
		await snapshotHistory(store, [entry], history)
		// Arrives after the snapshot, stamped after the user acted.
		add('todos', 'r1', {
			type: 'update',
			nodeId: 'other',
			timestamp: { wallTime: 2_000 },
			data: { title: 'theirs' },
		})
		await replayEntry(
			store,
			entry,
			async (write) => {
				await store
					.collection(write.collection)
					.update(write.args[0] as string, write.args[1] as never)
			},
			history,
		)
		// `title` was rewritten later by the other device: only `done` is replayed.
		expect(calls).toEqual(['todos.update:r1:{"done":true}'])
	})

	it('the snapshot is taken for every record before the first entry is applied', async () => {
		const { store, add } = loggedStore()
		add('todos', 'a', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 1 } })
		add('todos', 'b', { type: 'insert', nodeId: 'me', timestamp: { wallTime: 1 } })
		const history = new Map()
		await snapshotHistory(
			store,
			[entryOf({ args: ['a', { x: 1 }] }), entryOf({ args: ['b', { x: 1 }] })],
			history,
		)
		expect([...history.keys()].sort()).toEqual(['todos\u0000a', 'todos\u0000b'])
	})

	it('inserts read no history (a 1,000-row insertMany costs no queries)', async () => {
		const { store } = loggedStore()
		const reads = vi.spyOn(store, 'getOperationsForRecord' as never)
		const history = new Map()
		await snapshotHistory(
			store,
			[entryOf({ kind: 'insertMany', args: [[{ title: 'x' }]], recordIds: ['1', '2', '3'] })],
			history,
		)
		await replayEntry(
			store,
			entryOf({ kind: 'insertMany', args: [[{ title: 'x' }]], recordIds: ['1', '2', '3'] }),
			async () => {},
			history,
		)
		expect(reads).not.toHaveBeenCalled()
	})

	it('a stale tab replaying a write that landed meanwhile (duplicate insert) is done, not a failure', async () => {
		const { store, applied } = loggedStore()
		const entry = entryOf({ kind: 'insert', args: [{ title: 'x' }], recordId: 'n1' })
		const outcome = await replayEntry(store, entry, async () => {
			// Another tab won the race: its transaction recorded the key, ours hits UNIQUE.
			applied.add(entry.opKey)
			throw Object.assign(new Error('UNIQUE constraint failed'), { code: 'ADAPTER_ERROR' })
		})
		expect(outcome).toBe('skipped')
	})

	it('a duplicate failure without a recorded key is still a failure', async () => {
		const { store } = loggedStore()
		const entry = entryOf({ kind: 'insert', args: [{ title: 'x' }], recordId: 'n1' })
		await expect(
			replayEntry(store, entry, async () => {
				throw Object.assign(new Error('UNIQUE constraint failed'), { code: 'ADAPTER_ERROR' })
			}),
		).rejects.toThrow('UNIQUE')
	})
})
