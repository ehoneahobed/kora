/**
 * Type-level contract matching the runtime (store tests/integration/richtext-return-shape):
 * richtext accepts string | Uint8Array | ArrayBuffer on write and every returned record
 * (insert, update, findById) types it as bytes.
 */
import { createApp, defineSchema, t } from '../../src/index'

const app = createApp({
	schema: defineSchema({
		version: 1,
		collections: { articles: { fields: { title: t.string(), body: t.richtext() } } },
	}),
})

export async function richtextReturnShape(): Promise<void> {
	const inserted = await app.articles.insert({ title: 'a', body: 'hello' })
	const insertedBody: Uint8Array = inserted.body
	const updated = await app.articles.update(inserted.id, { body: 'edited' })
	const updatedBody: Uint8Array = updated.body
	const found = await app.articles.findById(inserted.id)
	const foundBody: Uint8Array | undefined = found?.body
	// @ts-expect-error a returned richtext value is bytes, never the string written
	const notAString: string = inserted.body
	void [insertedBody, updatedBody, foundBody, notAString]
}
