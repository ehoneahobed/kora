import { describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { createRichTextController } from './create-richtext-controller'

function encodeText(value: string): Uint8Array {
	const doc = new Y.Doc()
	doc.getText('content').insert(0, value)
	return Y.encodeStateAsUpdate(doc)
}

describe('createRichTextController', () => {
	test('loads a record richtext field into Y.Text', async () => {
		const hello = encodeText('Hello')
		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: hello })),
			update: vi.fn(async () => ({ id: 'rec-1' })),
			where: vi.fn(() => ({
				subscribe: (callback: (results: Array<Record<string, unknown>>) => void) => {
					callback([{ id: 'rec-1', body: hello }])
					return () => {}
				},
			})),
		}

		const controller = createRichTextController({
			collection: notes as never,
			collectionName: 'notes',
			recordId: 'rec-1',
			fieldName: 'body',
			store: { collection: () => notes as never },
		})

		await vi.waitFor(() => {
			expect(controller.getSnapshot().ready).toBe(true)
		})

		expect(controller.text.toString()).toBe('Hello')
		controller.destroy()
	})
})
