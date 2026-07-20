import type { FieldDescriptor } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	base64ToBytes,
	bytesToBase64,
	decodeRichtextOpDataValue,
	encodeRichtextFieldsForOpData,
	encodeRichtextForOpData,
	isKoraBytesValue,
} from './op-data-encoding'

/** Deterministic PRNG so the round-trip sweep never flakes (no Math.random). */
function mulberry32(seed: number): () => number {
	let a = seed
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

describe('op-data-encoding', () => {
	test('base64 round-trips arbitrary byte sequences of every length mod 3', () => {
		const random = mulberry32(42)
		for (let length = 0; length <= 100; length++) {
			const bytes = new Uint8Array(length)
			for (let i = 0; i < length; i++) {
				bytes[i] = Math.floor(random() * 256)
			}
			const decoded = base64ToBytes(bytesToBase64(bytes))
			expect(Array.from(decoded)).toEqual(Array.from(bytes))
		}
	})

	test('base64 output matches the platform encoder', () => {
		const random = mulberry32(7)
		for (const length of [0, 1, 2, 3, 31, 32, 33, 257]) {
			const bytes = new Uint8Array(length)
			for (let i = 0; i < length; i++) {
				bytes[i] = Math.floor(random() * 256)
			}
			expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
		}
	})

	test('strings pass through encodeRichtextForOpData unchanged', () => {
		expect(encodeRichtextForOpData('hello')).toBe('hello')
		expect(encodeRichtextForOpData('')).toBe('')
	})

	test('Uint8Array and ArrayBuffer produce the identical tagged form', () => {
		const bytes = new Uint8Array([1, 2, 3, 250])
		const fromBytes = encodeRichtextForOpData(bytes)
		const fromBuffer = encodeRichtextForOpData(bytes.slice().buffer)
		expect(fromBytes).toEqual(fromBuffer)
		expect(isKoraBytesValue(fromBytes)).toBe(true)
	})

	test('decodeRichtextOpDataValue reverses the tagged form', () => {
		const bytes = new Uint8Array([0, 255, 128, 7])
		const decoded = decodeRichtextOpDataValue(encodeRichtextForOpData(bytes))
		expect(decoded).toBeInstanceOf(Uint8Array)
		expect(Array.from(decoded as Uint8Array)).toEqual([0, 255, 128, 7])
	})

	test('decodeRichtextOpDataValue tolerates pre-fix numeric-key objects', () => {
		// Shape produced by JSON.stringify(new Uint8Array([9, 8, 7])) before the
		// tagged encoding existed; old dev databases may still contain it.
		const legacy = { '0': 9, '1': 8, '2': 7 }
		const decoded = decodeRichtextOpDataValue(legacy)
		expect(decoded).toBeInstanceOf(Uint8Array)
		expect(Array.from(decoded as Uint8Array)).toEqual([9, 8, 7])
	})

	test('decodeRichtextOpDataValue rejects unrecognized shapes', () => {
		expect(() => decodeRichtextOpDataValue(42)).toThrow()
		expect(() => decodeRichtextOpDataValue({ $koraBytes: 'AAo=', extra: 1 })).toThrow()
		expect(() => decodeRichtextOpDataValue({ foo: 'bar' })).toThrow()
	})

	test('isKoraBytesValue requires exactly the single $koraBytes string key', () => {
		expect(isKoraBytesValue({ $koraBytes: 'QQ==' })).toBe(true)
		expect(isKoraBytesValue({ $koraBytes: 42 })).toBe(false)
		expect(isKoraBytesValue({ $koraBytes: 'QQ==', other: true })).toBe(false)
		expect(isKoraBytesValue('QQ==')).toBe(false)
		expect(isKoraBytesValue(null)).toBe(false)
	})

	test('encodeRichtextFieldsForOpData only rewrites richtext-typed binary fields', () => {
		const field = (kind: FieldDescriptor['kind']): FieldDescriptor => ({
			kind,
			required: true,
			defaultValue: undefined,
			auto: false,
			enumValues: null,
			itemKind: null,
			mergeStrategy: null,
			transitions: null,
		})
		const fields = {
			title: field('string'),
			body: field('richtext'),
		}
		const bytes = new Uint8Array([1, 2])
		const encoded = encodeRichtextFieldsForOpData({ title: 'a', body: bytes, extra: 5 }, fields)
		expect(encoded.title).toBe('a')
		expect(encoded.extra).toBe(5)
		expect(isKoraBytesValue(encoded.body)).toBe(true)
		// String richtext values stay plain strings — backward compatible.
		const stringEncoded = encodeRichtextFieldsForOpData({ body: 'plain' }, fields)
		expect(stringEncoded.body).toBe('plain')
		// Null richtext values are untouched.
		const nullEncoded = encodeRichtextFieldsForOpData({ body: null }, fields)
		expect(nullEncoded.body).toBeNull()
	})
})
