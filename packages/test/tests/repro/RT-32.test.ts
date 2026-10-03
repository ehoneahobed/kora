/**
 * RT-32 repro (2026-10-02, Phase 2 seam W6 x SRV-4): legacy duplicate sequence
 * numbers vs SEQUENCE_CONFLICT.
 *
 * A beta.12 client could write two different operations under one (node, sequence)
 * (STORE-1/2), and a beta.12 server stored whichever arrived (sometimes only one).
 * On upgrade the client's sequence repair keeps the first-by-id at the old number and
 * renumbers the other (same id). When the server already holds the OTHER op at that
 * number, the kept op was refused with a non-retriable SEQUENCE_CONFLICT: the write
 * was lost for the server and every other device.
 *
 * Asserts the CORRECT behaviour (fails before the fix): after the upgrade and a sync,
 * the server and a second device hold both writes and nothing is rejected.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeOperationId, defineSchema, t } from '@korajs/core'
import { KoraSyncServer, createSqliteServerStore } from '@korajs/server'
import type { ServerStore, ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { StorageAdapter } from '@korajs/store'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TestDevice } from '../../src/test-device'
import type { TestServer } from '../../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn()
	vi.restoreAllMocks()
})

describe('RT-32: a legacy duplicate sequence the server holds the other half of', () => {
	test('both writes reach the server and a second device after the upgrade', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const tmp = mkdtempSync(join(tmpdir(), 'kora-rt32-'))
		cleanups.push(() => rmSync(tmp, { recursive: true, force: true }))

		let server: KoraSyncServer | null = null
		const rejected: string[] = []
		const deviceFor = (name: string): TestDevice =>
			new TestDevice({
				name,
				schema,
				tmpDir: tmp,
				server: {
					handleConnection: (transport: ServerTransport) => {
						if (!server) throw new Error('server not started')
						const wrapped: ServerTransport = {
							send: (m: SyncMessage) => {
								if (m.type === 'operation-rejected') rejected.push(`${m.code}:${m.operationId}`)
								transport.send(m)
							},
							onMessage: (h) => transport.onMessage(h),
							onClose: (h) => transport.onClose(h),
							onError: (h) => transport.onError(h),
							isConnected: () => transport.isConnected(),
							close: (c, r) => transport.close(c, r),
						}
						return server.handleConnection(wrapped)
					},
				} as unknown as TestServer,
				createTransportPair: () => {
					const pair = createServerTransportPair()
					return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
				},
			})

		// --- A beta.12 device: two writes under sequence 1, no unique index. ---
		const legacy = deviceFor('device-d')
		await legacy.open()
		const r1 = await legacy.collection('todos').insert({ title: 'first' })
		const r2 = await legacy.collection('todos').insert({ title: 'second' })
		const nodeId = legacy.getNodeId()
		// beta.12 wrote version-1 ids (protocol v2 made version 2 the default): the
		// fixture's operations are legacy, so they carry no hash version.
		const [firstOp, secondOp] = (await legacy.store.getAllOperations())
			.map(({ hashVersion: _v2, ...op }) => op)
			.sort((x, y) => x.sequenceNumber - y.sequenceNumber)
		if (!firstOp || !secondOp) throw new Error('expected two operations')
		let opA = firstOp
		let opB = secondOp
		const adapter = (legacy as unknown as { adapter: StorageAdapter }).adapter
		const indexes = await adapter.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'uidx_kora_ops_%_node_seq'",
		)
		for (const index of indexes) await adapter.execute(`DROP INDEX "${index.name}"`)
		await adapter.execute("DELETE FROM _kora_meta WHERE key = 'seq_unique_repair_v1'")
		await adapter.execute(
			"UPDATE _kora_ops_todos SET data = json_remove(data, '$.__kora_hash_version__')",
		)
		// beta.12 ids are version-1 content hashes (they do not cover the sequence number,
		// which is why a renumbering keeps them). This release creates version-2 ids, and
		// the server verifies every uploaded id (RT-64), so give the fixture's operations
		// the version-1 ids a beta.12 device would have written, everywhere they appear.
		const v1Ids = new Map<string, string>()
		for (const legacyOp of [opA, opB]) {
			v1Ids.set(legacyOp.id, await computeOperationId(legacyOp, 1))
		}
		const queue = await adapter.query<{ id: string; payload: string }>(
			'SELECT id, payload FROM _kora_sync_queue',
		)
		for (const row of queue) {
			const payload = JSON.parse(row.payload) as { data?: string | null }
			if (typeof payload.data === 'string') {
				const data = JSON.parse(payload.data) as Record<string, unknown>
				// biome-ignore lint/performance/noDelete: removing the key is the point
				delete data.__kora_hash_version__
				payload.data = JSON.stringify(data)
			}
			await adapter.execute('UPDATE _kora_sync_queue SET payload = ? WHERE id = ?', [
				JSON.stringify(payload),
				row.id,
			])
		}
		const tables = await adapter.query<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
		)
		for (const { name } of tables) {
			const columns = await adapter.query<{ name: string }>(`PRAGMA table_info("${name}")`)
			for (const column of columns) {
				for (const [from, to] of v1Ids) {
					await adapter.execute(
						`UPDATE "${name}" SET "${column.name}" = replace("${column.name}", ?, ?) WHERE instr("${column.name}", ?) > 0`,
						[from, to, from],
					)
				}
			}
		}
		const v1 = (op: typeof opA): typeof opA => ({ ...op, id: v1Ids.get(op.id) ?? op.id })
		opA = v1(opA)
		opB = v1(opB)
		await adapter.execute('UPDATE _kora_ops_todos SET sequence_number = 1 WHERE id = ?', [opB.id])
		await adapter.execute('UPDATE _kora_version_vector SET sequence_number = 1 WHERE node_id = ?', [
			nodeId,
		])
		await legacy.close()

		// The repair will keep the first id at sequence 1; the server holds the other.
		const [kept, renumbered] = opA.id < opB.id ? [opA, opB] : [opB, opA]
		const serverOnly = { ...renumbered, sequenceNumber: 1 }

		// --- A beta.12 server that stored only `serverOnly` at (node, 1). ---
		const serverDb = join(tmp, 'server.db')
		const before = createSqliteServerStore({ filename: serverDb, nodeId: 'server-1' })
		await before.setSchema(schema)
		expect(await before.applyRemoteOperation(serverOnly)).toBe('applied')
		await before.close()
		const raw = new Database(serverDb)
		raw.prepare("DELETE FROM kora_server_meta WHERE key = 'sequence_enforcement_epoch'").run()
		raw.prepare('DROP INDEX IF EXISTS idx_node_seq_unique_after_epoch').run()
		raw.close()

		// --- Upgrade: server and device run this release. ---
		const store: ServerStore = createSqliteServerStore({ filename: serverDb, nodeId: 'server-1' })
		await store.setSchema(schema)
		server = new KoraSyncServer({ store, relayRetransmitIntervalMs: 0, deliveryPollIntervalMs: 0 })
		cleanups.push(async () => {
			await server?.stop()
			await store.close()
		})

		const d = deviceFor('device-d')
		await d.open()
		cleanups.push(() => d.close())
		const repaired = await d.store.getAllOperations()
		expect(repaired.find((o) => o.id === kept.id)?.sequenceNumber).toBe(1)
		expect(repaired.find((o) => o.id === renumbered.id)?.sequenceNumber).toBe(2)

		await d.sync()
		await d.sync()

		const e = deviceFor('device-e')
		await e.open()
		cleanups.push(() => e.close())
		await e.sync()
		await e.sync()

		expect(rejected).toEqual([])
		expect(await d.getRejectedOperations()).toEqual([])
		const ids = new Set((await store.getOperationsAfterDelivery(0, 100)).map((x) => x.operation.id))
		expect(ids.has(kept.id)).toBe(true)
		expect(ids.has(renumbered.id)).toBe(true)
		for (const record of [r1, r2]) {
			expect(await store.findRecord('todos', record.id)).toMatchObject({ title: record.title })
			expect(await e.collection('todos').findById(record.id)).toMatchObject({ title: record.title })
			expect(await d.collection('todos').findById(record.id)).toMatchObject({ title: record.title })
		}
		expect(d.getSyncEngine()?.getStatus().pendingOperations ?? 0).toBe(0)
	})
})
