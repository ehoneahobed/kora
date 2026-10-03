/**
 * RT-65: a value a store cannot hold never fails the session. An identifier with
 * U+0000 or a lone surrogate is refused terminally before any store work; a database
 * refusal of a value surfaces as a non-retriable UNSTORABLE_VALUE rejection, and the
 * device's later writes still go through.
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { withContentId } from '../../tests/fixtures/content-id'
import { KoraSyncServer } from '../server/kora-sync-server'
import { MemoryServerStore } from '../store/memory-server-store'
import { UnstorableValueError } from '../store/server-store'
import { createServerTransportPair } from '../transport/memory-server-transport'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string() } } },
})

function note(seq: number, partial: Partial<Operation> = {}): Operation {
	return withContentId({
		id: '',
		nodeId: 'device-a',
		type: 'insert',
		collection: 'notes',
		recordId: `r${seq}`,
		data: { title: `t${seq}` },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: seq, nodeId: 'device-a' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	})
}

async function connect(store: MemoryServerStore) {
	await store.setSchema(schema)
	const server = new KoraSyncServer({
		store,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
	})
	const { client, server: transport } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	server.handleConnection(transport)
	client.send({
		type: 'handshake',
		messageId: 'hs',
		nodeId: 'device-a',
		versionVector: {},
		schemaVersion: 1,
		protocolVersion: 2,
		sequenceReservation: true,
	} as unknown as SyncMessage)
	await vi.waitFor(() => expect(messages.some((m) => m.type === 'handshake-response')).toBe(true))
	const send = (ops: Operation[], id: string) =>
		client.send({
			type: 'operation-batch',
			messageId: id,
			operations: ops,
			isFinal: true,
			batchIndex: 0,
		})
	const acked = (id: string) =>
		vi.waitFor(() =>
			expect(
				messages.some((m) => m.type === 'acknowledgment' && m.acknowledgedMessageId === id),
			).toBe(true),
		)
	return { server, messages, send, acked }
}

const rejections = (messages: SyncMessage[]) =>
	messages.flatMap((m) => (m.type === 'operation-rejected' ? [m] : []))

describe('RT-65: unstorable values never fail the session', () => {
	test('an identifier with U+0000 or a lone surrogate is refused terminally', async () => {
		const store = new MemoryServerStore()
		const { server, messages, send, acked } = await connect(store)
		send([note(1, { recordId: 'bad\u0000id' }), note(2, { recordId: 'bad\ud800' }), note(3)], 'b1')
		await acked('b1')
		expect(rejections(messages).map((r) => [r.code, r.retriable])).toEqual([
			['INVALID_IDENTIFIER', false],
			['INVALID_IDENTIFIER', false],
		])
		expect(await store.findRecord('notes', 'r3')).toMatchObject({ title: 't3' })
		expect(messages.some((m) => m.type === 'error')).toBe(false)
		await server.stop()
	})

	test('a database refusal of a value is a non-retriable rejection, not a dropped session', async () => {
		const store = new MemoryServerStore()
		const original = store.applyRemoteOperation.bind(store)
		vi.spyOn(store, 'applyRemoteOperation').mockImplementation(async (op, options) => {
			if (op.recordId === 'r1') throw new UnstorableValueError(op, 'SQLSTATE 22021: test')
			return original(op, options)
		})
		const { server, messages, send, acked } = await connect(store)
		send([note(1), note(2)], 'b1')
		await acked('b1')
		expect(rejections(messages).map((r) => [r.code, r.retriable])).toEqual([
			['UNSTORABLE_VALUE', false],
		])
		expect(await store.findRecord('notes', 'r2')).toMatchObject({ title: 't2' })
		expect(messages.some((m) => m.type === 'error')).toBe(false)
		await server.stop()
	})
})
