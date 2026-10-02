/**
 * RT-29 (richtext half): a server scope-entry insert that carries the record's fold
 * state joins this device's concurrent Yjs edits instead of replacing them by LWW.
 */
import {
	HybridLogicalClock,
	type Operation,
	createOperation,
	defineSchema,
	foldRecord,
	serializeFoldState,
	t,
} from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { ApplyPipeline } from 'korajs/testing'
import { expect, test } from 'vitest'
import * as Y from 'yjs'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.richtext() } } },
}) as unknown as SchemaDefinition

const bytes = (update: Uint8Array) => ({ $koraBytes: Buffer.from(update).toString('base64') })

function edit(base: Uint8Array, clientId: number, at: number, text: string): Uint8Array {
	const doc = new Y.Doc()
	doc.clientID = clientId
	Y.applyUpdate(doc, base)
	doc.getText('content').insert(at, text)
	return Y.encodeStateAsUpdate(doc)
}

test('scope entry joins concurrent richtext edits (RT-29)', async () => {
	const seedDoc = new Y.Doc()
	seedDoc.clientID = 1
	seedDoc.getText('content').insert(0, 'Hello')
	const base = Y.encodeStateAsUpdate(seedDoc)
	const t0 = Date.now() - 60_000
	const clock = (node: string, wall: number) =>
		new HybridLogicalClock(node, { now: () => wall } as never)
	const insert = await createOperation(
		{
			nodeId: 'writer-a',
			type: 'insert',
			collection: 'notes',
			recordId: 'n1',
			data: { body: bytes(base) },
			previousData: null,
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		},
		clock('writer-a', t0),
	)
	const serverEdit = await createOperation(
		{
			nodeId: 'writer-b',
			type: 'update',
			collection: 'notes',
			recordId: 'n1',
			data: { body: bytes(edit(base, 2, 0, 'Say: ')) },
			previousData: { body: bytes(base) },
			sequenceNumber: 1,
			causalDeps: [insert.id],
			schemaVersion: 1,
		},
		clock('writer-b', t0 + 1),
	)

	const store = new Store({
		schema,
		adapter: new BetterSqlite3Adapter(':memory:'),
		emitter: new SimpleEventEmitter(),
	})
	await store.open()
	const pipeline = new ApplyPipeline({ store, emitter: null })
	store.setLocalMutationHandler(pipeline)
	await pipeline.applyRemote(insert)
	// This device appends concurrently.
	await store.collection('notes').update('n1', { body: edit(base, 3, 5, ' world') })

	const serverState = foldRecord([insert, serverEdit], schema).state
	if (!serverState) throw new Error('no state')
	const entry: Operation = {
		...insert,
		id: 'scope-entry-n1',
		nodeId: 'server',
		sequenceNumber: 9,
		data: { body: bytes(edit(base, 2, 0, 'Say: ')) },
		foldState: serializeFoldState(serverState),
	}
	await pipeline.applyRemote(entry)

	const row = await store.collection('notes').findById('n1')
	const doc = new Y.Doc()
	Y.applyUpdate(doc, row?.body as Uint8Array)
	expect(doc.getText('content').toString()).toBe('Say: Hello world')
	await store.close()
})
