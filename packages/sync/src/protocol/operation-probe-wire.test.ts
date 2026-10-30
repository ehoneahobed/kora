import { describe, expect, test } from 'vitest'
import type { SyncMessage } from './messages'
import { isHandshakeMessage, isHandshakeResponseMessage } from './messages'
import { NegotiatedMessageSerializer } from './protobuf-serializer'

/**
 * The handshake's operation probe (shared-browser repair): the ids a client asks about
 * and the server's answer must survive every wire format exactly. A lost or truncated
 * answer would read as "not stored" and re-author a write the server holds.
 */
const formats = ['json', 'protobuf'] as const

const handshake: Extract<SyncMessage, { type: 'handshake' }> = {
	type: 'handshake',
	messageId: 'm1',
	nodeId: 'n1',
	versionVector: { a: 3 },
	schemaVersion: 1,
	probeOperationIds: ['a'.repeat(64), 'b'.repeat(64)],
}

const response: Extract<SyncMessage, { type: 'handshake-response' }> = {
	type: 'handshake-response',
	messageId: 'm2',
	nodeId: 'server',
	versionVector: {},
	schemaVersion: 1,
	accepted: true,
	operationProbe: { stored: ['b'.repeat(64)] },
}

describe('operation probe wire round-trip', () => {
	for (const format of formats) {
		test(`the question and the answer survive ${format}`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const asked = serializer.decode(serializer.encode(handshake))
			expect(isHandshakeMessage(asked)).toBe(true)
			expect(asked).toMatchObject({ probeOperationIds: handshake.probeOperationIds })
			const answered = serializer.decode(serializer.encode(response))
			expect(isHandshakeResponseMessage(answered)).toBe(true)
			expect(answered).toMatchObject({ operationProbe: { stored: ['b'.repeat(64)] } })
		})

		test(`an empty answer stays an answer, and no answer stays absent, over ${format}`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const empty = serializer.decode(
				serializer.encode({ ...response, operationProbe: { stored: [] } }),
			)
			expect(empty).toMatchObject({ operationProbe: { stored: [] } })
			const { operationProbe: _answer, ...unanswered } = response
			expect(serializer.decode(serializer.encode(unanswered))).not.toHaveProperty('operationProbe')
			const { probeOperationIds: _asked, ...plain } = handshake
			expect(serializer.decode(serializer.encode(plain))).not.toHaveProperty('probeOperationIds')
		})
	}
})
