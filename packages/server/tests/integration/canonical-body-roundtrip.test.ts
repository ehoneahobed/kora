/**
 * One canonical operation body (RT-72 family: RT-79, RT-80, RT-83). Property: for random
 * operation inputs (json values with Dates, undefined members and elements, -0, nested
 * objects; inserts and updates, including updates that clear with `undefined`), the
 * operation `createOperation` builds keeps its id through every hop:
 * JSON wire and protobuf wire (encode -> decode) -> server store (memory, SQLite,
 * Postgres when KORA_PG_TEST_URL is set) -> load -> protobuf wire again. At every hop
 * the body is canonical and `verifyOperationId` holds.
 */
import { fc } from '@fast-check/vitest'
import {
	HybridLogicalClock,
	canonicalizeOperationBody,
	createOperation,
	defineSchema,
	generateUUIDv7,
	t,
	verifyOperationId,
} from '@korajs/core'
import type { Operation } from '@korajs/core'
import { JsonMessageSerializer, ProtobufMessageSerializer } from '@korajs/sync'
import type { MessageSerializer, SyncMessage } from '@korajs/sync'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				assignee: t.string().optional(),
				extra: t.json().optional(),
			},
		},
	},
})

const kinds = [
	'memory',
	'sqlite',
	...(process.env.KORA_PG_TEST_URL ? (['postgres'] as const) : []),
] as const

let cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn()
	cleanups = []
})

let pgSchemas = 0
async function openStore(kind: (typeof kinds)[number]): Promise<ServerStore> {
	let store: ServerStore
	if (kind === 'memory') store = new MemoryServerStore('server-1')
	else if (kind === 'sqlite') store = createSqliteServerStore({ filename: ':memory:' })
	else {
		const url = process.env.KORA_PG_TEST_URL as string
		pgSchemas += 1
		const name = `kora_canon_${process.pid}_${pgSchemas}`
		const admin = postgres(url, { max: 1, onnotice: () => {} })
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		const client = postgres(url, {
			max: 4,
			idle_timeout: 1,
			onnotice: () => {},
			connection: { search_path: name },
		})
		cleanups.push(async () => {
			await client.end()
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
			await admin.end()
		})
		store = new PostgresServerStore(drizzle(client))
	}
	await store.setSchema(schema)
	cleanups.push(() => store.close())
	return store
}

/** Developer-written json values, the awkward ones included. */
const jsonish: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
	value: fc.oneof(
		{ depthSize: 'small' },
		fc.string(),
		fc.double({ noNaN: true, noDefaultInfinity: true }),
		fc.constant(-0),
		fc.boolean(),
		fc.constant(null),
		fc.constant(undefined),
		fc.date({ noInvalidDate: true, min: new Date(0), max: new Date(4e12) }),
		fc.array(tie('value'), { maxLength: 3 }),
		fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), tie('value'), { maxKeys: 3 }),
	),
})).value

const bodyArb = fc.record({
	title: fc.string({ maxLength: 8 }),
	assignee: fc.option(fc.string({ maxLength: 5 }), { nil: undefined }),
	extra: jsonish,
	// The update: any subset of fields, each possibly `undefined` (a clear).
	update: fc.record(
		{
			title: fc.string({ maxLength: 8 }),
			assignee: fc.constantFrom(undefined, 'eve'),
			extra: jsonish,
		},
		{ requiredKeys: [] },
	),
})

function wire(serializer: MessageSerializer, op: Operation): Operation {
	const message: SyncMessage = {
		type: 'operation-batch',
		messageId: 'm',
		operations: [serializer.encodeOperation(op)],
		isFinal: true,
		batchIndex: 0,
	}
	const decoded = serializer.decode(serializer.encode(message))
	if (decoded.type !== 'operation-batch') throw new Error('not a batch')
	const first = decoded.operations[0]
	if (!first) throw new Error('empty batch')
	return serializer.decodeOperation(first)
}

async function expectSameOp(actual: Operation, expected: Operation): Promise<void> {
	expect(actual.id).toBe(expected.id)
	expect(actual.data).toEqual(expected.data)
	expect(actual.previousData).toEqual(expected.previousData)
	expect(canonicalizeOperationBody(actual)).toEqual(actual)
	expect(await verifyOperationId(actual)).toBe(true)
}

describe.each(kinds)('canonical body round trip through wire and the %s server store', (kind) => {
	test('a json value that is a string (even JSON-looking text) materializes as that string', async () => {
		const store = await openStore(kind)
		const clock = new HybridLogicalClock('device-s')
		const values = ['123', '', 'abc', '"q"', 'true', 'null', '{"a":1}']
		for (const [index, extra] of values.entries()) {
			const op = await createOperation(
				{
					nodeId: 'device-s',
					type: 'insert',
					collection: 'notes',
					recordId: `s-${String(index)}`,
					data: { title: 't', extra },
					previousData: null,
					sequenceNumber: index + 1,
					causalDeps: [],
					schemaVersion: 1,
				},
				clock,
			)
			await store.applyRemoteOperation(op)
			expect((await store.findRecord('notes', `s-${String(index)}`))?.extra).toBe(extra)
		}
	})

	test('random insert + update bodies keep one id from creation to reload', async () => {
		const store = await openStore(kind)
		const json = new JsonMessageSerializer()
		const proto = new ProtobufMessageSerializer()
		const clock = new HybridLogicalClock('device-p')
		let seq = 0
		await fc.assert(
			fc.asyncProperty(bodyArb, async (body) => {
				const recordId = generateUUIDv7()
				const inserted = await createOperation(
					{
						nodeId: 'device-p',
						type: 'insert',
						collection: 'notes',
						recordId,
						data: { title: body.title, assignee: body.assignee, extra: body.extra },
						previousData: null,
						sequenceNumber: ++seq,
						causalDeps: [],
						schemaVersion: 1,
					},
					clock,
				)
				const keys = Object.keys(body.update)
				const ops: Operation[] = [inserted]
				if (keys.length > 0) {
					ops.push(
						await createOperation(
							{
								nodeId: 'device-p',
								type: 'update',
								collection: 'notes',
								recordId,
								data: body.update as Record<string, unknown>,
								previousData: Object.fromEntries(keys.map((key) => [key, inserted.data?.[key]])),
								sequenceNumber: ++seq,
								causalDeps: [inserted.id],
								schemaVersion: 1,
							},
							clock,
						),
					)
				}
				for (const op of ops) {
					await expectSameOp(op, op)
					const viaJson = wire(json, op)
					await expectSameOp(viaJson, op)
					const viaProto = wire(proto, viaJson)
					await expectSameOp(viaProto, op)
					await store.applyRemoteOperation(viaProto)
					const [loaded] = await store.getOperationRange(
						'device-p',
						op.sequenceNumber,
						op.sequenceNumber,
					)
					if (!loaded) throw new Error('not stored')
					await expectSameOp(loaded, op)
					await expectSameOp(wire(proto, loaded), op)
				}
				// What folds is the canonical body: the materialized row holds exactly it
				// (a json string stays a string, an `undefined` in the update cleared the field).
				const expected: Record<string, unknown> = { ...inserted.data, ...ops[1]?.data }
				const row = await store.findRecord('notes', recordId)
				for (const field of ['title', 'assignee', 'extra']) {
					expect(row?.[field] ?? null).toEqual(expected[field] ?? null)
				}
			}),
			{ numRuns: kind === 'postgres' ? 25 : 60 },
		)
	}, 120_000)
})
