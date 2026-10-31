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

describe('loading the runtime chunk', () => {
	let app: KoraApp | null = null
	// A module that loaded once stays loaded, so the test that needs an unloaded chunk runs first.
	afterEach(async () => {
		await app?.close().catch(() => {})
		app = null
		failing.remaining = 0
		failing.calls = 0
		vi.useRealTimers()
	})

	test('a permanent import failure ends ready with RUNTIME_LOAD_FAILED after bounded tries', async () => {
		failing.remaining = 99
		app = createApp({ schema, store: { name: ':memory:', adapter: 'better-sqlite3' } })
		await expect(app.ready).rejects.toMatchObject({ code: 'RUNTIME_LOAD_FAILED' })
		expect(failing.calls).toBe(3)
	})

	test('a transient import failure is retried and the app opens', async () => {
		failing.remaining = 1
		app = createApp({ schema, store: { name: ':memory:', adapter: 'better-sqlite3' } })
		await app.ready
		expect(failing.calls).toBeGreaterThanOrEqual(2)
	})
})
