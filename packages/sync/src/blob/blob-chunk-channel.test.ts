import { describe, expect, test } from 'vitest'
import type { BlobChunkRequestMessage, BlobChunkResponseMessage } from '../protocol/messages'
import {
	BlobChunkChannel,
	type BlobChunkChannelMessage,
	decodeBlobChunkBytes,
	encodeBlobChunkBytes,
} from './blob-chunk-channel'

describe('blob chunk channel', () => {
	test('base64 round-trips arbitrary bytes including high values and zero', () => {
		const bytes = new Uint8Array([0, 1, 127, 128, 200, 255, 0, 42])
		expect(decodeBlobChunkBytes(encodeBlobChunkBytes(bytes))).toEqual(bytes)
	})

	test('send emits a request message with a generated messageId', () => {
		const sent: Array<BlobChunkRequestMessage | BlobChunkResponseMessage> = []
		const channel = new BlobChunkChannel({ onSend: (m) => sent.push(m) })

		channel.send({ type: 'blob-chunk-request', requestId: 'r1', hash: 'abc' })

		expect(sent).toHaveLength(1)
		const msg = sent[0] as BlobChunkRequestMessage
		expect(msg.type).toBe('blob-chunk-request')
		expect(msg.requestId).toBe('r1')
		expect(msg.hash).toBe('abc')
		expect(typeof msg.messageId).toBe('string')
		expect(msg.messageId.length).toBeGreaterThan(0)
	})

	test('send base64-encodes response bytes onto the wire', () => {
		const sent: Array<BlobChunkRequestMessage | BlobChunkResponseMessage> = []
		const channel = new BlobChunkChannel({ onSend: (m) => sent.push(m) })
		const bytes = new Uint8Array([10, 20, 30])

		channel.send({ type: 'blob-chunk-response', requestId: 'r2', bytes })

		const msg = sent[0] as BlobChunkResponseMessage
		expect(msg.type).toBe('blob-chunk-response')
		expect(msg.requestId).toBe('r2')
		expect(msg.bytes).toBe(encodeBlobChunkBytes(bytes))
	})

	test('send carries a null response (responder does not hold the hash) as null', () => {
		const sent: Array<BlobChunkRequestMessage | BlobChunkResponseMessage> = []
		const channel = new BlobChunkChannel({ onSend: (m) => sent.push(m) })

		channel.send({ type: 'blob-chunk-response', requestId: 'r3', bytes: null })

		const msg = sent[0] as BlobChunkResponseMessage
		expect(msg.bytes).toBeNull()
	})

	test('deliver decodes response bytes back to a Uint8Array for handlers', () => {
		const received: BlobChunkChannelMessage[] = []
		const channel = new BlobChunkChannel()
		channel.onMessage((m) => received.push(m))

		const bytes = new Uint8Array([5, 6, 7, 255])
		channel.deliver({
			type: 'blob-chunk-response',
			messageId: 'm1',
			requestId: 'r4',
			bytes: encodeBlobChunkBytes(bytes),
		})

		expect(received).toHaveLength(1)
		const msg = received[0]
		expect(msg?.type).toBe('blob-chunk-response')
		if (msg?.type === 'blob-chunk-response') {
			expect(msg.bytes).toEqual(bytes)
		}
	})

	test('deliver passes request messages through unchanged', () => {
		const received: BlobChunkChannelMessage[] = []
		const channel = new BlobChunkChannel()
		channel.onMessage((m) => received.push(m))

		channel.deliver({ type: 'blob-chunk-request', messageId: 'm2', requestId: 'r5', hash: 'zzz' })

		const msg = received[0]
		expect(msg).toEqual({ type: 'blob-chunk-request', requestId: 'r5', hash: 'zzz' })
	})

	test('onMessage unsubscribe stops delivery', () => {
		const received: BlobChunkChannelMessage[] = []
		const channel = new BlobChunkChannel()
		const off = channel.onMessage((m) => received.push(m))
		off()

		channel.deliver({ type: 'blob-chunk-request', messageId: 'm3', requestId: 'r6', hash: 'h' })
		expect(received).toHaveLength(0)
	})

	test('send base64-encodes a blob-chunk-push onto the wire', () => {
		const sent: Array<BlobChunkRequestMessage | BlobChunkResponseMessage> = []
		const channel = new BlobChunkChannel({ onSend: (m) => sent.push(m as never) })
		const bytes = new Uint8Array([3, 1, 4, 1, 5])

		channel.send({ type: 'blob-chunk-push', hash: 'deadbeef', bytes })

		const msg = sent[0] as { type: string; hash: string; bytes: string; messageId: string }
		expect(msg.type).toBe('blob-chunk-push')
		expect(msg.hash).toBe('deadbeef')
		expect(msg.bytes).toBe(encodeBlobChunkBytes(bytes))
		expect(typeof msg.messageId).toBe('string')
	})

	test('deliver decodes a blob-chunk-push back to Uint8Array bytes', () => {
		const received: BlobChunkChannelMessage[] = []
		const channel = new BlobChunkChannel()
		channel.onMessage((m) => received.push(m))
		const bytes = new Uint8Array([9, 8, 7])

		channel.deliver({
			type: 'blob-chunk-push',
			messageId: 'mp',
			hash: 'abcd',
			bytes: encodeBlobChunkBytes(bytes),
		})

		const msg = received[0]
		expect(msg?.type).toBe('blob-chunk-push')
		if (msg?.type === 'blob-chunk-push') {
			expect(msg.hash).toBe('abcd')
			expect(msg.bytes).toEqual(bytes)
		}
	})

	test('send is a safe no-op when no transport is attached', () => {
		const channel = new BlobChunkChannel()
		expect(() =>
			channel.send({ type: 'blob-chunk-request', requestId: 'r7', hash: 'h' }),
		).not.toThrow()
	})
})
