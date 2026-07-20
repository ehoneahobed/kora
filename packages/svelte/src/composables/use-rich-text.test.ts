import type { CollectionAccessor, Store } from '@korajs/store'
import { cleanup, render, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import RichTextBindingFlow from '../../tests/fixtures/RichTextBindingFlow.svelte'
import RichTextControlsFlow from '../../tests/fixtures/RichTextControlsFlow.svelte'

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

describe('createRichTextBinding', () => {
	it('loads a record richtext field into Y.Text', async () => {
		const helloBody = encodeText('Hello')
		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: helloBody })),
			update: vi.fn(),
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([{ id: 'rec-1', body: helloBody }])),
		} as unknown as CollectionAccessor

		const store = createMockStore({ notes })
		const { getByTestId } = render(RichTextBindingFlow, { props: { store } })

		await waitFor(() => {
			expect(getByTestId('value').textContent).toBe('Hello')
		})
	})

	it('exposes reactive undo/redo controls for local edits', async () => {
		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: null })),
			update: vi.fn(async () => ({ id: 'rec-1' })),
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([{ id: 'rec-1', body: null }])),
		} as unknown as CollectionAccessor

		const store = createMockStore({ notes })
		const { getByTestId } = render(RichTextControlsFlow, { props: { store } })

		await waitFor(() => {
			expect(getByTestId('ready').textContent).toBe('yes')
		})

		await userEvent.click(getByTestId('edit'))
		await waitFor(() => {
			expect(getByTestId('value').textContent).toBe('Draft')
		})
		expect(getByTestId('canUndo').textContent).toBe('u1')

		await userEvent.click(getByTestId('undo'))
		await waitFor(() => {
			expect(getByTestId('value').textContent).toBe('')
		})

		await userEvent.click(getByTestId('redo'))
		await waitFor(() => {
			expect(getByTestId('value').textContent).toBe('Draft')
		})
	})

	it('destroys the controller on unmount without throwing', async () => {
		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: null })),
			update: vi.fn(async () => ({ id: 'rec-1' })),
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([{ id: 'rec-1', body: null }])),
		} as unknown as CollectionAccessor

		const store = createMockStore({ notes })
		const { getByTestId, unmount } = render(RichTextControlsFlow, { props: { store } })

		await waitFor(() => {
			expect(getByTestId('ready').textContent).toBe('yes')
		})

		expect(() => unmount()).not.toThrow()
	})
})
