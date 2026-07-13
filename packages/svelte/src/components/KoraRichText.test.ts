import type { CollectionAccessor, Store } from '@korajs/store'
import { cleanup, render, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import RichTextFlow from '../../tests/fixtures/RichTextFlow.svelte'

function encodeText(value: string): Uint8Array {
	const doc = new Y.Doc()
	doc.getText('content').insert(0, value)
	return Y.encodeStateAsUpdate(doc)
}

function createQueryBuilderMock(initialResults: Array<Record<string, unknown>> = []) {
	const builder = {
		where: vi.fn(),
		orderBy: vi.fn(),
		limit: vi.fn(),
		offset: vi.fn(),
		exec: vi.fn(async () => initialResults),
		count: vi.fn(async () => initialResults.length),
		subscribe: vi.fn((callback: (results: Array<Record<string, unknown>>) => void) => {
			callback(initialResults)
			return () => {}
		}),
		getDescriptor: vi.fn(),
	}

	builder.where.mockReturnValue(builder)
	builder.orderBy.mockReturnValue(builder)
	builder.limit.mockReturnValue(builder)
	builder.offset.mockReturnValue(builder)

	return builder
}

function createMockStore(collections: Record<string, CollectionAccessor>): Store {
	return {
		collection: vi.fn((name: string) => {
			const collection = collections[name]
			if (!collection) {
				throw new Error(`Unknown collection "${name}"`)
			}
			return collection
		}),
		getSchema: vi.fn(),
		getVersionVector: vi.fn(),
		getNodeId: vi.fn(),
	} as unknown as Store
}

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe('KoraRichText', () => {
	it('loads richtext into snippet children', async () => {
		const helloBody = encodeText('Hello')
		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: helloBody })),
			update: vi.fn(),
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([{ id: 'rec-1', body: helloBody }])),
		} as unknown as CollectionAccessor

		const store = createMockStore({ notes })
		const { getByTestId } = render(RichTextFlow, { props: { store } })

		await waitFor(() => {
			expect(getByTestId('value').textContent).toBe('Hello')
		})
	})
})
