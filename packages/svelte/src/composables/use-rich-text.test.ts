import type { CollectionAccessor, Store } from '@korajs/store'
import { cleanup, render, waitFor } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import EarlyRichTextBindingFlow from '../../tests/fixtures/EarlyRichTextBindingFlow.svelte'
import EarlyRichTextCursorsFlow from '../../tests/fixtures/EarlyRichTextCursorsFlow.svelte'
import RichTextBindingFlow from '../../tests/fixtures/RichTextBindingFlow.svelte'
import RichTextControlsFlow from '../../tests/fixtures/RichTextControlsFlow.svelte'
import type { KoraAppLike } from '../types'

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

describe('createRichTextBinding before the store opens', () => {
	it('loads the record once app.ready resolves (the early accessor refuses findById)', async () => {
		const helloBody = encodeText('Hello')
		const early = {
			findById: vi.fn(async () => {
				throw new Error('findById is not available before app.ready')
			}),
			update: vi.fn(),
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([])),
		} as unknown as CollectionAccessor
		const opened = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: helloBody })),
			update: vi.fn(),
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([{ id: 'rec-1', body: helloBody }])),
		} as unknown as CollectionAccessor
		let open = (): void => {}
		const ready = new Promise<void>((resolve) => {
			open = resolve
		})
		const app = {
			ready,
			getStore: () => createMockStore({ notes: opened }),
			getSyncEngine: () => null,
			collections: { notes: early },
		} as unknown as KoraAppLike

		const { getByTestId } = render(EarlyRichTextBindingFlow, { props: { app } })
		expect(getByTestId('value').textContent).toBe('loading')

		open()
		await waitFor(() => {
			expect(getByTestId('value').textContent).toBe('Hello')
		})
		expect(early.findById).not.toHaveBeenCalled()
	})
})

describe('createRichTextBinding created before the store opens, then the sync engine arrives', () => {
	it("shows a collaborator's cursor on the record once app.ready resolves", async () => {
		// The awareness of the sync engine that exists only after app.ready.
		type State = { user: { name: string; color: string }; cursor?: Record<string, unknown> }
		const states = new Map<number, State>()
		const listeners = new Set<() => void>()
		const awareness = {
			clientId: 1,
			getStates: () => states,
			getLocalState: () => null,
			setLocalState: vi.fn(),
			on: (_event: string, listener: () => void) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
		}
		const engine = { getAwarenessManager: () => awareness }
		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: null })),
			update: vi.fn(),
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([{ id: 'rec-1', body: null }])),
		} as unknown as CollectionAccessor
		let open = (): void => {}
		let isOpen = false
		const ready = new Promise<void>((resolve) => {
			open = () => {
				isOpen = true
				resolve()
			}
		})
		const app = {
			ready,
			getStore: () => createMockStore({ notes }),
			getSyncEngine: () => (isOpen ? engine : null),
			collections: { notes },
		} as unknown as KoraAppLike

		const { getByTestId } = render(EarlyRichTextCursorsFlow, { props: { app } })
		open()
		await ready
		// A collaborator puts a cursor on this record.
		states.set(2, {
			user: { name: 'Grace', color: '#00f' },
			cursor: { collection: 'notes', recordId: 'rec-1', field: 'body', anchor: 0, head: 0 },
		})
		for (const listener of listeners) listener()
		await waitFor(() => {
			expect(getByTestId('cursors').textContent).toBe('Grace')
		})
	})
})
