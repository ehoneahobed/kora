import type { CollectionAccessor, Store } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import { AwarenessManager } from '@korajs/sync'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement, useEffect } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { KoraProvider } from '../context/kora-context'
import { useRichText } from './use-rich-text'

afterEach(() => {
	cleanup()
})

function encodeText(value: string): Uint8Array {
	const doc = new Y.Doc()
	doc.getText('content').insert(0, value)
	return Y.encodeStateAsUpdate(doc)
}

function decodeText(value: Uint8Array): string {
	const doc = new Y.Doc()
	Y.applyUpdate(doc, value)
	return doc.getText('content').toString()
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

describe('useRichText', () => {
	test('loads a record richtext field into Y.Text', async () => {
		const helloBody = encodeText('Hello')
		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: helloBody })),
			update: vi.fn(),
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([{ id: 'rec-1', body: helloBody }])),
		} as unknown as CollectionAccessor

		const store = createMockStore({ notes })

		function Probe(): ReturnType<typeof createElement> {
			const { ready, text } = useRichText('notes', 'rec-1', 'body')
			return createElement('span', { 'data-testid': 'value' }, ready ? text.toString() : 'loading')
		}

		render(createElement(KoraProvider, { store }, createElement(Probe)))

		await waitFor(() => {
			expect(screen.getByTestId('value').textContent).toBe('Hello')
		})
	})

	test('persists local Yjs edits back to the collection field', async () => {
		const updateSpy = vi.fn(async () => ({ id: 'rec-1' }))
		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: null })),
			update: updateSpy,
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([{ id: 'rec-1', body: null }])),
		} as unknown as CollectionAccessor

		const store = createMockStore({ notes })

		function Probe(): ReturnType<typeof createElement> {
			const { ready, text } = useRichText('notes', 'rec-1', 'body')

			useEffect(() => {
				if (!ready) return
				if (text.toString().length > 0) return
				text.insert(0, 'Draft')
			}, [ready, text])

			return createElement('span', { 'data-testid': 'value' }, ready ? text.toString() : 'loading')
		}

		render(createElement(KoraProvider, { store }, createElement(Probe)))

		await waitFor(() => {
			expect(updateSpy).toHaveBeenCalledTimes(1)
		})

		const call = updateSpy.mock.calls[0] as unknown as [string, { body: Uint8Array }] | undefined
		if (!call) {
			throw new Error('Expected updateSpy to receive a call')
		}
		expect(call[0]).toBe('rec-1')
		expect(call[1]).toMatchObject({ body: expect.any(Uint8Array) })
	})

	test('exposes undo/redo controls for local edits', async () => {
		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: null })),
			update: vi.fn(async () => ({ id: 'rec-1' })),
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([{ id: 'rec-1', body: null }])),
		} as unknown as CollectionAccessor

		const store = createMockStore({ notes })

		function Probe(): ReturnType<typeof createElement> {
			const { ready, text, undo, redo, canUndo, canRedo } = useRichText('notes', 'rec-1', 'body')

			useEffect(() => {
				if (!ready) return
				if (text.toString().length > 0) return

				text.insert(0, 'Draft')
				undo()
				redo()
			}, [ready, redo, text, undo])

			return createElement(
				'span',
				{ 'data-testid': 'history' },
				`${canUndo ? 'u1' : 'u0'}-${canRedo ? 'r1' : 'r0'}-${text.toString()}`,
			)
		}

		render(createElement(KoraProvider, { store }, createElement(Probe)))

		await waitFor(() => {
			expect(screen.getByTestId('history').textContent).toContain('Draft')
		})

		expect(screen.getByTestId('history').textContent).toContain('u1')
	})

	test('persists composed richtext state after many incremental edits', async () => {
		const updateSpy = vi.fn(async () => ({ id: 'rec-1' }))
		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: null })),
			update: updateSpy,
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([{ id: 'rec-1', body: null }])),
		} as unknown as CollectionAccessor

		const store = createMockStore({ notes })

		function Probe(): ReturnType<typeof createElement> {
			const { ready, text } = useRichText('notes', 'rec-1', 'body')

			useEffect(() => {
				if (!ready) return
				if (text.length > 0) return

				for (let index = 0; index < 25; index++) {
					text.insert(text.length, 'x')
				}
			}, [ready, text])

			return createElement('span', { 'data-testid': 'bulk' }, text.toString())
		}

		render(createElement(KoraProvider, { store }, createElement(Probe)))

		await waitFor(() => {
			expect(screen.getByTestId('bulk').textContent).toBe('x'.repeat(25))
		})

		await waitFor(() => {
			expect(updateSpy).toHaveBeenCalled()
		})

		const lastCall = updateSpy.mock.calls.at(-1) as [string, { body: Uint8Array }] | undefined
		if (!lastCall) {
			throw new Error('Expected updateSpy to receive at least one call')
		}
		const body = lastCall[1]
		expect(body.body).toBeInstanceOf(Uint8Array)
		expect(decodeText(body.body)).toBe('x'.repeat(25))
	})

	test('setCursor publishes awareness state for the active field', async () => {
		const awareness = new AwarenessManager()
		const setLocalState = vi.spyOn(awareness, 'setLocalState')
		const syncEngine = { getAwarenessManager: () => awareness } as unknown as SyncEngine

		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: encodeText('') })),
			update: vi.fn(async () => ({ id: 'rec-1' })),
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([{ id: 'rec-1', body: encodeText('') }])),
		} as unknown as CollectionAccessor

		const store = createMockStore({ notes })

		function Probe(): ReturnType<typeof createElement> {
			const { ready, setCursor } = useRichText('notes', 'rec-1', 'body', {
				user: { name: 'Ada', color: '#ff0000' },
			})

			useEffect(() => {
				if (!ready) return
				setCursor(2, 4)
			}, [ready, setCursor])

			return createElement('span', { 'data-testid': 'ready' }, ready ? 'yes' : 'no')
		}

		render(createElement(KoraProvider, { store, syncEngine }, createElement(Probe)))

		await waitFor(
			() => {
				expect(screen.getByTestId('ready').textContent).toBe('yes')
			},
			{ timeout: 5000 },
		)

		expect(setLocalState).toHaveBeenCalledWith(
			expect.objectContaining({
				user: { name: 'Ada', color: '#ff0000' },
				cursor: {
					collection: 'notes',
					recordId: 'rec-1',
					field: 'body',
					anchor: 2,
					head: 4,
				},
			}),
		)
	})
})
