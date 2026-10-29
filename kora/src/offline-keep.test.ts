import { type BlobRef, OFFLINE_PIN_LIMIT, createBlobRef, defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import {
	BlobIntegrityError,
	BlobTransferError,
	MemoryBlobStore,
	Store,
	parseTabLockName,
	tabLockName,
} from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import type { SyncEngine, SyncQuerySubset } from '@korajs/sync'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeLockManager } from '../tests/support/fake-lock-manager'
import { type OfflineKeep, createOfflineKeep, offlineFilesLockName } from './offline-keep'
import type { OfflineHoldMode, TabCoordination } from './offline-tab-coordination'

const schema = defineSchema({
	version: 1,
	collections: {
		lessons: {
			fields: { title: t.string(), courseId: t.string(), video: t.blob().optional() },
		},
		quizzes: { fields: { title: t.string(), courseId: t.string() } },
		courses: { fields: { title: t.string() } },
	},
})

const DB = 'db'

/** The sync engine as far as the pins touch it. */
function fakeEngine() {
	const subsetCalls: SyncQuerySubset[][] = []
	const listeners = new Set<() => void>()
	const state = { complete: false, status: 'offline' }
	const engine = {
		setPinQuerySubsets: (subsets: SyncQuerySubset[]) => {
			subsetCalls.push(subsets)
		},
		onStatusChange: (listener: () => void) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		getStatus: () => ({ status: state.status, phase: state.status }),
		getOfflineData: () => ({ state: state.complete ? 'complete' : 'incomplete' }),
	} as unknown as SyncEngine
	return {
		engine,
		subsetCalls,
		state,
		get lastSubsets(): SyncQuerySubset[] | undefined {
			return subsetCalls[subsetCalls.length - 1]
		},
		change() {
			for (const listener of [...listeners]) listener()
		},
	}
}

type Fake = ReturnType<typeof fakeEngine>

interface Context {
	store: Store
	locks: FakeLockManager
	blobStore: MemoryBlobStore
	server: Map<string, Uint8Array>
}

interface Tab {
	id: string
	keep: OfflineKeep
	coordination: TabCoordination
	engine: Fake
	pulls: string[]
	persistence: { requestInBackground: ReturnType<typeof vi.fn> }
	lock: { release: () => void }
	resume(): void
	pullImpl: { current: (ref: BlobRef) => Promise<unknown> }
	estimate: { current: () => Promise<{ usage?: number; quota?: number } | null> }
	dataComplete: { current: boolean }
}

let context: Context
let tabs: Tab[] = []
let openSeq = 0

