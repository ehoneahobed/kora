import { describe, expect, test } from 'vitest'
import { createBlobRef, hashBlob, isBlobRef } from './blob-ref'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('hashBlob', () => {
	test('is deterministic: identical bytes hash identically', async () => {
		const a = await hashBlob(bytes('hello world'))
		const b = await hashBlob(bytes('hello world'))
		expect(a).toBe(b)
	})

	test('different bytes hash differently', async () => {
		const a = await hashBlob(bytes('hello'))
		const b = await hashBlob(bytes('world'))
		expect(a).not.toBe(b)
	})

	test('produces a 64-char hex SHA-256 digest', async () => {
		const h = await hashBlob(bytes('x'))
		expect(h).toMatch(/^[0-9a-f]{64}$/)
	})

	test('matches the known SHA-256 of an empty input', async () => {
		const h = await hashBlob(new Uint8Array(0))
		expect(h).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
	})

	test('hashes only the subrange of a view over a larger buffer', async () => {
		const full = new Uint8Array([1, 2, 3, 4, 5, 6])
		const view = full.subarray(2, 5) // [3,4,5]
		const standalone = new Uint8Array([3, 4, 5])
		expect(await hashBlob(view)).toBe(await hashBlob(standalone))
	})
})

describe('createBlobRef', () => {
	test('builds a ref with hash, size, and metadata', async () => {
		const content = bytes('a picture')
		const ref = await createBlobRef(content, { mimeType: 'image/png', filename: 'a.png' })
		expect(ref.hash).toBe(await hashBlob(content))
		expect(ref.size).toBe(content.byteLength)
		expect(ref.mimeType).toBe('image/png')
		expect(ref.filename).toBe('a.png')
	})

	test('omits metadata keys when not provided', async () => {
		const ref = await createBlobRef(bytes('x'))
		expect('mimeType' in ref).toBe(false)
		expect('filename' in ref).toBe(false)
	})
})

describe('isBlobRef', () => {
	test('accepts a valid ref', async () => {
		expect(isBlobRef(await createBlobRef(bytes('x')))).toBe(true)
	})

	test('rejects non-hex or wrong-length hashes', () => {
		expect(isBlobRef({ hash: 'nothex', size: 1 })).toBe(false)
		expect(isBlobRef({ hash: 'abc', size: 1 })).toBe(false)
	})

	test('rejects negative or non-integer sizes', () => {
		const h = 'a'.repeat(64)
		expect(isBlobRef({ hash: h, size: -1 })).toBe(false)
		expect(isBlobRef({ hash: h, size: 1.5 })).toBe(false)
	})

	test('rejects non-objects and wrong metadata types', () => {
		const h = 'a'.repeat(64)
		expect(isBlobRef(null)).toBe(false)
		expect(isBlobRef('x')).toBe(false)
		expect(isBlobRef({ hash: h, size: 1, mimeType: 42 })).toBe(false)
	})
})
