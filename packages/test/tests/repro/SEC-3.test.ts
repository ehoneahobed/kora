import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { TestNetwork } from '../../src/index'
import { createTestNetwork } from '../../src/index'

/**
 * SEC-3 repro: the server does not bind op.nodeId to the uploading session and does
 * not verify the content-addressed op.id. Any peer can upload an op claiming a
 * victim's nodeId with a huge sequenceNumber; the server version vector then claims
 * it already holds the victim's ops, so the victim's real SyncEngine skips uploading
 * its offline writes and marks them as acknowledged. Asserts CORRECT behavior.
 */
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

let network: TestNetwork | null = null
afterEach(async () => {
	if (network) {
		await network.close()
		network = null
	}
})

function rawPeer(net: TestNetwork) {
	const { client, server } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	net.server.handleConnection(server)
	return { client, messages }
}

async function attackerHandshake(net: TestNetwork) {
	const peer = rawPeer(net)
	peer.client.send({
		type: 'handshake',
		messageId: 'hs-m',
		nodeId: 'mallory-node',
		versionVector: {},
		schemaVersion: 1,
	})
	await vi.waitFor(() =>
		expect(peer.messages.some((m) => m.type === 'handshake-response')).toBe(true),
	)
	return peer
}

function forged(victimNodeId: string, overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'not-a-content-hash',
		nodeId: victimNodeId,
		type: 'insert',
		collection: 'todos',
		recordId: 'forged-rec',
		data: { title: 'forged' },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: 0, nodeId: victimNodeId },
		sequenceNumber: 1_000_000,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('SEC-3: nodeId not bound to session, op.id not verified', () => {
	test('server rejects an op whose nodeId differs from the session nodeId, or whose id is not its content hash', async () => {
		network = await createTestNetwork(schema, { devices: 1 })
		const peer = await attackerHandshake(network)
		peer.client.send({
			type: 'operation-batch',
			messageId: 'b1',
			operations: [forged('victim-node-id')],
			isFinal: true,
			batchIndex: 0,
		})
		await new Promise((r) => setTimeout(r, 100))
		expect(network.server.getAllOperations().some((o) => o.id === 'not-a-content-hash')).toBe(false)
	})

	test("victim's offline writes still reach the server after an attacker forges its nodeId", async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [victim, observer] = network.devices
		if (!victim || !observer) throw new Error('devices')

		await victim.sync()
		await observer.sync()

		// Attacker forges an op under the victim's nodeId with a huge sequence number.
		// (The victim's nodeId leaks via any handshake-response version vector: SEC-4.)
		const peer = await attackerHandshake(network)
		peer.client.send({
			type: 'operation-batch',
			messageId: 'b1',
			operations: [forged(victim.getNodeId())],
			isFinal: true,
			batchIndex: 0,
		})
		await new Promise((r) => setTimeout(r, 100))

		// Victim reconnects once (persists the server's poisoned vector), then goes offline.
		await victim.disconnect()
		await victim.sync()
		await victim.disconnect()

		// Victim works offline, then reconnects.
		await victim.collection('todos').insert({ title: 'offline write 1' })
		await victim.collection('todos').insert({ title: 'offline write 2' })

		await victim.sync()
		await victim.sync()
		await observer.sync()
		await observer.sync()

		const serverTitles = network.server
			.getAllOperations()
			.filter((o) => o.collection === 'todos' && o.type === 'insert')
			.map((o) => (o.data as { title: string }).title)
		expect.soft(serverTitles).toContain('offline write 1')
		expect.soft(serverTitles).toContain('offline write 2')
		const observed = (await observer.getState('todos')).map((r) => r.title).sort()
		// Victim and observer must converge (resume stream skips ops "from" the victim's nodeId).
		const victimView = (await victim.getState('todos')).map((r) => r.title).sort()
		expect.soft(victimView).toEqual(observed)
		expect(observed).toContain('offline write 1')
	}, 30_000)
})
