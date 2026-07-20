import { HybridLogicalClock, defineSchema, t } from '@korajs/core'
import type { Operation, OperationInput } from '@korajs/core'
import { computeOperationId } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import {
	decodeRichtextOpDataValue,
	isKoraBytesValue,
} from '../../src/serialization/op-data-encoding'
import { richtextToPlainText } from '../../src/serialization/richtext-serializer'
import { Store } from '../../src/store/store'

const richtextSchema = defineSchema({
	version: 1,
	collections: {
		articles: {
			fields: {
				title: t.string(),
				body: t.richtext().optional(),
			},
		},
	},
})

/** Real Yjs state update — what a richtext controller persists. */
function makeYjsUpdate(text: string): Uint8Array {
	const doc = new Y.Doc()
	doc.getText('content').insert(0, text)
	return Y.encodeStateAsUpdate(doc)
}

/**
 * Re-derive an operation's content-addressed id from its own (deserialized)
 * fields, exactly as the creation path hashed them. Before binary richtext
 * values were canonicalized in op.data this check was impossible: the hash was
 * computed over a live Uint8Array that persisted as a different JSON value.
 */
async function deriveId(op: Operation): Promise<string> {
	const input: OperationInput = {
		nodeId: op.nodeId,
		type: op.type,
		collection: op.collection,
		recordId: op.recordId,
		data: op.data,
		previousData: op.previousData,
		sequenceNumber: op.sequenceNumber,
		causalDeps: op.causalDeps,
		schemaVersion: op.schemaVersion,
		...(op.atomicOps !== undefined ? { atomicOps: op.atomicOps } : {}),
	}
	return computeOperationId(input, HybridLogicalClock.serialize(op.timestamp))
}

function toByteArray(value: unknown): number[] {
	if (value instanceof Uint8Array) {
		return Array.from(value)
	}
	if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
		return Array.from(new Uint8Array(value))
	}
	throw new Error(`Expected bytes, got ${typeof value}`)
}

