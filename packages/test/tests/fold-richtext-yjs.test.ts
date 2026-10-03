/**
 * W7 fold + real Yjs: richtext fields fold as a set of opaque Yjs updates and
 * materialize through a Yjs merge. Core has no Yjs dependency, so its gate uses
 * an opaque stand-in; this test drives the same pure fold with real Yjs updates
 * from several concurrently editing documents and checks every delivery order
 * materializes the same text and the same bytes.
 */
import {
	type Operation,
	base64ToBytes,
	bytesToBase64,
	createFoldState,
	defineSchema,
	materialize,
	mergeOp,
	t,
} from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { expect, test } from 'vitest'
import * as Y from 'yjs'

const schema = defineSchema({
	version: 1,
	collections: { docs: { fields: { notes: t.richtext() } } },
}) as unknown as SchemaDefinition

/** The merger Stage B passes to the fold: apply every update to one fresh doc. */
const yjsMerger = (updates: Uint8Array[]): Uint8Array => {
	const doc = new Y.Doc()
	for (const update of updates) Y.applyUpdate(doc, update)
	return Y.encodeStateAsUpdate(doc)
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let x = a
		x = Math.imul(x ^ (x >>> 15), x | 1)
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296
	}
}

function textOf(value: unknown): string {
	const doc = new Y.Doc()
	const tagged = value as { $koraBytes: string }
	Y.applyUpdate(doc, base64ToBytes(tagged.$koraBytes))
	return doc.getText('content').toString()
}

test('richtext folds converge with real Yjs updates in every delivery order', () => {
	for (let seed = 1; seed <= 30; seed++) {
		const rng = mulberry32(seed)
		const docs = [1, 2, 3].map((clientID) => {
			const doc = new Y.Doc()
			doc.clientID = clientID
			return doc
		})
		const ops: Operation[] = []
		let wall = 1
		const emit = (doc: Y.Doc, node: string, type: Operation['type'], prev: unknown): unknown => {
			const value = { $koraBytes: bytesToBase64(Y.encodeStateAsUpdate(doc)) }
			ops.push({
				id: `${node}:${ops.length}`,
				nodeId: node,
				type,
				collection: 'docs',
				recordId: 'd1',
				data: { notes: value },
				previousData: type === 'update' ? { notes: prev } : null,
				timestamp: { wallTime: wall++, logical: 0, nodeId: node },
				sequenceNumber: ops.length + 1,
				causalDeps: [],
				schemaVersion: 1,
			})
			return value
		}
		const first = docs[0] as Y.Doc
		first.getText('content').insert(0, 'hello')
		const base = emit(first, 'n1', 'insert', null)
		for (const doc of docs.slice(1)) Y.applyUpdate(doc, Y.encodeStateAsUpdate(first))
		// Concurrent offline edits, with occasional partial syncs between docs.
		for (let step = 0; step < 8; step++) {
			const index = Math.floor(rng() * docs.length)
			const doc = docs[index] as Y.Doc
			const text = doc.getText('content')
			if (rng() < 0.3 && text.length > 0) text.delete(Math.floor(rng() * text.length), 1)
			else text.insert(Math.floor(rng() * (text.length + 1)), String.fromCharCode(97 + step))
			emit(doc, `n${index + 1}`, 'update', base)
			if (rng() < 0.3) {
				const peer = docs[Math.floor(rng() * docs.length)] as Y.Doc
				Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
			}
		}
		// The CRDT ground truth: every doc's updates applied together.
		const truth = new Y.Doc()
		for (const doc of docs) Y.applyUpdate(truth, Y.encodeStateAsUpdate(doc))

		const results = new Set<string>()
		const texts = new Set<string>()
		for (let order = 0; order < 4; order++) {
			const shuffled = [...ops].sort(() => rng() - 0.5)
			let state = createFoldState('docs', 'd1')
			for (const op of [...shuffled, ...shuffled.slice(0, 3)]) {
				state = mergeOp(state, op, schema, { richtext: yjsMerger }).state
			}
			const record = materialize(state, { richtext: yjsMerger })
			results.add(JSON.stringify(record))
			texts.add(textOf(record?.notes))
		}
		expect(results.size).toBe(1)
		expect([...texts]).toEqual([truth.getText('content').toString()])
	}
})
