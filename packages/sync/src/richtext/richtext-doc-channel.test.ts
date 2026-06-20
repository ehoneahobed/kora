import { describe, expect, test, vi } from 'vitest'
import type { YjsDocUpdateMessage } from '../protocol/messages'
import { decodeYjsUpdate, encodeYjsUpdate } from './doc-channel-wire'
import { RichtextDocChannel } from './richtext-doc-channel'

describe('RichtextDocChannel', () => {
	test('encodes and delivers incremental updates', () => {
		const sent: YjsDocUpdateMessage[] = []
		const channel = new RichtextDocChannel({
			largeDocThreshold: 100,
			onSend: (message) => {
				sent.push(message)
			},
		})

		const received: Uint8Array[] = []
		channel.subscribe('docs', 'rec-1', 'body', (update) => {
			received.push(update)
		})

		const update = new Uint8Array([9, 8, 7])
		channel.send('docs', 'rec-1', 'body', update)

		expect(sent).toHaveLength(1)
		expect(sent[0]?.type).toBe('yjs-doc-update')

		channel.deliver(sent[0] as YjsDocUpdateMessage)
		expect(received).toHaveLength(1)
		expect(Array.from(received[0] as Uint8Array)).toEqual([9, 8, 7])
	})

	test('shouldUseChannel respects preference and threshold', () => {
		const channel = new RichtextDocChannel({ largeDocThreshold: 50 })
		expect(channel.shouldUseChannel(10, true)).toBe(true)
		expect(channel.shouldUseChannel(10, false)).toBe(false)
		expect(channel.shouldUseChannel(10)).toBe(false)
		expect(channel.shouldUseChannel(100)).toBe(true)
	})

	test('wire codec round-trips bytes', () => {
		const bytes = new Uint8Array([1, 2, 255])
		const encoded = encodeYjsUpdate(bytes)
		expect(decodeYjsUpdate(encoded)).toEqual(bytes)
	})

	test('ignores empty send when onSend is unset', () => {
		const channel = new RichtextDocChannel()
		expect(() => channel.send('c', 'r', 'f', new Uint8Array([1]))).not.toThrow()
	})
})
