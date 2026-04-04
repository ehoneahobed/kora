import { describe, expect, test } from 'vitest'
import type { RandomSource } from '../types'
import { extractTimestamp, generateUUIDv7, isValidUUIDv7 } from './uuid-v7'

/** Deterministic random source that fills with sequential bytes */
function createMockRandom(seed = 0): RandomSource {
	let counter = seed
	return {
		getRandomValues<T extends ArrayBufferView>(array: T): T {
			const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
			for (let i = 0; i < view.length; i++) {
				view[i] = counter++ & 0xff
			}
			return array
		},
	}
}

describe('generateUUIDv7', () => {
	test('produces a valid UUID v7 format', () => {
		const uuid = generateUUIDv7()
		expect(isValidUUIDv7(uuid)).toBe(true)
	})

	test('encodes the timestamp correctly', () => {
		const timestamp = 1712188800000 // 2024-04-04T00:00:00.000Z
		const uuid = generateUUIDv7(timestamp, createMockRandom())
		const extracted = extractTimestamp(uuid)
		expect(extracted).toBe(timestamp)
	})

	test('produces unique UUIDs with real random source', () => {
		const uuids = new Set<string>()
		for (let i = 0; i < 100; i++) {
			uuids.add(generateUUIDv7())
		}
		expect(uuids.size).toBe(100)
	})

	test('produces deterministic UUIDs with mock random source', () => {
		const uuid1 = generateUUIDv7(1000, createMockRandom(42))
		const uuid2 = generateUUIDv7(1000, createMockRandom(42))
		expect(uuid1).toBe(uuid2)
	})

	test('produces time-sortable UUIDs', () => {
		const uuids: string[] = []
		for (let i = 0; i < 10; i++) {
			uuids.push(generateUUIDv7(1000 + i, createMockRandom(i)))
		}
		const sorted = [...uuids].sort()
		expect(uuids).toEqual(sorted)
	})

	test('handles timestamp 0', () => {
		const uuid = generateUUIDv7(0, createMockRandom())
		expect(isValidUUIDv7(uuid)).toBe(true)
		expect(extractTimestamp(uuid)).toBe(0)
	})

	test('sets version to 7', () => {
		const uuid = generateUUIDv7(1000, createMockRandom())
		// Version is the 13th character (index 14 in string with dashes)
		expect(uuid[14]).toBe('7')
	})

	test('sets variant correctly', () => {
		const uuid = generateUUIDv7(1000, createMockRandom())
		const hex = uuid.replace(/-/g, '')
		const variantNibble = Number.parseInt(hex[16] ?? '0', 16)
		expect(variantNibble).toBeGreaterThanOrEqual(0x8)
		expect(variantNibble).toBeLessThanOrEqual(0xb)
	})
})

describe('extractTimestamp', () => {
	test('round-trips with generateUUIDv7', () => {
		const timestamps = [0, 1000, 1712188800000, Date.now()]
		for (const ts of timestamps) {
			const uuid = generateUUIDv7(ts, createMockRandom())
			expect(extractTimestamp(uuid)).toBe(ts)
		}
	})
})

describe('isValidUUIDv7', () => {
	test('accepts valid UUID v7', () => {
		expect(isValidUUIDv7(generateUUIDv7())).toBe(true)
	})

	test('rejects empty string', () => {
		expect(isValidUUIDv7('')).toBe(false)
	})

	test('rejects wrong format', () => {
		expect(isValidUUIDv7('not-a-uuid')).toBe(false)
	})

	test('rejects UUID with wrong version', () => {
		// Version 4 UUID
		expect(isValidUUIDv7('550e8400-e29b-41d4-a716-446655440000')).toBe(false)
	})

	test('rejects UUID with wrong variant', () => {
		// Valid format but variant nibble is 0 (not 10xx)
		const uuid = generateUUIDv7(1000, createMockRandom())
		const hex = uuid.replace(/-/g, '')
		// Replace variant nibble with 0
		const tampered = `${hex.slice(0, 16)}0${hex.slice(17)}`
		const formatted = `${tampered.slice(0, 8)}-${tampered.slice(8, 12)}-${tampered.slice(12, 16)}-${tampered.slice(16, 20)}-${tampered.slice(20, 32)}`
		expect(isValidUUIDv7(formatted)).toBe(false)
	})

	test('is case-insensitive', () => {
		const uuid = generateUUIDv7()
		expect(isValidUUIDv7(uuid.toUpperCase())).toBe(true)
	})
})
