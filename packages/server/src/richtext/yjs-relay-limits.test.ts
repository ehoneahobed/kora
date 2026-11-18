import { generateUUIDv7 } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { encodeYjsUpdate } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { KoraSyncServer } from '../server/kora-sync-server'
import { MemoryServerStore } from '../store/memory-server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'

/**
 * A live rich-text update (yjs-doc-update) costs the server a store read and fans out to every
 * peer in scope. A writer that floods them would push peers past their send buffer: each
 * session gets a budget, and an oversized update is refused. Nothing durable is lost: rich
 * text also travels as operations.
 */
type Pair = ReturnType<typeof createServerTransportPair>

function connect(server: KoraSyncServer, nodeId: string) {
	const pair: Pair = createServerTransportPair()
	const messages: SyncMessage[] = []
	pair.client.onMessage((message) => messages.push(message))
	server.handleConnection(pair.server)
	pair.client.send({
		type: 'handshake',
		protocolVersion: 2,
		messageId: `hs-${nodeId}`,
		nodeId,
		versionVector: {},
		schemaVersion: 1,
	})
	return { pair, messages }
}

const update = (bytes: Uint8Array): SyncMessage => ({
	type: 'yjs-doc-update',
	messageId: generateUUIDv7(),
	collection: 'articles',
	recordId: 'rec-1',
	field: 'body',
	update: encodeYjsUpdate(bytes),
})

const relayed = (messages: SyncMessage[]) =>
	messages.filter((m) => m.type === 'yjs-doc-update').length
const errors = (messages: SyncMessage[], code: string) =>
	messages.filter((m) => m.type === 'error' && (m as { code?: string }).code === code)

describe('yjs-doc-update relays are bounded per session', () => {
	test('a flooding writer is throttled with a retriable error; peers get at most its budget', async () => {
		const server = new KoraSyncServer({
			store: new MemoryServerStore('s'),
			maxYjsUpdatesPerMinute: 50,
		})
		const writer = connect(server, 'writer')
		const peer = connect(server, 'peer')
		await vi.waitFor(() => {
			expect(writer.messages.some((m) => m.type === 'handshake-response')).toBe(true)
			expect(peer.messages.some((m) => m.type === 'handshake-response')).toBe(true)
		})
		for (let i = 0; i < 500; i++) writer.pair.client.send(update(new Uint8Array([1, 2, i % 256])))
		await vi.waitFor(() => expect(relayed(peer.messages)).toBeGreaterThan(0))
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(relayed(peer.messages)).toBeLessThanOrEqual(50)
		const throttled = errors(writer.messages, 'YJS_UPDATE_THROTTLED')
		expect(throttled.length).toBeGreaterThan(0)
		expect(throttled[0]).toMatchObject({ retriable: true })
		await server.stop()
	})

	test('an update over the byte cap is refused and not relayed', async () => {
		const server = new KoraSyncServer({
			store: new MemoryServerStore('s'),
			maxYjsUpdateBytes: 1024,
		})
		const writer = connect(server, 'writer')
		const peer = connect(server, 'peer')
		await vi.waitFor(() => {
			expect(writer.messages.some((m) => m.type === 'handshake-response')).toBe(true)
			expect(peer.messages.some((m) => m.type === 'handshake-response')).toBe(true)
		})
		writer.pair.client.send(update(new Uint8Array(4096)))
		writer.pair.client.send(update(new Uint8Array([7])))
		await vi.waitFor(() => expect(relayed(peer.messages)).toBe(1))
		expect(errors(writer.messages, 'YJS_UPDATE_TOO_LARGE')).toHaveLength(1)
		await server.stop()
	})

	// The cap counts decoded bytes, inclusive: base64 padding is not payload. Sizes cover each
	// padding case (no padding, one '=', two '=').
	test.each([1023, 1024, 1022])(
		'an update of exactly the cap (%i bytes) is relayed; one byte more is refused',
		async (cap) => {
			const server = new KoraSyncServer({
				store: new MemoryServerStore('s'),
				maxYjsUpdateBytes: cap,
			})
			const writer = connect(server, 'writer')
			const peer = connect(server, 'peer')
			await vi.waitFor(() => {
				expect(writer.messages.some((m) => m.type === 'handshake-response')).toBe(true)
				expect(peer.messages.some((m) => m.type === 'handshake-response')).toBe(true)
			})
			writer.pair.client.send(update(new Uint8Array(cap)))
			writer.pair.client.send(update(new Uint8Array(cap + 1)))
			writer.pair.client.send(update(new Uint8Array([7])))
			await vi.waitFor(() => expect(relayed(peer.messages)).toBe(2))
			expect(errors(writer.messages, 'YJS_UPDATE_TOO_LARGE')).toHaveLength(1)
			expect(errors(writer.messages, 'YJS_UPDATE_TOO_LARGE')[0]).toMatchObject({
				message: expect.stringContaining(`${String(cap + 1)} bytes`),
			})
			await server.stop()
		},
	)
})
