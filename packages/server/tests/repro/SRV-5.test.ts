/**
 * SRV-5 repro: sendDeliveryStream accumulates EVERY deliverable operation after the
 * client's watermark in memory before sending the first batch, so initial sync of a
 * large log holds the whole log in server memory per connecting client. Correct
 * behavior: the stream is paginated -- the first batch goes out after scanning at most
 * one scan chunk. Also: MemoryServerStore.getOperationsAfterDelivery rescans the whole
 * log from the start for every chunk (quadratic).
 */
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

function mkOp(n: number): Operation {
	return {
		id: `srv5-${n}`,
		nodeId: 'writer',
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${n}`,
		data: { title: `t${n}` },
		previousData: null,
		timestamp: { wallTime: 1_700_000_000_000 + n, logical: 0, nodeId: 'writer' },
		sequenceNumber: n,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('SRV-5 delivery stream memory / scan cost', () => {
	test('initial-sync delivery stream sends its first batch before scanning the whole log', async () => {
		const N = 5000
		const store = new MemoryServerStore('srv5')
		await store.setSchema(schema)
		for (let i = 1; i <= N; i++) await store.applyRemoteOperation(mkOp(i))

		let scannedBeforeFirstSend: number | null = null
		let scanned = 0
		let entriesVisited = 0
		const original = store.getOperationsAfterDelivery.bind(store)
		store.getOperationsAfterDelivery = async (after: number, limit: number) => {
			const chunk = await original(after, limit)
			scanned += chunk.length
			// MemoryServerStore walks from the head of the log each call.
			entriesVisited += Math.min(N, after + chunk.length)
			return chunk
		}

		const server = new KoraSyncServer({ store, batchSize: 100 })
		const { client, server: transport } = createServerTransportPair()
		const batches: SyncMessage[] = []
		client.onMessage((m) => {
			if (m.type === 'operation-batch') {
				if (scannedBeforeFirstSend === null) scannedBeforeFirstSend = scanned
				batches.push(m)
			}
		})
		server.handleConnection(transport)
		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'reader',
			versionVector: {},
			schemaVersion: 1,
			lastDeliverySequence: 0,
		} as SyncMessage)
		await vi.waitFor(
			() => expect(batches.some((m) => m.type === 'operation-batch' && m.isFinal)).toBe(true),
			{ timeout: 20000 },
		)
		await server.stop()
		console.log(
			`SRV-5 N=${N} scannedBeforeFirstSend=${scannedBeforeFirstSend} memoryStoreEntriesVisited=${entriesVisited} (linear would be ${N})`,
		)
		// Paginated streaming: at most one scan chunk (batchSize*5) read before sending.
		expect(scannedBeforeFirstSend).not.toBeNull()
		expect(scannedBeforeFirstSend as unknown as number).toBeLessThanOrEqual(500)
	}, 30000)
})
