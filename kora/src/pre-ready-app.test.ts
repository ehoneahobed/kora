import 'fake-indexeddb/auto'
import { defineSchema, t } from '@korajs/core'
import { runAllowingPreReadyWrites } from '@korajs/core/lite'
import type { CollectionAccessor } from '@korajs/store'
import { SyncEngine } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createApp } from './create-app'
import type { KoraApp } from './types'

const schema = defineSchema({
	version: 1,
	collections: {
		lessons: { fields: { title: t.string(), courseId: t.string() } },
		todos: { fields: { title: t.string() } },
		vault: { fields: { label: t.string(), token: t.secret().hashed() } },
	},
})

function accessor(app: KoraApp, name: string): CollectionAccessor {
	return (app as unknown as Record<string, CollectionAccessor>)[name] as CollectionAccessor
}

/** Everything written to IndexedDB (the journal is the only user here), as JSON, in order. */
function recordJournalWrites(): string[] {
	const added: string[] = []
	const original = IDBObjectStore.prototype.add
	vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
		this: IDBObjectStore,
		value: unknown,
		key?: IDBValidKey,
	) {
		added.push(JSON.stringify(value))
		return original.call(this, value, key)
	})
	return added
}

describe('writes made through a hook before the store opens (app level)', () => {
	let app: KoraApp | null = null
	afterEach(async () => {
		await app?.close().catch(() => {})
		app = null
		vi.unstubAllGlobals()
		vi.useRealTimers()
	})

	test('a secret field never reaches the journal in plaintext, and the write still lands', async () => {
		const added = recordJournalWrites()
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		const queued = runAllowingPreReadyWrites(() =>
			accessor(app as KoraApp, 'vault').insert({ label: 'bank', token: 'hunter2-plaintext' }),
		)
		const plain = runAllowingPreReadyWrites(() =>
			accessor(app as KoraApp, 'todos').insert({ title: 'visible-in-journal' }),
		)
		await app.ready
		await Promise.all([queued, plain])
		const seen = added.join('\n')
		expect(seen).toContain('visible-in-journal')
		expect(seen).not.toContain('hunter2')
		expect(seen).not.toContain('bank')
	})

	test('with end-to-end encryption on, nothing is journaled', async () => {
		const added = recordJournalWrites()
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'ws://localhost:1', encryption: { enabled: true, key: 'k' } },
		})
		const queued = runAllowingPreReadyWrites(() =>
			accessor(app as KoraApp, 'todos').insert({ title: 'secret-title-e2e' }),
		)
		await queued.catch(() => {})
		expect(added.join('\n')).not.toContain('secret-title-e2e')
	})

	test('a mutation that awaits one write and makes another is applied whole', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		const todos = accessor(app, 'todos')
		const done = runAllowingPreReadyWrites(async () => {
			await todos.insert({ title: 'a' })
			// Past the first await: outside the scope that opened it, mid-drain.
			await todos.insert({ title: 'b' })
			return 'both'
		})
		await app.ready
		await expect(done).resolves.toBe('both')
		const rows = await todos.where({}).exec()
		expect(rows.map((row) => row.title).sort()).toEqual(['a', 'b'])
	})

	test('closing before the browser starts the app rejects the queued write instead of leaving it pending', async () => {
		vi.stubGlobal('window', {
			addEventListener: () => {},
			removeEventListener: () => {},
			location: { href: 'http://localhost/' },
		})
		vi.stubGlobal('document', {
			addEventListener: () => {},
			removeEventListener: () => {},
			visibilityState: 'visible',
		})
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		const queued = runAllowingPreReadyWrites(() =>
			accessor(app as KoraApp, 'todos').insert({ title: 'never started' }),
		)
		// The start waits for the first paint, which never comes in this test.
		const outcome = queued.then(
			() => 'applied',
			(error: { code?: string }) => error.code,
		)
		await app.close()
		await expect(outcome).resolves.toBe('WRITE_NOT_APPLIED')
	})

	test('the queries subscribed before the store opens shape the first handshake, not a reconnect after it', async () => {
		class RefusedWebSocket {
			readyState = 0
			onopen: (() => void) | null = null
			onclose: ((event: unknown) => void) | null = null
			onerror: (() => void) | null = null
			onmessage: (() => void) | null = null
			constructor() {
				queueMicrotask(() => this.onclose?.({ reason: 'refused', code: 1006 }))
			}
			send(): void {}
			close(): void {
				this.readyState = 3
			}
		}
		vi.stubGlobal('WebSocket', RefusedWebSocket)
		const atStart: string[][] = []
		const original = SyncEngine.prototype.start
		const start = vi.spyOn(SyncEngine.prototype, 'start').mockImplementation(function (
			this: SyncEngine,
		) {
			atStart.push(this.getActiveQuerySubsets().map((subset) => JSON.stringify(subset.where)))
			return original.call(this)
		})
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'ws://localhost:65535/kora-sync', autoConnect: true },
		})
		const lessons = accessor(app, 'lessons')
		const stop = lessons.where({ courseId: 'c1' }).subscribe(() => {})
		await app.ready
		stop()
		expect(atStart.length).toBeGreaterThan(0)
		expect(atStart[0]).toContain(JSON.stringify({ courseId: 'c1' }))
		start.mockRestore()
	})

	test('a status subscriber that read the placeholder is told once the app has opened', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: { url: 'ws://localhost:65535/kora-sync' },
		})
		const seen: string[] = []
		const stopSync = app.sync?.subscribeStatus((status) => seen.push(status.status))
		const offline: string[] = []
		const stopOffline = app.offline.subscribe((status) => offline.push(status.state))
		expect(seen).toEqual([])
		await app.ready
		// No sync event fires on an idle, unconnected app: the catch-up notice is the only thing
		// that moves a subscriber off the placeholder.
		expect(seen.length).toBeGreaterThanOrEqual(1)
		expect(offline.length).toBeGreaterThanOrEqual(1)
		stopSync?.()
		stopOffline()
	})
})
