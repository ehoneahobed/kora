import * as Y from 'yjs'
import { describe, expect, test } from 'vitest'
import { mergeRichtext, richtextToString, stringToRichtextUpdate } from './yjs-richtext'

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
})
