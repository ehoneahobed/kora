import protobuf from 'protobufjs/minimal.js'
import { describe, expect, test } from 'vitest'
import type { SyncMessage } from './messages'
import { NegotiatedMessageSerializer } from './serializer'

/**
 * RT-37: the `sequenceReservation` handshake capability tells the server that this
 * client reserves sequence numbers inside the write transaction (so it never puts two
 * different operations under one (node, sequence)). The server enforces
 * SEQUENCE_CONFLICT only for such clients, so the flag must survive every wire format
 * and its absence must stay absent (an old client is treated as legacy).
 */
const formats = ['json', 'protobuf'] as const

const base: Extract<SyncMessage, { type: 'handshake' }> = {
	type: 'handshake',
	messageId: 'm1',
	nodeId: 'n1',
	versionVector: { a: 3 },
	schemaVersion: 1,
}

describe('handshake sequenceReservation wire round-trip (RT-37)', () => {
	for (const format of formats) {
		for (const value of [true, false]) {
			test(`sequenceReservation: ${String(value)} survives ${format}`, () => {
				const serializer = new NegotiatedMessageSerializer(format)
				const decoded = serializer.decode(
					serializer.encode({ ...base, sequenceReservation: value }),
				)
				expect(decoded.type).toBe('handshake')
				if (decoded.type === 'handshake') expect(decoded.sequenceReservation).toBe(value)
			})
		}

		test(`an old client's handshake decodes without the capability over ${format}`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const decoded = serializer.decode(serializer.encode(base))
			expect(decoded).not.toHaveProperty('sequenceReservation')
		})
	}

	test('protobuf: the capability is field 45 (varint); unknown later fields are skipped', () => {
		const serializer = new NegotiatedMessageSerializer('protobuf')
		const bytes = serializer.encode({ ...base, sequenceReservation: true }) as Uint8Array
		// 45 << 3 | 0 = 360, varint-encoded as 0xe8 0x02, followed by bool 1.
		expect(Array.from(bytes.slice(-3))).toEqual([0xe8, 0x02, 0x01])

		const writer = protobuf.Writer.create()
		writer.uint32(10).string('handshake')
		writer.uint32(18).string('m2')
		writer.uint32(26).string('n2')
		writer.uint32(40).int32(1)
		writer.uint32(360).bool(true)
		writer.uint32(8000).bool(true) // field 1000: unknown to this build, skipped
		const decoded = serializer.decode(writer.finish())
		expect(decoded.type === 'handshake' && decoded.sequenceReservation).toBe(true)
	})
})
