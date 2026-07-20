import type { CollectionAccessor, Store } from '@korajs/store'
import { describe, expect, it, vi } from 'vitest'
import { getCollection, useCollection } from './use-collection'

const collection = { insert: vi.fn() } as unknown as CollectionAccessor
const store = {
	collection: vi.fn((name: string) => {
		if (name !== 'todos') {
			throw new Error(`Unknown collection "${name}"`)
		}
		return collection
	}),
} as unknown as Store

vi.mock('../context', () => ({
	getKoraContext: () => ({ store }),
}))

describe('getCollection', () => {
	it('returns the collection accessor for the given name', () => {
		expect(getCollection('todos')).toBe(collection)
		expect(store.collection).toHaveBeenCalledWith('todos')
	})

	it('is aliased as useCollection', () => {
		expect(useCollection).toBe(getCollection)
	})

	it('propagates the store error for an unknown collection', () => {
		expect(() => getCollection('missing')).toThrow('Unknown collection "missing"')
	})
})
