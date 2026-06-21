import { createRequire } from 'node:module'
import { beforeEach, describe, expect, test } from 'vitest'
import { DuplicateLinkedIdentityError } from './linked-identity-store'
import {
	SqliteLinkedIdentityStore,
	SqliteOAuthStateStore,
	createSqliteOAuthStores,
} from './sqlite-oauth-store'

async function createDatabase(): Promise<ConstructorParameters<typeof SqliteOAuthStateStore>[0]> {
	const require = createRequire(import.meta.url)
	const Database = require('better-sqlite3')
	return new Database(':memory:') as ConstructorParameters<typeof SqliteOAuthStateStore>[0]
}

describe('SqliteOAuthStateStore', () => {
	let store: SqliteOAuthStateStore

	beforeEach(async () => {
		store = new SqliteOAuthStateStore(await createDatabase())
	})

	test('stores and consumes state once', async () => {
		const state = {
			state: 'state-1',
			provider: 'google',
			redirectUri: 'http://localhost/callback',
			createdAt: Date.now(),
			expiresAt: Date.now() + 60_000,
			metadata: { deviceId: 'desktop-1' },
			codeVerifier: 'verifier-1',
		}

		await store.store(state)

		await expect(store.consume('state-1')).resolves.toEqual(state)
		await expect(store.consume('state-1')).resolves.toBeNull()
	})

	test('returns null and deletes expired state on consume', async () => {
		await store.store({
			state: 'expired',
			provider: 'google',
			redirectUri: 'http://localhost/callback',
			createdAt: Date.now() - 120_000,
			expiresAt: Date.now() - 1,
		})

		await expect(store.consume('expired')).resolves.toBeNull()
		await expect(store.consume('expired')).resolves.toBeNull()
	})

	test('cleans expired states', async () => {
		await store.store({
			state: 'expired',
			provider: 'google',
			redirectUri: 'http://localhost/callback',
			createdAt: Date.now() - 120_000,
			expiresAt: Date.now() - 1,
		})
		await store.store({
			state: 'valid',
			provider: 'google',
			redirectUri: 'http://localhost/callback',
			createdAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		})

		await expect(store.cleanExpired()).resolves.toBe(1)
		await expect(store.consume('valid')).resolves.toMatchObject({ state: 'valid' })
	})
})

describe('SqliteLinkedIdentityStore', () => {
	let store: SqliteLinkedIdentityStore

	beforeEach(async () => {
		store = new SqliteLinkedIdentityStore(await createDatabase())
	})

	test('creates, finds, lists, and deletes linked identities', async () => {
		const identity = await store.create({
			userId: 'user-1',
			provider: 'google',
			providerUserId: 'google-1',
			email: 'alice@example.com',
		})

		await expect(store.findByProvider('google', 'google-1')).resolves.toEqual(identity)
		await expect(store.findByUser('user-1')).resolves.toEqual([identity])

		await store.delete('user-1', 'google')

		await expect(store.findByProvider('google', 'google-1')).resolves.toBeNull()
		await expect(store.findByUser('user-1')).resolves.toEqual([])
	})

	test('prevents duplicate provider identities and duplicate provider links per user', async () => {
		await store.create({
			userId: 'user-1',
			provider: 'github',
			providerUserId: 'github-1',
			email: null,
		})

		await expect(
			store.create({
				userId: 'user-2',
				provider: 'github',
				providerUserId: 'github-1',
				email: null,
			}),
		).rejects.toBeInstanceOf(DuplicateLinkedIdentityError)

		await expect(
			store.create({
				userId: 'user-1',
				provider: 'github',
				providerUserId: 'github-2',
				email: null,
			}),
		).rejects.toBeInstanceOf(DuplicateLinkedIdentityError)
	})
})

describe('createSqliteOAuthStores', () => {
	test('creates both OAuth stores on one SQLite database', async () => {
		const stores = await createSqliteOAuthStores({ filename: ':memory:' })

		await stores.stateStore.store({
			state: 'state-1',
			provider: 'google',
			redirectUri: 'http://localhost/callback',
			createdAt: Date.now(),
			expiresAt: Date.now() + 60_000,
		})
		await stores.linkedIdentityStore.create({
			userId: 'user-1',
			provider: 'google',
			providerUserId: 'google-1',
			email: 'alice@example.com',
		})

		await expect(stores.stateStore.consume('state-1')).resolves.toMatchObject({
			provider: 'google',
		})
		await expect(stores.linkedIdentityStore.findByUser('user-1')).resolves.toHaveLength(1)
	})
})
