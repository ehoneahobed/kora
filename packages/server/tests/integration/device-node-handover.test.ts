/**
 * F1: automatic device handover after a beta.12 server upgrade.
 *
 * beta.12 recorded no node claims, so every node with history is ownerless after the
 * upgrade. `@korajs/auth` clients use the signed-in device id as their node id and
 * cannot change it. The server now claims such a node for the signed-in user whose
 * VERIFIED device id (`metadata.deviceId`) equals the node id, atomically, so the
 * device's queued writes upload with no operator script. Anyone else is still refused.
 *
 * Runs on the memory, SQLite and (with KORA_PG_TEST_URL) Postgres stores.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { RELEASED_NODE_OWNER } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'
import type { KoraSyncServerConfig } from '../../src/types'
import { createHarness, makeOp, sendAndAwaitAck } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), owner: t.string() } } },
})

// Tokens look like `<user>@<device>`; the provider reports the device it verified.
const auth = new TokenAuthProvider({
	validate: async (token) => {
		const [userId, deviceId] = token.split('@')
		if (!userId || !deviceId) return null
		return {
			userId,
			scopes: { notes: { owner: userId } },
			metadata: { deviceId },
		}
	},
})

const tmp = mkdtempSync(join(tmpdir(), 'kora-handover-'))
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
	for (const cleanup of cleanups) await cleanup()
	rmSync(tmp, { recursive: true, force: true })
})

let pgSchemas = 0
const stores: Array<[string, () => Promise<ServerStore>]> = [
	['memory', async () => new MemoryServerStore('server-1')],
	[
		'sqlite',
		async () => {
			const store = createSqliteServerStore({
				filename: join(tmp, `s-${Math.random().toString(36).slice(2)}.db`),
			})
			cleanups.push(() => store.close())
			return store
		},
	],
]
const pgUrl = process.env.KORA_PG_TEST_URL
if (pgUrl) {
	stores.push([
		'postgres',
		async () => {
			pgSchemas += 1
			const name = `kora_handover_${process.pid}_${pgSchemas}`
			const admin = postgres(pgUrl, { max: 1 })
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
			await admin.unsafe(`CREATE SCHEMA ${name}`)
			await admin.end()
			const client = postgres(pgUrl, { max: 4, idle_timeout: 1, connection: { search_path: name } })
			const store = new PostgresServerStore(drizzle(client), 'server-1')
			cleanups.push(async () => {
				await store.close()
			})
			return store
		},
	])
}

function errorCodes(messages: SyncMessage[]): string[] {
	return messages.flatMap((m) => (m.type === 'error' ? [m.code] : []))
}

function accepted(messages: SyncMessage[]): boolean {
	return messages.some((m) => m.type === 'handshake-response' && m.accepted)
}

/** A database as a beta.12 server left it: history under `nodeId`, no claim row. */
async function upgradedStore(make: () => Promise<ServerStore>, nodeId: string) {
	const store = await make()
	await store.setSchema(schema)
	await store.applyRemoteOperation(
		makeOp(nodeId, 1, {
			collection: 'notes',
			data: { title: 'written on beta.12', owner: 'alice' },
		}),
	)
	expect(await store.getNodeClaimOwner?.(nodeId)).toBeNull()
	return store
}

async function harnessOn(store: ServerStore, extra: Partial<KoraSyncServerConfig> = {}) {
	return createHarness(schema, auth, extra, store as MemoryServerStore)
}

describe.each(stores)('F1: device handover (%s)', (_name, make) => {
	test("the owner's device takes over its node and its queued writes upload", async () => {
		const store = await upgradedStore(make, 'dev-alice')
		const harness = await harnessOn(store)
		const alice = await harness.login('alice@dev-alice', 'dev-alice')
		expect(errorCodes(alice.messages)).toEqual([])
		expect(accepted(alice.messages)).toBe(true)
		expect(await store.getNodeClaimOwner?.('dev-alice')).toBe('alice')

		// The write the device queued offline (its next sequence number) uploads.
		const queued = makeOp('dev-alice', 2, {
			collection: 'notes',
			data: { title: 'queued offline', owner: 'alice' },
		})
		await sendAndAwaitAck(alice, [queued])
		expect(await store.findRecord('notes', queued.recordId)).toMatchObject({
			title: 'queued offline',
		})
	})

	test('another user presenting the node id is refused, before and after the handover', async () => {
		const store = await upgradedStore(make, 'dev-alice')
		const harness = await harnessOn(store)
		// Mallory's own verified device is not this node.
		const mallory = await harness.login('mallory@dev-mallory', 'dev-alice')
		expect(errorCodes(mallory.messages)).toEqual(['NODE_ID_CLAIMED'])
		expect(await store.getNodeClaimOwner?.('dev-alice')).toBeNull()

		const alice = await harness.login('alice@dev-alice', 'dev-alice')
		expect(accepted(alice.messages)).toBe(true)
		// Even a token whose verified device id names the node cannot take it from Alice.
		const thief = await harness.login('mallory@dev-alice', 'dev-alice')
		expect(errorCodes(thief.messages)).toEqual(['NODE_ID_CLAIMED'])
		expect(await store.getNodeClaimOwner?.('dev-alice')).toBe('alice')
	})

	test('a node with a real owner is never taken', async () => {
		const store = await upgradedStore(make, 'dev-shared')
		expect(await store.releaseNodeClaim?.('dev-shared')).toBe(true)
		expect(await store.claimNode?.('dev-shared', 'bob')).toBe(true)
		const harness = await harnessOn(store)
		const alice = await harness.login('alice@dev-shared', 'dev-shared')
		expect(errorCodes(alice.messages)).toEqual(['NODE_ID_CLAIMED'])
		expect(await store.getNodeClaimOwner?.('dev-shared')).toBe('bob')
	})

	test('deviceNodeHandover: false keeps the beta.13 refusal', async () => {
		const store = await upgradedStore(make, 'dev-alice')
		const harness = await harnessOn(store, { deviceNodeHandover: false })
		const alice = await harness.login('alice@dev-alice', 'dev-alice')
		expect(errorCodes(alice.messages)).toEqual(['NODE_ID_CLAIMED'])
		expect(await store.getNodeClaimOwner?.('dev-alice')).toBeNull()
	})

	test('claimUnownedNode is atomic: one winner among concurrent claimants', async () => {
		const store = await upgradedStore(make, 'dev-race')
		const outcomes = await Promise.all(
			['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].map((user) =>
				(store.claimUnownedNode as NonNullable<ServerStore['claimUnownedNode']>).call(
					store,
					'dev-race',
					user,
				),
			),
		)
		expect(outcomes.filter(Boolean)).toHaveLength(1)
		const owner = await store.getNodeClaimOwner?.('dev-race')
		expect(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']).toContain(owner)
		// The winner keeps it; a later claimant is refused; a released node goes to the next.
		expect(await store.claimUnownedNode?.('dev-race', 'late')).toBe(false)
		expect(await store.claimUnownedNode?.('dev-race', owner as string)).toBe(true)
		expect(await store.releaseNodeClaim?.('dev-race')).toBe(true)
		expect(await store.getNodeClaimOwner?.('dev-race')).toBe(RELEASED_NODE_OWNER)
		expect(await store.claimUnownedNode?.('dev-race', 'late')).toBe(true)
		expect(await store.claimUnownedNode?.('dev-race', RELEASED_NODE_OWNER)).toBe(false)
		expect(await store.getNodeClaimOwner?.('dev-race')).toBe('late')
	})
})
