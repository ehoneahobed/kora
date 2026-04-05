import { describe, expect, test } from 'vitest'
import { decodeRichtext, encodeRichtext, richtextToPlainText } from './richtext-serializer'

describe('richtext serializer', () => {
	test('encodes plain strings to Yjs binary state', () => {
		const encoded = encodeRichtext('hello richtext')
		expect(encoded).toBeInstanceOf(Uint8Array)
		expect(richtextToPlainText(encoded)).toBe('hello richtext')
	})

	test('passes Uint8Array through on encode/decode', () => {
		const value = new Uint8Array([1, 2, 3])
		expect(encodeRichtext(value)).toBe(value)
		expect(decodeRichtext(value)).toBe(value)
	})

	test('converts Buffer values to Uint8Array', () => {
		const raw = Buffer.from([4, 5, 6])
		const decoded = decodeRichtext(raw)
		expect(decoded).toBeInstanceOf(Uint8Array)
		expect(decoded).toEqual(new Uint8Array([4, 5, 6]))
	})

	test('returns null for null/undefined values', () => {
		expect(encodeRichtext(null)).toBeNull()
		expect(encodeRichtext(undefined)).toBeNull()
		expect(decodeRichtext(null)).toBeNull()
		expect(decodeRichtext(undefined)).toBeNull()
	})
})
