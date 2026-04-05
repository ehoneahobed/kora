import type { SyncMessage } from '@korajs/sync'
import { JsonMessageSerializer, ProtobufMessageSerializer } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { HttpServerTransport } from './http-server-transport'

function handshakeMessage(): SyncMessage {
	return {
		type: 'handshake',
		messageId: 'hs-1',
		nodeId: 'client-1',
		versionVector: {},
		schemaVersion: 1,
	}
}

describe('HttpServerTransport', () => {
	test('decodes inbound payloads and emits server messages', () => {
		const serializer = new JsonMessageSerializer()
		const transport = new HttpServerTransport(serializer)

		const onMessage = vi.fn()
		transport.onMessage(onMessage)

		transport.receive(serializer.encode(handshakeMessage()))

		expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'handshake' }))
	})

	test('poll returns queued outbound message with ETag', () => {
		const transport = new HttpServerTransport(new JsonMessageSerializer())

		transport.send({
			type: 'acknowledgment',
			messageId: 'ack-1',
			acknowledgedMessageId: 'msg-1',
			lastSequenceNumber: 1,
		})

		const unchanged = transport.poll('W/"1"')
		expect(unchanged.status).toBe(304)

		const delivered = transport.poll()
		expect(delivered.status).toBe(200)
		expect(delivered.headers?.etag).toBe('W/"1"')
		expect(delivered.headers?.['content-type']).toBe('application/json')
		expect(typeof delivered.body).toBe('string')
	})

	test('poll returns binary protobuf payload when serializer is protobuf', () => {
		const transport = new HttpServerTransport(new ProtobufMessageSerializer())

		transport.send({
			type: 'acknowledgment',
			messageId: 'ack-1',
			acknowledgedMessageId: 'msg-1',
			lastSequenceNumber: 1,
		})

		const response = transport.poll()
		expect(response.status).toBe(200)
		expect(response.headers?.['content-type']).toBe('application/x-protobuf')
		expect(response.body).toBeInstanceOf(Uint8Array)
	})
})