async function turns(count: number): Promise<void> {
	for (let i = 0; i < count; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Let queued work, lock grants and file passes finish: by turns, then by asking each tab. */
async function flush(): Promise<void> {
	for (let round = 0; round < 3; round++) {
		await turns(5)
		for (const tab of tabs) await tab.keep.whenIdle()
	}
}

async function openTab(
	id: string,
	options: { mode?: OfflineHoldMode; blobStore?: MemoryBlobStore } = {},
): Promise<Tab> {
	const mode = options.mode ?? 'locks'
	const identity = { build: 'b', format: 1, openSeq: ++openSeq, tabId: id }
	const lockName = tabLockName(DB, identity)
	const lock = context.locks.hold(lockName)
	await flush()
	const resumeListeners = new Set<() => void>()
	const coordination: TabCoordination = {
		mode,
		tabId: id,
		tabLock: () => lockName,
		locks: context.locks,
		parseTabLock: (name) => parseTabLockName(DB, name)?.tabId ?? null,
		onResume(listener) {
			resumeListeners.add(listener)
			return () => resumeListeners.delete(listener)
		},
	}
	const engine = fakeEngine()
	const pulls: string[] = []
	const blobStore = options.blobStore ?? context.blobStore
	const pullImpl = {
		current: async (ref: BlobRef): Promise<void> => {
			const bytes = context.server.get(ref.hash)
			if (!bytes) throw new Error(`the server has no ${ref.hash}`)
			await blobStore.put(bytes)
		},
	}
	const estimate: Tab['estimate'] = { current: async () => null }
	const dataComplete = { current: false }
	const persistence = { requestInBackground: vi.fn() }
	const keep = createOfflineKeep({
		dbName: DB,
		emitter: new SimpleEventEmitter(),
		persistence,
		coordination,
		estimate: () => estimate.current(),
		runtime: {
			store: () => context.store,
			engine: () => engine.engine,
			blobStore: () => blobStore,
			pull: async (ref) => {
				pulls.push(ref.hash)
				return pullImpl.current(ref)
			},
			dataComplete: () => dataComplete.current,
		},
	})
	await keep.load()
	await flush()
	const tab: Tab = {
		id,
		keep,
		coordination,
		engine,
		pulls,
		persistence,
		lock,
		resume: () => {
			for (const listener of [...resumeListeners]) listener()
		},
		pullImpl,
		estimate,
		dataComplete,
	}
	tabs.push(tab)
	return tab
}

beforeEach(async () => {
	const store = new Store({ schema, adapter: new BetterSqlite3Adapter(':memory:'), nodeId: 'n1' })
	await store.open()
	context = {
		store,
		locks: new FakeLockManager(),
		blobStore: new MemoryBlobStore(),
		server: new Map(),
	}
	tabs = []
	openSeq = 0
})

afterEach(async () => {
	for (const tab of tabs) await tab.keep.whenIdle()
	for (const tab of tabs) tab.keep.dispose()
	await context.store.close()
})

const lessons = (where: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
	getDescriptor: () => ({ collection: 'lessons', where, ...extra }),
})
const quizzes = (where: Record<string, unknown> = {}) => ({
	getDescriptor: () => ({ collection: 'quizzes', where }),
})

describe('keep(): pins', () => {
	test('refuses limit, offset and include, ignores orderBy', async () => {
		const [tab] = [await openTab('a')]
		for (const extra of [{ limit: 5 }, { offset: 2 }, { include: ['course'] }]) {
			await expect(tab.keep.keep(lessons({}, extra))).rejects.toMatchObject({
				code: 'OFFLINE_KEEP_UNSUPPORTED_QUERY',
			})
		}
		await expect(
			tab.keep.keep(lessons({ courseId: 'c1' }, { orderBy: [{ field: 'title' }] })),
		).resolves.toBeDefined()
		expect(tab.keep.list()).toHaveLength(1)
	})

	test('is idempotent: the same query is the same pin, in this tab and after a restart', async () => {
		const tab = await openTab('a')
		const first = await tab.keep.keep(lessons({ courseId: 'c1' }))
		const again = await tab.keep.keep(lessons({ courseId: 'c1' }))
		expect(again.id).toBe(first.id)
		expect(tab.keep.list()).toEqual([
			expect.objectContaining({ id: first.id, collection: 'lessons', explicit: true, holders: 0 }),
		])

		// A new session reads the pin back and joins it to the sync view before connecting.
		const restarted = await openTab('b')
		expect(restarted.keep.list().map((pin) => pin.id)).toEqual([first.id])
		expect(restarted.engine.lastSubsets).toEqual([
			{ collection: 'lessons', where: { courseId: 'c1' } },
		])
	})

	test('a pin is one collection: three collections are three pins', async () => {
		const tab = await openTab('a')
		await tab.keep.keep(lessons({ courseId: 'c1' }))
		await tab.keep.keep(quizzes({ courseId: 'c1' }))
		await tab.keep.keep(lessons({ courseId: 'c2' }))
		expect(
			tab.keep
				.list()
				.map((pin) => pin.collection)
				.sort(),
		).toEqual(['lessons', 'lessons', 'quizzes'])
		// Two pins on one collection are both delivered.
		expect(tab.engine.lastSubsets).toEqual(
			expect.arrayContaining([
				{ collection: 'lessons', where: { courseId: 'c1' } },
				{ collection: 'lessons', where: { courseId: 'c2' } },
				{ collection: 'quizzes', where: { courseId: 'c1' } },
			]),
		)
	})

	test('operator filters widen the sync subset to the collection but stay in the pin', async () => {
		const tab = await openTab('a')
		await tab.keep.keep(lessons({ title: { $ne: 'zzz' }, courseId: 'c1' }))
		expect(tab.engine.lastSubsets).toEqual([{ collection: 'lessons', where: { courseId: 'c1' } }])
		expect(tab.keep.list()[0]?.where).toEqual({ title: { $ne: 'zzz' }, courseId: 'c1' })
	})

	test('refuses the 65th pin with OFFLINE_PIN_LIMIT, but keeping an existing one still works', async () => {
		const tab = await openTab('a')
		for (let i = 0; i < OFFLINE_PIN_LIMIT; i++) await tab.keep.keep(lessons({ courseId: `c${i}` }))
		expect(tab.keep.list()).toHaveLength(OFFLINE_PIN_LIMIT)
		await expect(tab.keep.keep(lessons({ courseId: 'one-too-many' }))).rejects.toMatchObject({
			name: 'OfflineKeepError',
			code: 'OFFLINE_PIN_LIMIT',
		})
		await expect(tab.keep.hold(lessons({ courseId: 'one-too-many' }))).rejects.toMatchObject({
			code: 'OFFLINE_PIN_LIMIT',
		})
		await expect(tab.keep.keep(lessons({ courseId: 'c0' }))).resolves.toBeDefined()
		expect(tab.keep.list()).toHaveLength(OFFLINE_PIN_LIMIT)
	})

	test('release removes the pin and its subset', async () => {
		const tab = await openTab('a')
		const handle = await tab.keep.keep(lessons({ courseId: 'c1' }))
		await tab.keep.release(handle)
		expect(tab.keep.list()).toEqual([])
		expect(tab.engine.lastSubsets).toEqual([])
		const reopened = await openTab('b')
		expect(reopened.keep.list()).toEqual([])
	})

	test('requests persistent storage in the background only for files', async () => {
		const tab = await openTab('a')
		await tab.keep.keep(lessons({ courseId: 'c1' }))
		expect(tab.persistence.requestInBackground).not.toHaveBeenCalled()
		await tab.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		expect(tab.persistence.requestInBackground).toHaveBeenCalledWith('offline-keep')
	})
})

describe('holds: components', () => {
	test('two components on one query keep the pin until both release', async () => {
		const tab = await openTab('a')
		const first = await tab.keep.hold(lessons({ courseId: 'c1' }))
		const second = await tab.keep.hold(lessons({ courseId: 'c1' }))
		expect(tab.keep.list()).toEqual([expect.objectContaining({ holders: 2, explicit: false })])
		await first()
		expect(tab.keep.list()).toEqual([expect.objectContaining({ holders: 1 })])
		await second()
		expect(tab.keep.list()).toEqual([])
		expect(tab.engine.lastSubsets).toEqual([])
	})

	test('React StrictMode: mount, unmount, mount leaves one hold', async () => {
		const tab = await openTab('a')
		// Effect 1 starts, cleanup 1 runs (release queued behind the hold), effect 2 starts.
		const mount1 = tab.keep.hold(lessons({ courseId: 'c1' }))
		const mount2 = tab.keep.hold(lessons({ courseId: 'c1' }))
		const release1 = await mount1
		const unmount1 = release1()
		const release2 = await mount2
		await unmount1
		expect(tab.keep.list()).toEqual([expect.objectContaining({ holders: 1 })])
		await release2()
		expect(tab.keep.list()).toEqual([])
	})

	test('releasing a hold twice does nothing the second time', async () => {
		const tab = await openTab('a')
		const one = await tab.keep.hold(lessons({ courseId: 'c1' }))
		const two = await tab.keep.hold(lessons({ courseId: 'c1' }))
		await one()
		await one()
		expect(tab.keep.list()).toEqual([expect.objectContaining({ holders: 1 })])
		await two()
	})

	test('an explicit keep survives the hook unmounting', async () => {
		const tab = await openTab('a')
		const handle = await tab.keep.keep(lessons({ courseId: 'c1' }))
		const release = await tab.keep.hold(lessons({ courseId: 'c1' }))
		await release()
		expect(tab.keep.list()).toEqual([expect.objectContaining({ explicit: true, holders: 0 })])
		await tab.keep.release(handle)
		expect(tab.keep.list()).toEqual([])
	})

	test('releasing the explicit keep keeps a pin a component still holds', async () => {
		const tab = await openTab('a')
		const handle = await tab.keep.keep(lessons({ courseId: 'c1' }))
		const release = await tab.keep.hold(lessons({ courseId: 'c1' }))
		await tab.keep.release(handle)
		expect(tab.keep.list()).toEqual([expect.objectContaining({ explicit: false, holders: 1 })])
		await release()
		expect(tab.keep.list()).toEqual([])
	})
})

describe('holds: two tabs', () => {
	test('a pin both tabs hold goes only when both released', async () => {
		const a = await openTab('a')
		const b = await openTab('b')
		const releaseA = await a.keep.hold(lessons({ courseId: 'c1' }))
		await b.keep.reload()
		const releaseB = await b.keep.hold(lessons({ courseId: 'c1' }))
		await a.keep.reload()
		expect(a.keep.list()).toEqual([expect.objectContaining({ holders: 2 })])
		await releaseA()
		await b.keep.reload()
		expect(b.keep.list()).toEqual([expect.objectContaining({ holders: 1 })])
		await releaseB()
		await a.keep.reload()
		expect(a.keep.list()).toEqual([])
		expect(a.engine.lastSubsets).toEqual([])
	})

	test('a killed tab is pruned at the next open, through its missing tab lock', async () => {
		const a = await openTab('a')
		await a.keep.hold(lessons({ courseId: 'c1' }))
		// Tab a is killed: its lock goes and nothing runs on its behalf.
		a.lock.release()
		a.keep.dispose()
		await flush()
		const b = await openTab('b')
		expect(b.keep.list()).toEqual([])
		expect(b.engine.lastSubsets).toEqual([])
	})

	test('a killed tab is pruned by a tab that stays open, through the shared-lock watcher', async () => {
		const a = await openTab('a')
		const b = await openTab('b')
		await a.keep.hold(lessons({ courseId: 'c1' }))
		// B learns of A's hold (the bus message), and starts watching A's tab lock.
		await b.keep.reload()
		await flush()
		expect(b.keep.list()).toEqual([expect.objectContaining({ holders: 1 })])
		expect(b.engine.lastSubsets).toEqual([{ collection: 'lessons', where: { courseId: 'c1' } }])

		// A exits without unmounting: nobody opens, nobody reloads.
		a.lock.release()
		await flush()

		expect(b.keep.list()).toEqual([])
		expect(b.engine.lastSubsets).toEqual([])
		expect(b.keep.snapshot().pins).toBe(0)
	})

	test('a live tab with holds is never pruned', async () => {
		const a = await openTab('a')
		const b = await openTab('b')
		await a.keep.hold(lessons({ courseId: 'c1' }))
		await b.keep.reload()
		await flush()
		expect(b.keep.list()).toHaveLength(1)
		const c = await openTab('c')
		expect(c.keep.list()).toHaveLength(1)
	})

	test('watchers are dropped when the holder tab has no holds left', async () => {
		const a = await openTab('a')
		const b = await openTab('b')
		const release = await a.keep.hold(lessons({ courseId: 'c1' }))
		await b.keep.reload()
		await flush()
		const watching = async () =>
			(await context.locks.query()).pending.filter((lock) => lock.name?.startsWith('kora-tab:'))
		expect(await watching()).toHaveLength(1)
		await release()
		await b.keep.reload()
		await flush()
		expect(await watching()).toHaveLength(0)
	})

	test('bfcache: a suspended tab is pruned, and re-records its mounted holds on resume', async () => {
		const a = await openTab('a')
		const b = await openTab('b')
		const release = await a.keep.hold(lessons({ courseId: 'c1' }), { files: false })
		const before = a.keep.list()[0]?.id
		await b.keep.reload()
		await flush()

		// pagehide: the tab lock is released, the components stay mounted.
		a.lock.release()
		await flush()
		expect(b.keep.list()).toEqual([])

		// pageshow: the lock is back, then the holds are recorded again with the same pin id.
		a.lock = context.locks.hold(a.coordination.tabLock() ?? '')
		await flush()
		a.resume()
		await flush()
		expect(a.keep.list()).toEqual([expect.objectContaining({ id: before, holders: 1 })])
		await b.keep.reload()
		expect(b.keep.list()).toEqual([expect.objectContaining({ id: before, holders: 1 })])

		await release()
		expect(a.keep.list()).toEqual([])
	})

	test('exclusive mode: every hold of another tab is stale at open', async () => {
		const a = await openTab('a', { mode: 'exclusive' })
		await a.keep.hold(lessons({ courseId: 'c1' }))
		a.keep.dispose()
		const b = await openTab('b', { mode: 'exclusive' })
		expect(b.keep.list()).toEqual([])
	})

	test('explicit mode: a hold is an explicit pin released with the last component', async () => {
		const a = await openTab('a', { mode: 'explicit' })
		const one = await a.keep.hold(lessons({ courseId: 'c1' }))
		const two = await a.keep.hold(lessons({ courseId: 'c1' }))
		expect(a.keep.list()).toEqual([expect.objectContaining({ explicit: true, holders: 2 })])
		await one()
		expect(a.keep.list()).toHaveLength(1)
		await two()
		expect(a.keep.list()).toEqual([])
	})

	test('explicit mode: a pin kept by the app outlives its components', async () => {
		const a = await openTab('a', { mode: 'explicit' })
		await a.keep.keep(lessons({ courseId: 'c1' }))
		const release = await a.keep.hold(lessons({ courseId: 'c1' }))
		await release()
		expect(a.keep.list()).toHaveLength(1)
	})
})

describe('handle status', () => {
	test('complete follows the delivery of the data, and whenComplete resolves', async () => {
		const tab = await openTab('a')
		await context.store.collection('lessons').insert({ title: 'one', courseId: 'c1' })
		await context.store.collection('lessons').insert({ title: 'two', courseId: 'c2' })
		const handle = await tab.keep.keep(lessons({ courseId: 'c1' }))
		await flush()
		expect(handle.status()).toMatchObject({ complete: false, records: 1 })
		const seen: boolean[] = []
		handle.subscribe((status) => seen.push(status.complete))
		const done = handle.whenComplete()
		tab.dataComplete.current = true
		tab.engine.change()
		await flush()
		await done
		expect(handle.status().complete).toBe(true)
		expect(seen).toContain(true)
	})

	test('whenComplete rejects with an AbortError when the signal aborts', async () => {
		const tab = await openTab('a')
		const handle = await tab.keep.keep(lessons({ courseId: 'c1' }))
		const controller = new AbortController()
		const waiting = handle.whenComplete({ signal: controller.signal })
		controller.abort()
		await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
		await expect(handle.whenComplete({ signal: controller.signal })).rejects.toMatchObject({
			name: 'AbortError',
		})
	})

	test('whenComplete rejects when the pin is released first', async () => {
		const tab = await openTab('a')
		const handle = await tab.keep.keep(lessons({ courseId: 'c1' }))
		const waiting = handle.whenComplete()
		await tab.keep.release(handle)
		await expect(waiting).rejects.toMatchObject({ code: 'OFFLINE_PIN_RELEASED' })
	})
})

describe('files', () => {
	async function addLesson(bytes: Uint8Array, courseId = 'c1'): Promise<BlobRef> {
		const ref = await createBlobRef(bytes, { filename: 'v.mp4' })
		context.server.set(ref.hash, bytes)
		await context.store.collection('lessons').insert({ title: 'l', courseId, video: ref })
		return ref
	}

	test('a record whose file is not on the device counts as missing, until it is fetched', async () => {
		const tab = await openTab('a')
		tab.pullImpl.current = async () => {
			throw new Error('without an active sync connection')
		}
		const ref = await addLesson(new Uint8Array([1, 2, 3, 4]))
		await tab.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		await flush()
		expect(tab.keep.snapshot()).toMatchObject({
			filesKept: true,
			files: { kept: 0, missing: 1, bytesMissing: ref.size, failed: 0 },
		})
	})

	test('the elected tab fetches missing files and they count as kept', async () => {
		const tab = await openTab('a')
		const ref = await addLesson(new Uint8Array([1, 2, 3, 4]))
		const handle = await tab.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		await flush()
		expect(tab.pulls).toEqual([ref.hash])
		expect(tab.keep.snapshot().files).toEqual({ kept: 1, missing: 0, bytesMissing: 0, failed: 0 })
		expect(handle.status().files).toMatchObject({ done: 1, total: 1, failed: 0, bytesDone: 4 })
		expect(await context.blobStore.has(ref.hash)).toBe(true)
	})

	test('a file already on the device is not fetched again', async () => {
		const tab = await openTab('a')
		const bytes = new Uint8Array([9, 9, 9])
		const ref = await addLesson(bytes)
		await context.blobStore.put(bytes)
		await tab.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		await flush()
		expect(tab.pulls).toEqual([])
		expect(tab.keep.snapshot().files).toEqual({ kept: 1, missing: 0, bytesMissing: 0, failed: 0 })
		expect(ref.size).toBe(3)
	})

	test('a pin without files never looks at the blob store', async () => {
		const tab = await openTab('a')
		await addLesson(new Uint8Array([1]))
		await tab.keep.keep(lessons({ courseId: 'c1' }))
		await flush()
		expect(tab.pulls).toEqual([])
		expect(tab.keep.snapshot()).toMatchObject({ filesKept: false, files: { kept: 0, missing: 0 } })
	})

	test('only the elected tab downloads: two tabs, one fetcher', async () => {
		const a = await openTab('a')
		const b = await openTab('b')
		const ref = await addLesson(new Uint8Array([5, 6, 7]))
		await a.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		await b.keep.reload()
		await flush()
		expect([...a.pulls, ...b.pulls]).toEqual([ref.hash])
		// The lock is held by exactly one tab, and the other waits behind it.
		const state = await context.locks.query()
		const name = offlineFilesLockName(DB)
		expect(state.held.filter((lock) => lock.name === name)).toHaveLength(1)
		expect(state.pending.filter((lock) => lock.name === name)).toHaveLength(1)
	})

	test('when the fetcher tab goes, another tab takes over', async () => {
		const a = await openTab('a')
		const b = await openTab('b')
		a.pullImpl.current = async () => {
			throw new Error('without an active sync connection')
		}
		b.pullImpl.current = async () => {
			throw new Error('without an active sync connection')
		}
		const ref = await addLesson(new Uint8Array([5, 6, 7]))
		await a.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		await b.keep.reload()
		await flush()
		expect(b.pulls).toEqual([])
		a.keep.dispose()
		await flush()
		b.pullImpl.current = async (r) => {
			await context.blobStore.put(context.server.get(r.hash) ?? new Uint8Array())
		}
		b.engine.state.status = 'online'
		b.engine.change()
		await flush()
		expect(b.pulls).toContain(ref.hash)
		expect(b.keep.snapshot().files.missing).toBe(0)
	})

	test('a file that does not hash to its reference is failed (integrity) and removed', async () => {
		class CorruptingStore extends MemoryBlobStore {
			override async get(hash: string): Promise<Uint8Array | null> {
				if (await this.has(hash)) throw new BlobIntegrityError(hash, 'f'.repeat(64))
				return null
			}
		}
		const corrupting = new CorruptingStore()
		const tab = await openTab('a', { blobStore: corrupting })
		const ref = await addLesson(new Uint8Array([1, 2, 3]))
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const handle = await tab.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		await flush()
		expect(tab.keep.snapshot().files).toEqual({ kept: 0, missing: 0, bytesMissing: 0, failed: 1 })
		expect(handle.status().files).toMatchObject({ failed: 1, failedReason: 'integrity' })
		expect(await corrupting.has(ref.hash)).toBe(false)
		warn.mockRestore()
	})

	test('a QuotaExceededError fails the file with reason quota, never silently', async () => {
		const tab = await openTab('a')
		await addLesson(new Uint8Array([1, 2, 3]))
		tab.pullImpl.current = async () => {
			const error = new Error('The quota has been exceeded.')
			error.name = 'QuotaExceededError'
			throw error
		}
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const handle = await tab.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		await flush()
		expect(tab.keep.snapshot().files).toMatchObject({ failed: 1, missing: 0 })
		expect(handle.status().files.failedReason).toBe('quota')
		expect(warn).toHaveBeenCalled()
		warn.mockRestore()
	})

	test('files that cannot fit in the estimated free space fail before downloading', async () => {
		const tab = await openTab('a')
		tab.estimate.current = async () => ({ usage: 95, quota: 100 })
		await addLesson(new Uint8Array(20).fill(7))
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const handle = await tab.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		await flush()
		expect(tab.pulls).toEqual([])
		expect(handle.status().files).toMatchObject({ failed: 1, failedReason: 'quota' })
		warn.mockRestore()
	})

	test('a file nobody holds fails as unavailable and is retried when the connection returns', async () => {
		const tab = await openTab('a')
		const ref = await addLesson(new Uint8Array([4, 4]))
		let attempts = 0
		tab.pullImpl.current = async (r) => {
			attempts++
			if (attempts === 1) {
				throw new BlobTransferError(
					'nobody holds it',
					'BLOB_CHUNK_UNAVAILABLE',
					r.hash,
					1,
					'not-held',
				)
			}
			await context.blobStore.put(context.server.get(r.hash) ?? new Uint8Array())
		}
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const handle = await tab.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		await flush()
		expect(handle.status().files).toMatchObject({ failed: 1, failedReason: 'unavailable' })
		tab.engine.state.status = 'streaming'
		tab.engine.change()
		await flush()
		expect(handle.status().files).toMatchObject({ done: 1, failed: 0 })
		expect(await context.blobStore.has(ref.hash)).toBe(true)
		warn.mockRestore()
	})

	test('offline is not a failure: the file stays missing and nothing is marked failed', async () => {
		const tab = await openTab('a')
		await addLesson(new Uint8Array([8]))
		tab.pullImpl.current = async (r) => {
			throw new BlobTransferError('no connection', 'BLOB_CHUNK_TIMEOUT', r.hash, 0, 'not-connected')
		}
		await tab.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		await flush()
		expect(tab.keep.snapshot().files).toMatchObject({ missing: 1, failed: 0 })
		expect(tab.keep.snapshot().downloading).toBe(false)
	})

	test('a record that arrives later with a file makes the pin missing again at once', async () => {
		const tab = await openTab('a')
		await tab.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		await flush()
		expect(tab.keep.snapshot().files).toEqual({ kept: 0, missing: 0, bytesMissing: 0, failed: 0 })
		tab.pullImpl.current = async () => {
			throw new Error('without an active sync connection')
		}
		await addLesson(new Uint8Array([3, 3, 3]))
		await flush()
		expect(tab.keep.snapshot().files.missing).toBe(1)
	})

	test('the memory blob store is not durable', async () => {
		const tab = await openTab('a')
		expect(tab.keep.snapshot().blobStoreDurable).toBe(false)
	})

	test('before the first look at a files pin, nothing is claimed present', async () => {
		const tab = await openTab('a')
		await addLesson(new Uint8Array([1]))
		let during: ReturnType<OfflineKeep['snapshot']> | null = null
		tab.pullImpl.current = async (ref) => {
			during = tab.keep.snapshot()
			await context.blobStore.put(context.server.get(ref.hash) ?? new Uint8Array())
		}
		await tab.keep.keep(lessons({ courseId: 'c1' }), { files: true })
		await flush()
		expect(during).toMatchObject({ downloading: true })
		expect((during as { files: { missing: number } } | null)?.files.missing).toBe(1)
	})
})
