import 'fake-indexeddb/auto'
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createApp } from './create-app'
import type { KoraApp } from './types'

// How many of the next imports of the runtime chunk fail (a dropped request, a stale chunk).
const failing = vi.hoisted(() => ({ remaining: 0, calls: 0 }))
vi.mock('./runtime-app', async (importOriginal) => {
	failing.calls++
	if (failing.remaining > 0) {
		failing.remaining--
		throw new Error('Failed to fetch dynamically imported module: runtime-app.js')
	}
	return await importOriginal()
})

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})
const memory = { adapter: 'better-sqlite3', name: ':memory:' } as const

/** A browser page: a window with a session storage and a reload that can be counted. */
function stubPage(options: { online?: boolean } = {}): {
	reload: ReturnType<typeof vi.fn>
	storage: Map<string, string>
	listeners: Map<string, Set<() => void>>
	goOnline: () => void
} {
	const storage = new Map<string, string>()
	const reload = vi.fn()
	const listeners = new Map<string, Set<() => void>>()
	vi.stubGlobal('navigator', { onLine: options.online ?? true })
	vi.stubGlobal('window', {
		addEventListener: (type: string, listener: () => void) => {
			listeners.set(type, (listeners.get(type) ?? new Set()).add(listener))
		},
		removeEventListener: (type: string, listener: () => void) => {
			listeners.get(type)?.delete(listener)
		},
		location: { href: 'http://localhost/', reload },
		sessionStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => void storage.set(key, value),
		},
	})
	vi.stubGlobal('document', {
		addEventListener: () => {},
		removeEventListener: () => {},
		visibilityState: 'visible',
	})
	const goOnline = (): void => {
		vi.stubGlobal('navigator', { onLine: true })
		for (const listener of [...(listeners.get('online') ?? [])]) listener()
	}
	return { reload, storage, listeners, goOnline }
}

// Importing the same failed URL again cannot succeed in a browser (it keeps the failure), so the
// recovery is one guarded page reload, not another import. Real Chromium behaviour is covered by
// e2e/offline/offline-readiness.spec.ts.
describe('loading the runtime chunk', () => {
	let app: KoraApp | null = null
	afterEach(async () => {
		await app?.close().catch(() => {})
		app = null
		failing.remaining = 0
		failing.calls = 0
		vi.unstubAllGlobals()
	})

	test('outside a page a failed import ends ready with RUNTIME_LOAD_FAILED after one try', async () => {
		failing.remaining = 99
		app = createApp({ schema, store: memory })
		await expect(app.ready).rejects.toMatchObject({ code: 'RUNTIME_LOAD_FAILED' })
		expect(failing.calls).toBe(1)
	})

	test('in a page the first failure reloads it once and leaves ready pending', async () => {
		const { reload, storage } = stubPage()
		failing.remaining = 99
		app = createApp({ schema, store: memory })
		const outcome = vi.fn()
		// Reading `ready` asks for the runtime.
		app.ready.then(outcome, outcome)
		await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
		expect(storage.has('kora:chunk-reload:runtime')).toBe(true)
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(outcome).not.toHaveBeenCalled()
	})

	test('a failure right after a reload is not reloaded again: ready rejects with the typed error', async () => {
		const { reload, storage } = stubPage()
		storage.set('kora:chunk-reload:runtime', String(Date.now()))
		failing.remaining = 99
		app = createApp({ schema, store: memory })
		await expect(app.ready).rejects.toMatchObject({ code: 'RUNTIME_LOAD_FAILED' })
		expect(reload).not.toHaveBeenCalled()
	})

	test('a failure long after the last reload reloads again', async () => {
		const { reload, storage } = stubPage()
		storage.set('kora:chunk-reload:runtime', String(Date.now() - 60_000))
		failing.remaining = 1
		app = createApp({ schema, store: memory })
		app.ready.catch(() => {})
		await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
	})

	test('offline, a failed import does not reload: it waits for the connection, then reloads once', async () => {
		const { reload, listeners, goOnline } = stubPage({ online: false })
		failing.remaining = 99
		app = createApp({ schema, store: memory })
		const outcome = vi.fn()
		app.ready.then(outcome, outcome)
		await vi.waitFor(() => expect(listeners.get('online')?.size).toBe(1))
		// A reload offline would replace the page with one that cannot load its data.
		expect(reload).not.toHaveBeenCalled()
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(outcome).not.toHaveBeenCalled()

		goOnline()
		expect(reload).toHaveBeenCalledTimes(1)
		expect(listeners.get('online')?.size).toBe(0)
	})

	test('offline then online right after a reload ends ready with the typed error, not a loop', async () => {
		const { reload, storage, listeners, goOnline } = stubPage({ online: false })
		storage.set('kora:chunk-reload:runtime', String(Date.now()))
		failing.remaining = 99
		app = createApp({ schema, store: memory })
		const settled = expect(app.ready).rejects.toMatchObject({ code: 'RUNTIME_LOAD_FAILED' })
		await vi.waitFor(() => expect(listeners.get('online')?.size).toBe(1))
		goOnline()
		await settled
		expect(reload).not.toHaveBeenCalled()
	})

	test('closing the app while it waits for the connection stops listening and does not hang', async () => {
		const { reload, listeners } = stubPage({ online: false })
		failing.remaining = 99
		app = createApp({ schema, store: memory })
		app.ready.catch(() => {})
		await vi.waitFor(() => expect(listeners.get('online')?.size).toBe(1))
		await app.close()
		expect(listeners.get('online')?.size).toBe(0)
		expect(reload).not.toHaveBeenCalled()
	})
})
