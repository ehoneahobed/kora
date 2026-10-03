import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'

const initializeSpy = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./initialize-app', async (importOriginal) => {
	const mod = await importOriginal<typeof import('./initialize-app')>()
	return {
		...mod,
		initializeApp: (...args: Parameters<typeof mod.initializeApp>) => {
			initializeSpy.calls++
			return mod.initializeApp(...args)
		},
	}
})

import { createApp } from './create-app'
import { ServerRenderingAppError, isServerRenderingInert } from './ssr'
import type { KoraApp } from './types'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

// This suite runs in Vitest's node environment: no `window`, like a Next.js server render.
describe('createApp during server rendering (DX-6)', () => {
	let app: KoraApp | null = null

	afterEach(async () => {
		await app?.close()
		app = null
		initializeSpy.calls = 0
	})

	test('stays inert: opens no storage, ready rejects with a handled, explanatory error', async () => {
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => unhandled.push(reason)
		process.on('unhandledRejection', onUnhandled)
		try {
			app = createApp({ schema, sync: { url: 'wss://sync.example.com' } })
			await new Promise((resolve) => setTimeout(resolve, 10))
		} finally {
			process.off('unhandledRejection', onUnhandled)
		}
		expect(unhandled).toEqual([])
		expect(initializeSpy.calls).toBe(0)
		await expect(app.ready).rejects.toBeInstanceOf(ServerRenderingAppError)
		await expect(app.ready).rejects.toMatchObject({ code: 'SSR_INERT_APP' })
		await expect(app.sync?.connect()).rejects.toBeInstanceOf(ServerRenderingAppError)
		expect(app.storeInfo().isolationState).toBe('closed')
		// Writes fail loudly rather than hanging on a database that never opens.
		await expect(app.collections.todos?.insert({ title: 'x' })).rejects.toMatchObject({
			code: 'APP_NOT_READY',
		})
	})

	test('ssr: false opens a real database in Node.js', async () => {
		app = createApp({ schema, ssr: false, store: { name: ':memory:' } })
		await app.ready
		expect(initializeSpy.calls).toBe(1)
		const todo = await app.collections.todos?.insert({ title: 'node' })
		expect(todo?.title).toBe('node')
	})

	test("an explicit 'better-sqlite3' adapter means a Node.js program, not a server render", async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		expect(initializeSpy.calls).toBe(1)
	})
})

describe('isServerRenderingInert', () => {
	test('a browser (window) is never inert', () => {
		expect(isServerRenderingInert({}, { window: {} })).toBe(false)
		expect(isServerRenderingInert({ ssr: true }, { window: {} })).toBe(false)
	})

	test('no window: inert unless ssr is false or the Node adapter is explicit', () => {
		expect(isServerRenderingInert({}, {})).toBe(true)
		expect(isServerRenderingInert({ ssr: false }, {})).toBe(false)
		expect(isServerRenderingInert({ store: { adapter: 'better-sqlite3' } }, {})).toBe(false)
		expect(isServerRenderingInert({ store: { adapter: 'sqlite-wasm' } }, {})).toBe(true)
	})

	test('ssr: true is inert without a window even with the Node adapter', () => {
		expect(isServerRenderingInert({ ssr: true, store: { adapter: 'better-sqlite3' } }, {})).toBe(
			true,
		)
	})

	test('a web worker (no window) is a client, not a server render', () => {
		const worker = { WorkerGlobalScope: class {}, importScripts: () => {} }
		expect(isServerRenderingInert({}, worker)).toBe(false)
	})
})
