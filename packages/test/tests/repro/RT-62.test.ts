/**
 * RT-62 repro (Phase 3 red team, 2026-10-02): a server whose node id is auto-generated
 * (the documented default: `nodeId` "usually left to auto-generate") gets a new node id
 * on every restart, and with it a new `authoritativeNodeIds` list. Devices REPLACE their
 * persisted list with the new one and re-fold: every write the previous server process
 * authored loses its authority class on the devices, while the server's persisted fold
 * state (its plan fingerprint does not cover the authoritative ids) keeps it. A
 * `merge('server-authoritative')` field then shows the device's value on devices and
 * the server's value on the server and on any device that later joins from the
 * server's scope-entry fold state. Two instances of one Postgres deployment have the
 * same split permanently (each advertises only its own random id).
 *
 * Asserts the CORRECT behaviour (fails at 959b791): after a restart the server, the
 * old device and a new device agree.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { type ServerStore, createSqliteServerStore } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncTransport } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TestDevice } from '../../src/test-device'
import { TestServer } from '../../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				status: t.string().merge('server-authoritative'),
			},
		},
	},
}) as unknown as SchemaDefinition

describe('RT-62: auto-generated server node id across a restart', () => {
	test('a server-authoritative decision survives a server restart on every replica', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-rt62-'))
		const filename = join(dir, 'server.db')
		const holder: { server: TestServer<ServerStore> } = {
			// No nodeId: the default every deployment gets unless it configures one.
			server: new TestServer(schema, { store: createSqliteServerStore({ filename }) }),
		}
		await holder.server.ready
		const route = { handleConnection: (t: never) => holder.server.handleConnection(t) }
		const makeDevice = (name: string) =>
			new TestDevice({
				name,
				schema,
				server: route,
				createTransportPair: () => {
					const pair = createServerTransportPair()
					return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
				},
				tmpDir: dir,
			})
		const a = makeDevice('a')
		let c: TestDevice | null = null
		try {
			await a.open()
			await a.sync()
			const item = await a.collection('items').insert({ title: 'x', status: 'draft' })
			const id = String(item.id)
			await a.sync()
			await a.disconnect()

			// The server decides; the device writes the field later, offline.
			const decided = await holder.server
				.getKoraContext()
				.apply({ collection: 'items', type: 'update', recordId: id, data: { status: 'approved' } })
			expect(decided.ok).toBe(true)
			await new Promise((resolve) => setTimeout(resolve, 5))
			await a.collection('items').update(id, { status: 'client' })
			await a.sync()
			await a.sync()
			expect(await a.collection('items').findById(id)).toMatchObject({ status: 'approved' })
			const firstIds = holder.server.authoritativeNodeIds
			await a.disconnect()

			// Restart the server process on the same database, configured the same way.
			await holder.server.close()
			holder.server = new TestServer(schema, { store: createSqliteServerStore({ filename }) })
			await holder.server.ready
			// beta.14: the server identity is persisted in the database (RT-62), so a restart
			// keeps the same authoritative node ids (at 959b791 this was a new random id).
			expect(holder.server.authoritativeNodeIds).toEqual(firstIds)

			await a.sync()
			await a.sync()
			c = makeDevice('c')
			await c.open()
			await c.sync()
			await c.sync()

			const onServer = await holder.server.store.findRecord('items', id)
			const onA = await a.collection('items').findById(id)
			const onC = await c.collection('items').findById(id)
			expect(onServer).toMatchObject({ status: 'approved' })
			expect(onA).toMatchObject({ status: 'approved' })
			expect(onC).toMatchObject({ status: 'approved' })
		} finally {
			await a.close()
			await c?.close()
			await holder.server.close()
			rmSync(dir, { recursive: true, force: true })
		}
	}, 60_000)
})
