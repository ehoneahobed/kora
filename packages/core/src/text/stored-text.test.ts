import { fc, test as propTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import {
	STORED_TEXT_ESCAPE,
	decodeStoredJsonValue,
	decodeStoredText,
	encodeStoredJsonValue,
	encodeStoredText,
	needsStoredTextEncoding,
} from './stored-text'

/** Every code unit is either well-formed UTF-8 text or the escape introducer's payload. */
function isWellFormed(s: string): boolean {
	return Buffer.from(s, 'utf8').toString('utf8') === s && !s.includes('\u0000')
}

describe('stored text codec (RT-65)', () => {
	test('ordinary strings are stored unchanged', () => {
		for (const s of ['', 'hello', 'accents éàü', '�']) {
			expect(needsStoredTextEncoding(s)).toBe(false)
			expect(encodeStoredText(s)).toBe(s)
		}
		// Paired surrogates need a scan (the quick check is conservative) but are kept.
		expect(needsStoredTextEncoding('emoji 😀')).toBe(true)
		expect(encodeStoredText('emoji 😀')).toBe('emoji 😀')
	})

	test('NUL, U+FFFF and lone surrogates are escaped into well-formed text', () => {
		expect(encodeStoredText('a\u0000b')).toBe(`a${STORED_TEXT_ESCAPE}0b`)
		expect(encodeStoredText('￿')).toBe(`${STORED_TEXT_ESCAPE}F`)
		expect(encodeStoredText('x\ud83d')).toBe(`x${STORED_TEXT_ESCAPE}sd83d`)
		expect(encodeStoredText('\ude00y')).toBe(`${STORED_TEXT_ESCAPE}sde00y`)
		expect(encodeStoredText('😀')).toBe('😀')
		for (const s of ['a\u0000b', 'x\ud83d', '\ude00\ud83d', '￿0']) {
			expect(isWellFormed(encodeStoredText(s))).toBe(true)
			expect(decodeStoredText(encodeStoredText(s))).toBe(s)
		}
	})

	test('an untagged escape introducer in a legacy value is kept', () => {
		expect(decodeStoredText(`a${STORED_TEXT_ESCAPE}`)).toBe(`a${STORED_TEXT_ESCAPE}`)
		expect(decodeStoredText(`${STORED_TEXT_ESCAPE}s00zz`)).toBe(`${STORED_TEXT_ESCAPE}s00zz`)
	})

	propTest.prop([fc.string({ unit: 'binary' })])('round-trips every JS string', (s) => {
		const encoded = encodeStoredText(s)
		expect(isWellFormed(encoded)).toBe(true)
		expect(decodeStoredText(encoded)).toBe(s)
	})

	propTest.prop([fc.string({ unit: 'binary' }), fc.string({ unit: 'binary' })])(
		'is injective (equality filters on encoded values are exact)',
		(a, b) => {
			expect(encodeStoredText(a) === encodeStoredText(b)).toBe(a === b)
		},
	)

	test('JSON values: every string and key round-trips', () => {
		const value = { 'k\u0000': ['a\ud800', { n: 1, s: '￿' }], ok: true, nil: null }
		expect(decodeStoredJsonValue(encodeStoredJsonValue(value))).toEqual(value)
	})
})
