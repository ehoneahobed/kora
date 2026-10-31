/**
 * Only a failed load of the sign-in client degrades initialization; an error the auth backend
 * raises still fails `app.ready`.
 */
import 'fake-indexeddb/auto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { AuthSyncBinding } from '@korajs/core/bindings'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createApp } from '../../src/create-app'
import { AuthClientLoadError } from '../../src/lazy-auth-sync'
import type { KoraApp } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

let dir = ''
let app: KoraApp | null = null
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'kora-auth-load-'))
})
afterEach(async () => {
	await app?.close().catch(() => {})
	app = null
	rmSync(dir, { recursive: true, force: true })
	vi.restoreAllMocks()
})

function open(binding: AuthSyncBinding, scope?: Record<string, unknown>): KoraApp {
	app = createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: join(dir, 'a.db') },
		sync: { url: 'wss://localhost:9999', authClient: binding, ...(scope ? { scope } : {}) },
	})
	return app
}

const base: AuthSyncBinding = { auth: async () => ({ token: 't' }) }
const loadFailure = (): AuthClientLoadError => new AuthClientLoadError(new Error('chunk 404'))
const backendError = (): Error => new Error('auth backend down')

describe('initialization and the sign-in client', () => {
	test('resolveNodeId: a load failure opens the database, any other error fails ready', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		await open({
			...base,
			resolveNodeId: async () => {
				throw loadFailure()
			},
		}).ready
		await app?.close().catch(() => {})
		app = null
		const failing = open({
			...base,
			resolveNodeId: async () => {
				throw backendError()
			},
		})
		await expect(failing.ready).rejects.toThrow('auth backend down')
	})

	test('resolveScopeMap: a load failure opens the database, any other error fails ready', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		await open(
			{
				...base,
				resolveScopeMap: async () => {
					throw loadFailure()
				},
			},
			{ orgId: 'o' },
		).ready
		await app?.close().catch(() => {})
		app = null
		const failing = open(
			{
				...base,
				resolveScopeMap: async () => {
					throw backendError()
				},
			},
			{ orgId: 'o' },
		)
		await expect(failing.ready).rejects.toThrow('auth backend down')
	})

	test('resolveUserId (the principal): a load failure opens the database, any other error fails ready', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		await open({
			...base,
			resolveUserId: async () => {
				throw loadFailure()
			},
		}).ready
		await app?.close().catch(() => {})
		app = null
		const failing = open({
			...base,
			resolveUserId: async () => {
				throw backendError()
			},
		})
		await expect(failing.ready).rejects.toThrow('auth backend down')
	})
})

describe('a per-user database needs the sign-in client', () => {
	test('a dropped chunk request is retried; a client that never loads fails ready with its code', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		let calls = 0
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'ns.db'), namespaceByAuthUser: true },
			sync: {
				url: 'wss://localhost:9999',
				authClient: {
					...base,
					resolveUserId: async () => {
						if (++calls === 1) throw loadFailure()
						return 'alice'
					},
				},
			},
		})
		await app.ready
		expect(calls).toBeGreaterThanOrEqual(2)
		await app.close()
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(dir, 'ns2.db'), namespaceByAuthUser: true },
			sync: {
				url: 'wss://localhost:9999',
				authClient: {
					...base,
					resolveUserId: async () => {
						throw loadFailure()
					},
				},
			},
		})
		await expect(app.ready).rejects.toMatchObject({ code: 'AUTH_CLIENT_LOAD_FAILED' })
	}, 15000)
})
