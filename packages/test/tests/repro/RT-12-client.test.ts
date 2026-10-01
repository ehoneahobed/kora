/**
 * RT-12 repro, client half (red team round 2, 2026-10-01): the sync engine trusts the
 * server-advertised version-vector entry for its OWN node. A forged high sequence
 * for the device's node id (an attacker who uploaded one operation under it) makes
 * the device treat its own unsynced writes as already on the server: they are never
 * uploaded and the pending count reads 0 (silent loss).
 *
 * The device must bound the server's claim about its own node by what the server
 * actually acknowledged: min(serverVector[self], last acked own sequence).
 * Asserts the CORRECT behaviour (fails before the fix).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore } from '@korajs/server'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../../src/test-device'
import type { TestServer } from '../../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

const FORGED_SEQUENCE = 1_000_000

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.()
})

async function network() {
	const store = new MemoryServerStore()
	await store.setSchema(schema)
	const sync = new KoraSyncServer({
		store,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
	})
	const tmp = mkdtempSync(join(tmpdir(), 'kora-rt12-'))
	const forge = { enabled: false, nodeId: '' }
	const fakeServer = {
		handleConnection(transport: ServerTransport): string {
			// A server-side view the attacker poisoned: the handshake response advertises a
			// huge sequence for the victim device's own node id.
			const wrapped: ServerTransport = {
				send: (m: SyncMessage) => {
					if (forge.enabled && m.type === 'handshake-response') {
						transport.send({
							...m,
							versionVector: { ...m.versionVector, [forge.nodeId]: FORGED_SEQUENCE },
						})
						return
					}
					transport.send(m)
				},
				onMessage: (h) => transport.onMessage(h),
				onClose: (h) => transport.onClose(h),
				onError: (h) => transport.onError(h),
				isConnected: () => transport.isConnected(),
				close: (c, r) => transport.close(c, r),
			}
			return sync.handleConnection(wrapped)
		},
	} as unknown as TestServer
	const device = new TestDevice({
		name: 'victim',
		schema,
		server: fakeServer,
		tmpDir: tmp,
		createTransportPair: () => {
			const pair = createServerTransportPair()
			return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
		},
	})
	await device.open()
	cleanups.push(async () => {
		await device.close()
		await sync.stop()
		rmSync(tmp, { recursive: true, force: true })
	})
	return { store, device, forge }
}

describe('RT-12 (client half): the server-advertised entry for the own node', () => {
	test('a forged high sequence for this device does not skip its unsynced writes', async () => {
		const { store, device, forge } = await network()
		// The attacker already wrote one operation under the victim's node id, so every
		// handshake now advertises a huge sequence for it.
		forge.enabled = true
		forge.nodeId = device.getNodeId()
		await device.sync()
		await device.disconnect()

		const a = await device.collection('todos').insert({ title: 'offline 1' })
		const b = await device.collection('todos').insert({ title: 'offline 2' })

		await device.sync()
		await device.sync()

		expect(await store.findRecord('todos', a.id)).not.toBeNull()
		expect(await store.findRecord('todos', b.id)).not.toBeNull()
	}, 30_000)
})
