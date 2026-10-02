/**
 * RT-51 repro (Phase 2 red team round 3, 2026-10-02): a 'stored-elsewhere' resolution
 * (RT-43 fix) answers for an operation the server no longer stores.
 *
 * `ClientSession` asks for resolutions only for ids its batch lookup did NOT find stored,
 * then acknowledges any hit as a duplicate. A 'stored-elsewhere' hit means "this id is
 * stored under another sequence", which the lookup has just shown to be false. The
 * record outlives its stored copy after a replace-mode `importBackup`: the prune keeps
 * resolutions at or below the node's restored maximum, whatever their outcome, so a
 * renumbered op stored above the restored log but re-submitted below it keeps its record.
 * Every later upload of that id is then acknowledged and dropped: the device believes it
 * synced, no replica ever receives it.
 *
 * Sequence (node N): ops 1..11 stored, backup; X stored at 12 (W6 renumber of a lost
 * number); a stale copy of X re-submitted at 5 (restored device copy) -> recorded
 * 'stored-elsewhere' at 5; the backup is restored (replace); the device re-uploads X.
 *
 * Asserts the CORRECT behaviour (fails today): X is stored again after the restore.
 */
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

let cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn()
	cleanups = []
})

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function makeOp(nodeId: string, sequenceNumber: number, key: string): Operation {
	return {
		id: `rt51-${key}`,
		nodeId,
		type: 'insert',
		collection: 'notes',
		recordId: `rt51-rec-${key}`,
		data: { title: key },
		previousData: null,
		timestamp: {
			wallTime: 1_790_000_000_000,
			logical: Number.parseInt(key.replace(/\D/g, '') || '0'),
			nodeId,
		},
		sequenceNumber,
		causalDeps: [],
		schemaVersion: 1,
	}
}

let pgSchemas = 0
async function openStore(kind: 'memory' | 'sqlite' | 'postgres'): Promise<ServerStore> {
	if (kind === 'memory') return new MemoryServerStore('server-1')
	if (kind === 'sqlite')
		return createSqliteServerStore({ filename: ':memory:', nodeId: 'server-1' })
	const url = process.env.KORA_PG_TEST_URL as string
	pgSchemas += 1
	const name = `kora_rt51_${process.pid}_${pgSchemas}`
	const admin = postgres(url, { max: 1, onnotice: () => {} })
	await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	const client = postgres(url, {
		max: 4,
		idle_timeout: 1,
		onnotice: () => {},
		connection: { search_path: name },
	})
	cleanups.push(async () => {
		await client.end()
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
		await admin.end()
	})
	return new PostgresServerStore(drizzle(client), 'server-1')
}

const kinds = [
	'memory',
	'sqlite',
	...(process.env.KORA_PG_TEST_URL ? (['postgres'] as const) : []),
] as const

describe.each(kinds)('RT-51: stale stored-elsewhere resolution (%s store)', (kind) => {
	test('an operation lost by a restore is stored again when its device re-uploads it', async () => {
		const store = await openStore(kind)
		await store.setSchema(schema)
		const server = new KoraSyncServer({
			store,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})
		cleanups.push(async () => {
			await server.stop()
		})
		const session = async () => {
			const { client, server: transport } = createServerTransportPair()
			const messages: SyncMessage[] = []
			client.onMessage((m) => messages.push(m))
			server.handleConnection(transport)
			client.send({
				type: 'handshake',
				messageId: `hs-${Math.random()}`,
				nodeId: 'N',
				versionVector: {},
				schemaVersion: 1,
				sequenceReservation: true,
				lastDeliverySequence: 0,
			} as SyncMessage)
			await vi.waitFor(() =>
				expect(messages.some((m) => m.type === 'handshake-response')).toBe(true),
			)
			let acks = 0
			const upload = async (ops: Operation[]): Promise<void> => {
				client.send({
					type: 'operation-batch',
					messageId: `b-${Math.random()}`,
					operations: ops,
					isFinal: true,
					batchIndex: 0,
				} as SyncMessage)
				acks += 1
				await vi.waitFor(() =>
					expect(messages.filter((m) => m.type === 'acknowledgment').length).toBe(acks),
				)
				await tick()
			}
			return { upload, close: () => void client.disconnect() }
		}

		const s1 = await session()
		await s1.upload(Array.from({ length: 11 }, (_, i) => makeOp('N', i + 1, `o${i + 1}`)))
		const backup = await store.exportBackup()
		const x = makeOp('N', 12, 'x99')
		await s1.upload([x])
		// The same operation (same id) submitted again under an older number.
		await s1.upload([{ ...x, sequenceNumber: 5 }])
		s1.close()
		expect((await store.findStoredOperations?.([x.id]))?.has(x.id)).toBe(true)

		await store.importBackup(backup, false)
		expect((await store.findStoredOperations?.([x.id]))?.has(x.id) ?? false).toBe(false)

		// The device re-uploads X (its own entry is above the restored log).
		const s2 = await session()
		await s2.upload([x])
		s2.close()
		expect((await store.findStoredOperations?.([x.id]))?.has(x.id) ?? false).toBe(true)
	}, 30_000)
})
