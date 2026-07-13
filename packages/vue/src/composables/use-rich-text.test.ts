import type { CollectionAccessor, Store } from '@korajs/store'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { KoraProvider } from '../components/kora-provider'
import { useRichText } from './use-rich-text'

afterEach(() => {
	vi.restoreAllMocks()
})

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

describe('useRichText', () => {
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

		const Probe = defineComponent({
			setup() {
				const binding = useRichText('notes', 'rec-1', 'body')
				return () =>
					h(
						'span',
						{ 'data-testid': 'value' },
						binding.ready ? binding.text.toString() : 'loading',
					)
			},
		})

		const wrapper = mount(
			defineComponent({
				setup: () => () => h(KoraProvider, { store }, () => h(Probe)),
			}),
		)

		await vi.waitFor(() => {
			expect(wrapper.get('[data-testid="value"]').text()).toBe('Hello')
		})
	})

	it('persists local Yjs edits back to the collection field', async () => {
		const updateSpy = vi.fn(async () => ({ id: 'rec-1' }))
		const notes = {
			findById: vi.fn(async () => ({ id: 'rec-1', body: null })),
			update: updateSpy,
			insert: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => createQueryBuilderMock([{ id: 'rec-1', body: null }])),
		} as unknown as CollectionAccessor

		const store = createMockStore({ notes })

		const Probe = defineComponent({
			setup() {
				const binding = useRichText('notes', 'rec-1', 'body')
				return () =>
					h(
						'button',
						{
							type: 'button',
							'data-testid': 'edit',
							onClick: () => binding.text.insert(0, 'Hi'),
						},
						'edit',
					)
			},
		})

		const wrapper = mount(
			defineComponent({
				setup: () => () => h(KoraProvider, { store }, () => h(Probe)),
			}),
		)

		await wrapper.get('[data-testid="edit"]').trigger('click')
		await vi.waitFor(() => {
			expect(updateSpy).toHaveBeenCalled()
		})
	})
})
