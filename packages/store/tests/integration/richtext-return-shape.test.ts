import { defineSchema, t } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { richtextToPlainText } from '../../src/serialization/richtext-serializer'
import { Store } from '../../src/store/store'

/**
 * Phase 4 seam (W11 types x store runtime): a richtext field accepts a string,
 * Uint8Array or ArrayBuffer on write and is typed Uint8Array on read. Every value the
 * write API returns (insert, update, and their transaction counterparts and effective
 * records) must have the read shape, exactly what findById returns.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		articles: { fields: { title: t.string(), body: t.richtext().optional() } },
	},
})

function bytes(value: unknown): number[] {
	if (value instanceof Uint8Array) return Array.from(value)
	throw new Error(`expected Uint8Array, got ${Object.prototype.toString.call(value)}`)
}

describe('richtext values come back from writes in their read shape (bytes)', () => {
	let store: Store

	beforeEach(async () => {
		store = new Store({ schema, adapter: new BetterSqlite3Adapter(':memory:'), nodeId: 'rt' })
		await store.open()
	})
	afterEach(async () => {
		await store.close()
	})

	test('insert() with a string returns the bytes findById returns', async () => {
		const articles = store.collection('articles')
		const inserted = await articles.insert({ title: 'a', body: 'hello' })
		expect(inserted.body).toBeInstanceOf(Uint8Array)
		const found = await articles.findById(inserted.id)
		expect(bytes(inserted.body)).toEqual(bytes(found?.body))
		expect(richtextToPlainText(inserted.body as Uint8Array)).toBe('hello')
	})

	test('insert() with an ArrayBuffer returns a Uint8Array', async () => {
		const articles = store.collection('articles')
		const source = await articles.insert({ title: 'src', body: 'from buffer' })
		const buffer = (source.body as Uint8Array).slice().buffer
		const inserted = await articles.insert({ title: 'b', body: buffer })
		expect(inserted.body).toBeInstanceOf(Uint8Array)
		expect(bytes(inserted.body)).toEqual(bytes((await articles.findById(inserted.id))?.body))
	})

	test('update() with a string returns bytes', async () => {
		const articles = store.collection('articles')
		const inserted = await articles.insert({ title: 'a' })
		const updated = await articles.update(inserted.id, { body: 'edited' })
		expect(updated.body).toBeInstanceOf(Uint8Array)
		expect(bytes(updated.body)).toEqual(bytes((await articles.findById(inserted.id))?.body))
	})

	test('transaction insert/update results and effective records are bytes', async () => {
		let id = ''
		await store.transaction(async (tx) => {
			const inserted = await tx.collection('articles').insert({ title: 'tx', body: 'one' })
			id = inserted.id
			expect(inserted.body).toBeInstanceOf(Uint8Array)
			expect((await tx.collection('articles').findById(id))?.body).toBeInstanceOf(Uint8Array)
			const updated = await tx.collection('articles').update(id, { body: 'two' })
			expect(updated.body).toBeInstanceOf(Uint8Array)
			expect(richtextToPlainText(updated.body as Uint8Array)).toBe('two')
			expect((await tx.collection('articles').findById(id))?.body).toBeInstanceOf(Uint8Array)
		})
		const found = await store.collection('articles').findById(id)
		expect(richtextToPlainText(found?.body as Uint8Array)).toBe('two')
	})
})
