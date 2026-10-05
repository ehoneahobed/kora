import { AppNotReadyError, defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createApp } from './create-app'
import { RESERVED_APP_PROPERTIES, warnShadowedCollections } from './reserved-app-properties'
import type { KoraApp } from './types'

const plain = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

describe('reserved app properties (DX-9)', () => {
	let app: KoraApp | null = null
	afterEach(async () => {
		await app?.ready.catch(() => {})
		await app?.close()
		app = null
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	test('RESERVED_APP_PROPERTIES lists exactly the framework properties of the app object', async () => {
		app = createApp({ schema: plain, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		const frameworkKeys = Reflect.ownKeys(app).filter((key) => key !== 'todos')
		expect([...frameworkKeys].sort()).toEqual([...RESERVED_APP_PROPERTIES].sort())
	})

	test('no warning for a schema without reserved names', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		app = createApp({ schema: plain, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		expect(warn).not.toHaveBeenCalled()
	})

	test('warns once, naming every shadowed collection and the collision-free path', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const schema = defineSchema({
			version: 1,
			collections: {
				storage: { fields: { label: t.string() } },
				sync: { fields: { label: t.string() } },
				todos: { fields: { title: t.string() } },
			},
		})
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		expect(warn).toHaveBeenCalledTimes(1)
		const message = String(warn.mock.calls[0]?.[0])
		expect(message).toContain('"storage", "sync"')
		expect(message).toContain('app.collections.storage')
		expect(message).toContain('app.collections.sync')
		expect(message).not.toContain('"todos"')

		// The collection stays reachable through the namespace.
		await app.ready
		const collections = app.collections as Record<
			string,
			{ insert: (d: object) => Promise<unknown> }
		>
		await expect(collections.storage?.insert({ label: 'x' })).resolves.toMatchObject({
			label: 'x',
		})
	})

	test('silent in production builds', () => {
		vi.stubEnv('NODE_ENV', 'production')
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		warnShadowedCollections(['ready'], new Set(['ready']))
		expect(warn).not.toHaveBeenCalled()
	})
})

describe('findById before ready (DX-4)', () => {
	test('rejects with AppNotReadyError like every other collection method', async () => {
		const app = createApp({ schema: plain, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		const todos = app.collections.todos
		await expect(todos?.findById('x')).rejects.toBeInstanceOf(AppNotReadyError)
		await app.ready
		await expect(todos?.findById('x')).resolves.toBeNull()
		await app.close()
	})
})
