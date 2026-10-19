import { bytesToBase64 } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import {
	mergeRichtext,
	mergeRichtextUpdate,
	richtextToString,
	stringToRichtextUpdate,
} from './yjs-richtext'

describe('yjs richtext strategy', () => {
	test('merges concurrent updates from a shared base', () => {
		const baseDoc = new Y.Doc()
		baseDoc.getText('content').insert(0, 'hello')
		const baseUpdate = Y.encodeStateAsUpdate(baseDoc)

		const localDoc = new Y.Doc()
		Y.applyUpdate(localDoc, baseUpdate)
		localDoc.getText('content').insert(0, 'A ')
		const localUpdate = Y.encodeStateAsUpdate(localDoc)

		const remoteDoc = new Y.Doc()
		Y.applyUpdate(remoteDoc, baseUpdate)
		remoteDoc.getText('content').insert(remoteDoc.getText('content').length, ' B')
		const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc)

		const merged = mergeRichtext(localUpdate, remoteUpdate, baseUpdate)

		expect(richtextToString(merged)).toBe('A hello B')
	})

	test('supports plain string fallback values', () => {
		const merged = mergeRichtext('hello world', null, null)
		expect(richtextToString(merged)).toBe('hello world')
	})

	test('encodes plain strings as Yjs updates', () => {
		const encoded = stringToRichtextUpdate('note body')
		expect(encoded).toBeInstanceOf(Uint8Array)
		expect(richtextToString(encoded)).toBe('note body')
	})

	// Regression: binary richtext values arrive from op.data in the canonical
	// tagged { $koraBytes } form. Before the fix, toYjsUpdate threw on that shape,
	// crashing any concurrent richtext merge whose values round-tripped through
	// JSON (persisted ops, remote ops off the wire).
	test('merges tagged { $koraBytes } binary values without throwing', () => {
		const baseDoc = new Y.Doc()
		baseDoc.getText('content').insert(0, 'hello')
		const baseUpdate = Y.encodeStateAsUpdate(baseDoc)

		const localDoc = new Y.Doc()
		Y.applyUpdate(localDoc, baseUpdate)
		localDoc.getText('content').insert(0, 'A ')
		const localTagged = { $koraBytes: bytesToBase64(Y.encodeStateAsUpdate(localDoc)) }

		const remoteDoc = new Y.Doc()
		Y.applyUpdate(remoteDoc, baseUpdate)
		remoteDoc.getText('content').insert(remoteDoc.getText('content').length, ' B')
		const remoteTagged = { $koraBytes: bytesToBase64(Y.encodeStateAsUpdate(remoteDoc)) }

		const baseTagged = { $koraBytes: bytesToBase64(baseUpdate) }

		const merged = mergeRichtext(localTagged, remoteTagged, baseTagged)
		expect(richtextToString(merged)).toBe('A hello B')
	})

	test('merges a tagged local value against a raw Uint8Array remote value', () => {
		const baseDoc = new Y.Doc()
		baseDoc.getText('content').insert(0, 'x')
		const baseUpdate = Y.encodeStateAsUpdate(baseDoc)

		const localDoc = new Y.Doc()
		Y.applyUpdate(localDoc, baseUpdate)
		localDoc.getText('content').insert(1, 'y')
		const localTagged = { $koraBytes: bytesToBase64(Y.encodeStateAsUpdate(localDoc)) }

		const remoteDoc = new Y.Doc()
		Y.applyUpdate(remoteDoc, baseUpdate)
		remoteDoc.getText('content').insert(1, 'z')
		const remoteRaw = Y.encodeStateAsUpdate(remoteDoc)

		const merged = mergeRichtext(localTagged, remoteRaw, baseUpdate)
		const text = richtextToString(merged)
		expect(text).toContain('x')
		expect(text).toContain('y')
		expect(text).toContain('z')
	})

	test('mergeRichtextUpdate is mergeRichtext without a base, and complete when nothing is pending', () => {
		const doc = new Y.Doc()
		doc.clientID = 1
		doc.getText('content').insert(0, 'ab')
		const first = Y.encodeStateAsUpdate(doc)
		doc.getText('content').insert(2, 'cd')
		const second = Y.encodeStateAsUpdate(doc)
		const result = mergeRichtextUpdate(first, second)
		expect(result.merged).toEqual(mergeRichtext(first, second, null))
		expect(result.complete).toBe(true)
		expect(richtextToString(result.merged)).toBe('abcd')
	})

	test('mergeRichtextUpdate reports a delta whose base is missing as incomplete', () => {
		const doc = new Y.Doc()
		doc.clientID = 1
		doc.getText('content').insert(0, 'ab')
		const base = Y.encodeStateVector(doc)
		doc.getText('content').insert(2, 'cd')
		const delta = Y.encodeStateAsUpdate(doc, base)
		const other = new Y.Doc()
		other.clientID = 2
		other.getText('content').insert(0, 'z')
		const result = mergeRichtextUpdate(Y.encodeStateAsUpdate(other), delta)
		expect(result.merged).toEqual(mergeRichtext(Y.encodeStateAsUpdate(other), delta, null))
		expect(result.complete).toBe(false)
	})
})
