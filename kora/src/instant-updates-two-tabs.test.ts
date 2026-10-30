import { defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { Store } from '@korajs/store'
import { SqliteWasmAdapter } from '@korajs/store/sqlite-wasm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
	MockBroadcastChannel,
	MockLockManager,
	MockSqliteWorker,
	flushMicrotasks,
	waitUntil,
} from '../../packages/store/tests/fixtures/browser-sim'
import { wireLocalOperationBus } from './local-operation-bus'

/*
 * Instant-UI S5, design section 8 (multi-tab): the overlay is tab-local.
 *
 * Two tabs of one app share one database: the first is the storage leader (it owns the
 * worker), the second a follower whose requests are relayed to the leader's worker. Every
 * tab runs the real Store with `instantUpdates`, the real storage election over mock Web
 * Locks, the real follower RPC over a mock BroadcastChannel, and the real cross-tab bus
 * (`wireLocalOperationBus`) that tells the other tabs about COMMITTED changes. The worker's
 * COMMIT is held by the test, so "before the commit" is a state the test can stand in and
 * look at, with no timers.
 */

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), done: t.boolean().default(false) } } },
})

let dbCounter = 0

interface Tab {
	readonly name: string
	readonly store: Store
	readonly adapter: SqliteWasmAdapter
	/** Title lists the tab's live query delivered, oldest first. */
	readonly deliveries: string[][]
	close(): Promise<void>
}

async function openTab(name: string, dbName: string): Promise<Tab> {
	const emitter = new SimpleEventEmitter()
	const adapter = new SqliteWasmAdapter({ dbName, workerUrl: '/worker.js', emitter })
	const store = new Store({
		schema,
		adapter,
		dbName,
		nodeId: `node-${name}`,
		emitter,
		instantUpdates: true,
	})
	await store.open()
	const stopBus = wireLocalOperationBus(dbName, store, emitter)
	const deliveries: string[][] = []
	const unsubscribe = store
		.collection('todos')
		.where({})
		.orderBy('title', 'asc')
		.subscribe((rows) => {
			deliveries.push(rows.map((row) => String(row.title)))
		})
	await waitUntil(() => deliveries.length > 0, `${name} first delivery`)
	return {
		name,
		store,
		adapter,
		deliveries,
		close: async () => {
			unsubscribe()
			stopBus()
			await store.close()
		},
	}
}

const shown = (tab: Tab): string[] => tab.deliveries[tab.deliveries.length - 1] ?? []

function posted(type: string): number {
	return MockBroadcastChannel.posted.filter(
		(entry) => (entry.data as { type?: string })?.type === type,
	).length
}

/** Holds each worker COMMIT until the test releases it, in the order they arrive. */
function holdCommits(): { reached(): number; release(): Promise<void> } {
	const waiting: Array<() => void> = []
	let released = 0
	MockSqliteWorker.intercept = (_worker, request) => {
		if (request.type !== 'commit') return undefined
		return new Promise<void>((resolve) => {
			waiting.push(resolve)
		})
	}
	return {
		reached: () => waiting.length,
		release: async () => {
			const next = waiting[released]
			if (!next) throw new Error('no commit is waiting')
			released++
			next()
			await flushMicrotasks()
		},
	}
}

/** What a fresh read of the database returns, from a tab. */
async function rowsOf(tab: Tab): Promise<string[]> {
	const rows = await tab.store.collection('todos').where({}).orderBy('title', 'asc').exec()
	return rows.map((row) => String(row.title))
}

