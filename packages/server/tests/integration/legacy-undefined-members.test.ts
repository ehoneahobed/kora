/**
 * RT-71: a beta.13 (protocol 1) client hashes an `undefined` object member as
 * `"key":null`, and its JSON upload no longer holds the member. The server rebuilds
 * the forms it can (an update's cleared fields from `previousData`; declared nested
 * members with the schema), stores an update's cleared fields as `null` (what the
 * writer applied, same version-1 hash), and stores any other unverifiable protocol-1 id
 * unverified (logged, counted, no declared hash version). A protocol-2 session never
 * gets the unverified path (RT-64).
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { withContentId } from '../fixtures/content-id'
import { createHarness, sendAndAwaitAck } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				assignee: t.string().optional(),
				meta: t.object({ a: t.number().optional(), b: t.string().optional() }).optional(),
				extra: t.json().optional(),
			},
		},
	},
})

/** What a beta.13 client uploads: id over the in-memory data, data after a JSON round trip. */
function legacyOp(nodeId: string, seq: number, partial: Partial<Operation>): Operation {
	const built = withContentId({
		id: '',
		nodeId,
		type: 'insert',
		collection: 'notes',
		recordId: 'n-1',
		data: {},
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: seq, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	} as Operation)
	return JSON.parse(JSON.stringify(built)) as Operation
}

async function setup(protocolVersion?: number) {
	const store = new MemoryServerStore('server-1')
	const { server, login } = await createHarness(schema, null, {}, store)
	const client = await login(
		't',
		'legacy-node',
		protocolVersion === undefined ? {} : { protocolVersion },
	)
	const unverified = (): number =>
		server.getMetricsCollector().getSnapshot(0).unverifiedLegacyOperations
	return { store, server, client, unverified }
}

describe('beta.13 undefined members (RT-71)', () => {
	test('an update clearing a field is stored verified, with the field null', async () => {
		const { store, server, client, unverified } = await setup()
		const insert = legacyOp('legacy-node', 1, { data: { title: 'x', assignee: 'bob' } })
		const update = legacyOp('legacy-node', 2, {
			type: 'update',
			data: { title: 'y', assignee: undefined },
			previousData: { title: 'x', assignee: 'bob' },
			causalDeps: [insert.id],
		})
		await sendAndAwaitAck(client, [insert, update])
		const stored = store.getAllOperations().find((o) => o.id === update.id)
		expect(stored?.hashVersion).toBe(1)
		expect(stored?.data).toEqual({ title: 'y', assignee: null })
		expect((await store.findRecord('notes', 'n-1'))?.assignee ?? null).toBeNull()
		expect(unverified()).toBe(0)
		await server.stop()
	})

	test('a nested undefined member is verified with the schema, stored without a declared version', async () => {
		const { store, server, client, unverified } = await setup()
		const insert = legacyOp('legacy-node', 1, {
			data: { title: 'x', meta: { a: 1, b: undefined } },
		})
		await sendAndAwaitAck(client, [insert])
		const stored = store.getAllOperations().find((o) => o.id === insert.id)
		expect(stored).toBeDefined()
		expect(stored?.hashVersion).toBeUndefined()
		expect(unverified()).toBe(0)
		await server.stop()
	})

	test('an unrecoverable form (undefined inside a json value) is stored unverified and reported', async () => {
		const { store, server, client, unverified } = await setup()
		const insert = legacyOp('legacy-node', 1, { data: { title: 'x', extra: { k: undefined } } })
		await sendAndAwaitAck(client, [insert])
		const stored = store.getAllOperations().find((o) => o.id === insert.id)
		expect(stored?.hashVersion).toBeUndefined()
		expect(unverified()).toBe(1)
		await server.stop()
	})

	test('a protocol-2 session is refused the same unverifiable id (RT-64)', async () => {
		const { store, server, client, unverified } = await setup(2)
		const insert = legacyOp('legacy-node', 1, { data: { title: 'x', extra: { k: undefined } } })
		await sendAndAwaitAck(client, [insert])
		expect(store.getAllOperations().some((o) => o.id === insert.id)).toBe(false)
		expect(
			client.messages.some(
				(m) =>
					m.type === 'operation-rejected' &&
					m.operationId === insert.id &&
					m.code === 'INVALID_OPERATION_ID',
			),
		).toBe(true)
		expect(unverified()).toBe(0)
		await server.stop()
	})
})
