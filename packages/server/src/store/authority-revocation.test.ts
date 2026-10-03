/**
 * RT-81: explicit authority over time. Every explicit id a deployment ever held
 * authoritative stays authoritative until revoked (devices keep the same union), is
 * never accepted as a device node id (revoked ones included), and a revocation is
 * persisted, advertised and permanent.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import {
	ServerIdentityError,
	parseIdentityOptions,
	resolveAuthorityHistory,
} from './server-identity'
import type { ServerStore } from './server-store'
import { createSqliteServerStore } from './sqlite-server-store'

const schema = defineSchema({
	version: 1,
	collections: { items: { fields: { status: t.string().merge('server-authoritative') } } },
})

const dir = mkdtempSync(join(tmpdir(), 'kora-revocation-'))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
	for (const fn of cleanups.reverse()) await fn()
	rmSync(dir, { recursive: true, force: true })
})

describe('resolveAuthorityHistory', () => {
	const configured = (authoritativeNodeIds: string[], revokedAuthoritativeNodeIds: string[] = []) =>
		parseIdentityOptions({ authoritativeNodeIds, revokedAuthoritativeNodeIds })

	test('an id held once stays authoritative after it leaves the configuration', () => {
		const first = resolveAuthorityHistory({
			legacy: ['legacy-a'],
			configured: configured(['admin-svc']),
			persistedEver: [],
			persistedRevoked: [],
			ownNodeId: 'kora:server:d:1',
		})
		expect(first.explicitAuthorities).toEqual(['admin-svc', 'legacy-a'])
		const second = resolveAuthorityHistory({
			legacy: ['legacy-a'],
			configured: configured([]),
			persistedEver: first.everAuthoritative,
			persistedRevoked: first.revoked,
			ownNodeId: 'kora:server:d:1',
		})
		expect(second.explicitAuthorities).toEqual(['admin-svc', 'legacy-a'])
	})

	test('a revocation removes the authority, keeps the id reserved, and is permanent', () => {
		const revoked = resolveAuthorityHistory({
			legacy: ['legacy-a'],
			configured: configured([], ['admin-svc', 'legacy-a']),
			persistedEver: ['admin-svc', 'legacy-a'],
			persistedRevoked: [],
			ownNodeId: 'kora:server:d:1',
		})
		expect(revoked.explicitAuthorities).toEqual([])
		expect(revoked.revoked).toEqual(['admin-svc', 'legacy-a'])
		expect(revoked.everAuthoritative).toEqual(['admin-svc', 'legacy-a'])
		// The revocation config removed later: still revoked (persisted).
		const later = resolveAuthorityHistory({
			legacy: ['legacy-a'],
			configured: configured([]),
			persistedEver: revoked.everAuthoritative,
			persistedRevoked: revoked.revoked,
			ownNodeId: 'kora:server:d:1',
		})
		expect(later.explicitAuthorities).toEqual([])
		// Re-configuring a revoked id is refused.
		expect(() =>
			resolveAuthorityHistory({
				legacy: [],
				configured: configured(['admin-svc']),
				persistedEver: later.everAuthoritative,
				persistedRevoked: later.revoked,
				ownNodeId: 'kora:server:d:1',
			}),
		).toThrow(ServerIdentityError)
	})

	test('configuration errors: kora: ids, empty ids, authoritative and revoked at once', () => {
		expect(() =>
			parseIdentityOptions({ revokedAuthoritativeNodeIds: ['kora:server:x:1'] }),
		).toThrow(ServerIdentityError)
		expect(() => parseIdentityOptions({ revokedAuthoritativeNodeIds: [''] })).toThrow(
			ServerIdentityError,
		)
		expect(() =>
			parseIdentityOptions({
				authoritativeNodeIds: ['admin-svc'],
				revokedAuthoritativeNodeIds: ['admin-svc'],
			}),
		).toThrow(ServerIdentityError)
	})
})

async function openPersistent(
	kind: 'sqlite' | 'postgres',
	key: string,
	options: { authoritativeNodeIds?: string[]; revokedAuthoritativeNodeIds?: string[] },
): Promise<ServerStore> {
	if (kind === 'sqlite') {
		const store = createSqliteServerStore({ filename: join(dir, `${key}.db`), ...options })
		await store.setSchema(schema)
		return store
	}
	const url = process.env.KORA_PG_TEST_URL as string
	const name = `kora_rt81_${process.pid}_${key}`
	const admin = postgres(url, { max: 1, onnotice: () => {} })
	await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS ${name}`)
	const client = postgres(url, {
		max: 2,
		idle_timeout: 1,
		onnotice: () => {},
		connection: { search_path: name },
	})
	cleanups.push(async () => {
		await client.end()
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
		await admin.end()
	})
	const store = new PostgresServerStore(drizzle(client), undefined, undefined, options)
	await store.setSchema(schema)
	return store
}

const persistentKinds = [
	'sqlite',
	...(process.env.KORA_PG_TEST_URL ? (['postgres'] as const) : []),
] as const

describe.each(persistentKinds)('authority history persists (%s)', (kind) => {
	test('held -> dropped from config (still authoritative) -> revoked (reserved, advertised)', async () => {
		const key = `history_${kind}_${String(Date.now())}`
		const first = await openPersistent(kind, key, { authoritativeNodeIds: ['admin-svc'] })
		expect(first.getAuthoritativeNodeIds?.()).toContain('admin-svc')
		await first.close()

		const dropped = await openPersistent(kind, key, {})
		expect(dropped.getAuthoritativeNodeIds?.()).toContain('admin-svc')
		expect(dropped.getEverAuthoritativeNodeIds?.()).toEqual(['admin-svc'])
		await dropped.close()

		const revoked = await openPersistent(kind, key, { revokedAuthoritativeNodeIds: ['admin-svc'] })
		expect(revoked.getAuthoritativeNodeIds?.()).not.toContain('admin-svc')
		expect(revoked.getRevokedAuthoritativeNodeIds?.()).toEqual(['admin-svc'])
		expect(revoked.getEverAuthoritativeNodeIds?.()).toEqual(['admin-svc'])
		await revoked.close()

		const after = await openPersistent(kind, key, {})
		expect(after.getRevokedAuthoritativeNodeIds?.()).toEqual(['admin-svc'])
		expect(after.getAuthoritativeNodeIds?.()).not.toContain('admin-svc')
		await after.close()
	})
})

test('memory store: configured revocations are advertised and reserved', () => {
	const store = new MemoryServerStore(undefined, {
		authoritativeNodeIds: ['a'],
		revokedAuthoritativeNodeIds: ['b'],
	})
	expect(store.getAuthoritativeNodeIds()).toContain('a')
	expect(store.getAuthoritativeNodeIds()).not.toContain('b')
	expect(store.getRevokedAuthoritativeNodeIds()).toEqual(['b'])
	expect(store.getEverAuthoritativeNodeIds()).toEqual(['a', 'b'])
})