describe('instant updates across two tabs', () => {
	beforeEach(() => {
		const locks = new MockLockManager()
		MockBroadcastChannel.reset()
		MockSqliteWorker.reset()
		vi.stubGlobal('navigator', { locks })
		vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
		vi.stubGlobal('Worker', MockSqliteWorker)
		let id = 0
		vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
			() => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
		)
		dbCounter += 1
	})

	afterEach(() => {
		MockSqliteWorker.intercept = null
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	test('the tabs elect one leader and one follower', async () => {
		const dbName = `two-tabs-${dbCounter}`
		const leader = await openTab('leader', dbName)
		const follower = await openTab('follower', dbName)
		expect(leader.adapter.isLeader()).toBe(true)
		expect(follower.adapter.isLeader()).toBe(false)
		await follower.close()
		await leader.close()
	})

	test('a follower write: the follower shows it at once, the leader tab only after the commit and the bus message', async () => {
		const dbName = `two-tabs-${dbCounter}`
		const leader = await openTab('leader', dbName)
		const follower = await openTab('follower', dbName)
		const commits = holdCommits()

		const write = follower.store.collection('todos').insert({ title: 'from follower' })
		await waitUntil(() => commits.reached() === 1, 'the follower write reaching COMMIT')
		await flushMicrotasks()

		// Before the commit: this tab shows the prediction, the other tab cannot know of it and
		// nothing was announced on the bus (it announces only committed operations).
		expect(shown(follower)).toEqual(['from follower'])
		expect(shown(leader)).toEqual([])
		expect(posted('kora-local-operation')).toBe(0)
		expect(posted('kora-records-changed')).toBe(0)
		expect(follower.store.getOverlayController()?.pending).toBe(1)
		expect(leader.store.getOverlayController()?.pending).toBe(0)

		await commits.release()
		await write
		await waitUntil(() => shown(leader).length === 1, 'the leader tab hearing the commit')

		expect(posted('kora-local-operation')).toBe(1)
		expect(shown(leader)).toEqual(['from follower'])
		expect(shown(follower)).toEqual(['from follower'])
		expect(await rowsOf(leader)).toEqual(['from follower'])
		expect(await rowsOf(follower)).toEqual(['from follower'])
		expect(follower.store.getOverlayController()?.pending).toBe(0)
		await follower.close()
		await leader.close()
	})

	test('a leader write: the leader shows it at once, the follower only after the commit and the bus message', async () => {
		const dbName = `two-tabs-${dbCounter}`
		const leader = await openTab('leader', dbName)
		const follower = await openTab('follower', dbName)
		const commits = holdCommits()

		const write = leader.store.collection('todos').insert({ title: 'from leader' })
		await waitUntil(() => commits.reached() === 1, 'the leader write reaching COMMIT')
		await flushMicrotasks()

		expect(shown(leader)).toEqual(['from leader'])
		expect(shown(follower)).toEqual([])
		expect(posted('kora-local-operation')).toBe(0)

		await commits.release()
		await write
		await waitUntil(() => shown(follower).length === 1, 'the follower tab hearing the commit')

		expect(posted('kora-local-operation')).toBe(1)
		expect(shown(follower)).toEqual(['from leader'])
		expect(await rowsOf(follower)).toEqual(['from leader'])
		expect(await rowsOf(leader)).toEqual(['from leader'])
		await follower.close()
		await leader.close()
	})

	test('a write that fails at COMMIT: the writing tab shows it and then takes it back, the other tab never sees it', async () => {
		const dbName = `two-tabs-${dbCounter}`
		const leader = await openTab('leader', dbName)
		const follower = await openTab('follower', dbName)
		let failed = false
		MockSqliteWorker.intercept = (_worker, request) => {
			if (request.type !== 'commit' || failed) return undefined
			failed = true
			throw new Error('injected: commit failed')
		}

		await expect(
			follower.store.collection('todos').insert({ title: 'doomed' }),
		).rejects.toBeDefined()
		await flushMicrotasks()

		// The follower showed it (a delivery with the row exists) and no longer does.
		expect(follower.deliveries.some((titles) => titles.includes('doomed'))).toBe(true)
		expect(shown(follower)).toEqual([])
		// The leader tab never had a reason to show it, and nothing was announced.
		expect(leader.deliveries.every((titles) => !titles.includes('doomed'))).toBe(true)
		expect(posted('kora-local-operation')).toBe(0)
		expect(await rowsOf(leader)).toEqual([])
		expect(follower.store.getOverlayController()?.pending).toBe(0)
		await follower.close()
		await leader.close()
	})

	test('concurrent writes in both tabs: each tab shows only its own until it hears the other commit; both converge', async () => {
		const dbName = `two-tabs-${dbCounter}`
		const leader = await openTab('leader', dbName)
		const follower = await openTab('follower', dbName)
		const commits = holdCommits()

		const leaderWrite = leader.store.collection('todos').insert({ title: 'b leader' })
		await waitUntil(() => commits.reached() === 1, 'the leader write reaching COMMIT')
		// The follower's transaction queues behind the leader's on the one worker.
		const followerWrite = follower.store.collection('todos').insert({ title: 'a follower' })
		await flushMicrotasks()

		expect(shown(leader)).toEqual(['b leader'])
		expect(shown(follower)).toEqual(['a follower'])
		expect(posted('kora-local-operation')).toBe(0)

		await commits.release()
		await leaderWrite
		await waitUntil(() => commits.reached() === 2, 'the follower write reaching COMMIT')
		// The leader's commit is out and announced, but the follower's own transaction is now open
		// on the one worker, so the read that would show the leader's row queues behind it: the
		// follower keeps showing only its own prediction until its commit lands.
		expect(posted('kora-local-operation')).toBe(1)
		await flushMicrotasks()
		expect(shown(follower)).toEqual(['a follower'])
		expect(shown(leader)).toEqual(['b leader'])

		await commits.release()
		await followerWrite
		await waitUntil(() => shown(leader).length === 2, 'the leader hearing the follower commit')
		await waitUntil(() => shown(follower).length === 2, 'the follower reading both rows')
		expect(shown(leader)).toEqual(['a follower', 'b leader'])
		expect(shown(follower)).toEqual(['a follower', 'b leader'])
		expect(await rowsOf(leader)).toEqual(['a follower', 'b leader'])
		expect(await rowsOf(follower)).toEqual(['a follower', 'b leader'])
		expect(posted('kora-local-operation')).toBe(2)
		await follower.close()
		await leader.close()
	})
})
