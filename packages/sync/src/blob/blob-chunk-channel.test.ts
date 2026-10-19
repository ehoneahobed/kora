import { describe, expect, test, vi } from 'vitest'
import type {
	BlobChunkPushMessage,
	BlobChunkRequestMessage,
	BlobChunkResponseMessage,
} from '../protocol/messages'
import {
	BlobChunkChannel,
	type BlobChunkChannelMessage,
	type BlobChunkHandlerError,
	decodeBlobChunkBytes,
	encodeBlobChunkBytes,
} from './blob-chunk-channel'

describe('blob chunk channel', () => {
	test('base64 round-trips arbitrary bytes including high values and zero', () => {
		const bytes = new Uint8Array([0, 1, 127, 128, 200, 255, 0, 42])
		expect(decodeBlobChunkBytes(encodeBlobChunkBytes(bytes))).toEqual(bytes)
	})

	test('send emits a request message with a generated messageId', () => {
		const sent: Array<BlobChunkRequestMessage | BlobChunkResponseMessage | BlobChunkPushMessage> =
			[]
		const channel = new BlobChunkChannel({
			onSend: (m) => {
				sent.push(m)
				return true
			},
		})

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
		const sent: Array<BlobChunkRequestMessage | BlobChunkResponseMessage | BlobChunkPushMessage> =
			[]
		const channel = new BlobChunkChannel({
			onSend: (m) => {
				sent.push(m)
				return true
			},
		})
		const bytes = new Uint8Array([10, 20, 30])

		channel.send({ type: 'blob-chunk-response', requestId: 'r2', bytes })

		const msg = sent[0] as BlobChunkResponseMessage
		expect(msg.type).toBe('blob-chunk-response')
		expect(msg.requestId).toBe('r2')
		expect(msg.bytes).toBe(encodeBlobChunkBytes(bytes))
	})

	test('send carries a null response (responder does not hold the hash) as null', () => {
		const sent: Array<BlobChunkRequestMessage | BlobChunkResponseMessage | BlobChunkPushMessage> =
			[]
		const channel = new BlobChunkChannel({
			onSend: (m) => {
				sent.push(m)
				return true
			},
		})

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
		const sent: Array<BlobChunkRequestMessage | BlobChunkResponseMessage | BlobChunkPushMessage> =
			[]
		const channel = new BlobChunkChannel({
			onSend: (m) => {
				sent.push(m)
				return true
			},
		})
		const bytes = new Uint8Array([3, 1, 4, 1, 5])

		channel.send({ type: 'blob-chunk-push', hash: 'deadbeef', bytes })

		const msg = sent[0] as unknown as {
			type: string
			hash: string
			bytes: string
			messageId: string
		}
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

	test('send reports whether the message went out', () => {
		expect(
			new BlobChunkChannel().send({ type: 'blob-chunk-request', requestId: 'r', hash: 'h' }),
		).toBe(false)
		let accept = false
		const channel = new BlobChunkChannel({ onSend: () => accept })
		const request = { type: 'blob-chunk-request' as const, requestId: 'r', hash: 'h' }
		expect(channel.send(request)).toBe(false)
		accept = true
		expect(channel.send(request)).toBe(true)
		// A handler written against the earlier void signature counts as sent.
		const legacy = new BlobChunkChannel({ onSend: () => undefined })
		expect(legacy.send({ type: 'blob-chunk-response', requestId: 'r', bytes: null })).toBe(true)
	})

	test('onReady handlers run on every notifyReady until removed; one throwing does not stop the rest', () => {
		const channel = new BlobChunkChannel()
		const calls: string[] = []
		channel.onReady(() => {
			throw new Error('boom')
		})
		const remove = channel.onReady(() => calls.push('a'))
		channel.onReady(() => calls.push('b'))
		channel.notifyReady()
		channel.notifyReady()
		remove()
		channel.notifyReady()
		expect(calls).toEqual(['a', 'b', 'a', 'b', 'b'])
	})
})

describe('blob chunk channel: a throwing handler is isolated and reported', () => {
	const request: BlobChunkRequestMessage = {
		type: 'blob-chunk-request',
		messageId: 'm1',
		requestId: 'r1',
		hash: 'h',
	}

	test('a ready handler that throws is reported; the others still run', () => {
		const reported: BlobChunkHandlerError[] = []
		const channel = new BlobChunkChannel({ onHandlerError: (e) => reported.push(e) })
		const boom = new Error('ready boom')
		const calls: string[] = []
		channel.onReady(() => {
			throw boom
		})
		channel.onReady(() => calls.push('after'))
		channel.notifyReady()
		expect(calls).toEqual(['after'])
		expect(reported).toEqual([{ phase: 'ready', error: boom }])
	})

	test('a message handler that throws is reported; the others still receive the message', () => {
		const reported: BlobChunkHandlerError[] = []
		const channel = new BlobChunkChannel({ onHandlerError: (e) => reported.push(e) })
		const boom = new Error('message boom')
		const received: string[] = []
		channel.onMessage(() => {
			throw boom
		})
		channel.onMessage((m) => received.push(m.type))
		expect(() => channel.deliver(request)).not.toThrow()
		expect(received).toEqual(['blob-chunk-request'])
		expect(reported).toEqual([{ phase: 'message', messageType: 'blob-chunk-request', error: boom }])
	})

	test('without an error sink a throwing handler is logged, never swallowed', () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		try {
			const channel = new BlobChunkChannel()
			channel.onReady(() => {
				throw new Error('unseen')
			})
			channel.notifyReady()
			expect(logged).toHaveBeenCalledTimes(1)
			expect(String(logged.mock.calls[0]?.[0])).toContain('blob chunk ready handler')
		} finally {
			logged.mockRestore()
		}
	})

	test('a sink that throws does not break delivery to later handlers', () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		try {
			const channel = new BlobChunkChannel({
				onHandlerError: () => {
					throw new Error('sink boom')
				},
			})
			const received: string[] = []
			channel.onMessage(() => {
				throw new Error('handler boom')
			})
			channel.onMessage((m) => received.push(m.type))
			expect(() => channel.deliver(request)).not.toThrow()
			expect(received).toEqual(['blob-chunk-request'])
			expect(logged).toHaveBeenCalled()
		} finally {
			logged.mockRestore()
		}
	})
})