describe('Integration: canonical binary richtext encoding in op.data', () => {
	let adapter: BetterSqlite3Adapter
	let store: Store

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema: richtextSchema, adapter, nodeId: 'node-a' })
		await store.open()
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await store.close()
	})

	test('insert with Uint8Array: persisted op holds tagged form and round-trip hash matches', async () => {
		const update = makeYjsUpdate('binary body')
		const record = await store.collection('articles').insert({ title: 'a', body: update })

		// Read the op back through the full persist → load cycle.
		const ops = await store.getAllOperations()
		expect(ops).toHaveLength(1)
		const op = ops[0]
		if (!op?.data) throw new Error('missing op data')

		// op.data holds the canonical tagged form, not a numeric-key object.
		expect(isKoraBytesValue(op.data.body)).toBe(true)

		// Round-trip hash fidelity: the id recomputed from the DESERIALIZED op
		// equals the stored id, so hash input === persisted JSON === wire payload.
		expect(await deriveId(op)).toBe(op.id)

		// The tagged form decodes back to the exact original bytes.
		expect(toByteArray(decodeRichtextOpDataValue(op.data.body))).toEqual(Array.from(update))

		// The materialized column still holds the raw bytes.
		const found = await store.collection('articles').findById(record.id)
		expect(toByteArray(found?.body)).toEqual(Array.from(update))
	})

	test('insert with ArrayBuffer: no silent data loss, hash round-trips', async () => {
		const update = makeYjsUpdate('array buffer body')
		const buffer = update.slice().buffer
		const record = await store.collection('articles').insert({ title: 'ab', body: buffer })

		const ops = await store.getAllOperations()
		const op = ops[0]
		if (!op?.data) throw new Error('missing op data')

		// Previously an ArrayBuffer JSON-serialized to {} — total silent loss.
		expect(op.data.body).not.toEqual({})
		expect(isKoraBytesValue(op.data.body)).toBe(true)
		expect(toByteArray(decodeRichtextOpDataValue(op.data.body))).toEqual(Array.from(update))
		expect(await deriveId(op)).toBe(op.id)

		const found = await store.collection('articles').findById(record.id)
		expect(toByteArray(found?.body)).toEqual(Array.from(update))
	})

	test('persisted op applies on a second store with byte-identical richtext column', async () => {
		const update = makeYjsUpdate('replicated body')
		const record = await store.collection('articles').insert({ title: 'r', body: update })

		// The op as another replica would receive it: persisted, then loaded.
		const ops = await store.getAllOperations()
		const op = ops[0]
		if (!op) throw new Error('missing op')

		const adapterB = new BetterSqlite3Adapter(':memory:')
		const storeB = new Store({ schema: richtextSchema, adapter: adapterB, nodeId: 'node-b' })
		await storeB.open()
		try {
			const result = await storeB.applyRemoteOperation(op)
			expect(result).toBe('applied')

			const rows = await adapterB.query<{ body: unknown }>(
				'SELECT body FROM articles WHERE id = ?',
				[record.id],
			)
			expect(rows).toHaveLength(1)
			// Byte-identical to the original encode on the source store.
			expect(toByteArray(rows[0]?.body)).toEqual(Array.from(update))

			const found = await storeB.collection('articles').findById(record.id)
			expect(richtextToPlainText(found?.body as Uint8Array)).toBe('replicated body')
		} finally {
			await storeB.close()
		}
	})

	test('update: op.data and previousData both carry the tagged form and hash round-trips', async () => {
		const first = makeYjsUpdate('v1')
		const second = makeYjsUpdate('v1 then v2')
		const record = await store.collection('articles').insert({ title: 'u', body: first })
		await store.collection('articles').update(record.id, { body: second })

		const ops = await store.getAllOperations()
		const updateOp = ops.find((op) => op.type === 'update')
		if (!updateOp?.data || !updateOp.previousData) throw new Error('missing update op payloads')

		expect(isKoraBytesValue(updateOp.data.body)).toBe(true)
		expect(isKoraBytesValue(updateOp.previousData.body)).toBe(true)
		expect(toByteArray(decodeRichtextOpDataValue(updateOp.data.body))).toEqual(Array.from(second))
		expect(toByteArray(decodeRichtextOpDataValue(updateOp.previousData.body))).toEqual(
			Array.from(first),
		)
		expect(await deriveId(updateOp)).toBe(updateOp.id)
	})

	test('rebase re-derives matching ids for ops with tagged binary values', async () => {
		const update = makeYjsUpdate('rebase me')
		const realNow = Date.now()
		const future = realNow + 10 * 60_000

		// Create the op with a fast clock so it qualifies for rebase.
		const spy = vi.spyOn(Date, 'now').mockReturnValue(future)
		try {
			await store.collection('articles').insert({ title: 'rb', body: update })
		} finally {
			spy.mockRestore()
		}

		const originalOps = await store.getAllOperations()
		expect(originalOps).toHaveLength(1)

		const result = await store.rebaseUnsyncedOperations(
			originalOps.map((op) => op.id),
			realNow,
		)
		expect(result.rebasedCount).toBe(1)
		const rebased = result.operations[0]
		if (!rebased?.data) throw new Error('missing rebased op')

		// The re-derived content hash matches: the tagged value canonicalizes
		// identically at creation, persistence, and rebase time.
		expect(await deriveId(rebased)).toBe(rebased.id)

		// Decoded bytes unchanged by the rebase.
		expect(isKoraBytesValue(rebased.data.body)).toBe(true)
		expect(toByteArray(decodeRichtextOpDataValue(rebased.data.body))).toEqual(Array.from(update))

		// And the persisted log agrees after the rewrite.
		const logAfter = await store.getAllOperations()
		expect(logAfter[0]?.id).toBe(rebased.id)
		expect(await deriveId(logAfter[0] as Operation)).toBe(rebased.id)
	})

	test('string richtext values behave exactly as before (regression)', async () => {
		const record = await store.collection('articles').insert({ title: 's', body: 'plain text' })

		const ops = await store.getAllOperations()
		const op = ops[0]
		if (!op?.data) throw new Error('missing op data')

		// Strings pass through untagged — every pre-fix op stays byte-identical.
		expect(op.data.body).toBe('plain text')
		expect(await deriveId(op)).toBe(op.id)

		// Column behavior unchanged: string encoded as a Yjs doc containing it.
		const found = await store.collection('articles').findById(record.id)
		expect(found?.body).toBeInstanceOf(Uint8Array)
		expect(richtextToPlainText(found?.body as Uint8Array)).toBe('plain text')

		// Remote apply of a string-bodied op also unchanged.
		const adapterB = new BetterSqlite3Adapter(':memory:')
		const storeB = new Store({ schema: richtextSchema, adapter: adapterB, nodeId: 'node-b' })
		await storeB.open()
		try {
			expect(await storeB.applyRemoteOperation(op)).toBe('applied')
			const foundB = await storeB.collection('articles').findById(record.id)
			expect(richtextToPlainText(foundB?.body as Uint8Array)).toBe('plain text')
		} finally {
			await storeB.close()
		}
	})

	test('transaction inserts tag binary richtext and expose decoded effective records', async () => {
		const update = makeYjsUpdate('tx body')
		let insertedId = ''
		await store.transaction(async (tx) => {
			const inserted = await tx.collection('articles').insert({ title: 'tx', body: update })
			insertedId = inserted.id
			// Effective record inside the transaction exposes record-shaped bytes,
			// not the tagged op-data form.
			const effective = await tx.collection('articles').findById(inserted.id)
			expect(toByteArray(effective?.body)).toEqual(Array.from(update))
		})

		const ops = await store.getAllOperations()
		const op = ops[0]
		if (!op?.data) throw new Error('missing op data')
		expect(isKoraBytesValue(op.data.body)).toBe(true)
		expect(await deriveId(op)).toBe(op.id)

		const found = await store.collection('articles').findById(insertedId)
		expect(toByteArray(found?.body)).toEqual(Array.from(update))
	})
})
