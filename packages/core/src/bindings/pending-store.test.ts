import { describe, expect, it } from 'vitest'
import { AppNotReadyError } from '../errors/errors'
import { createPendingStore, isPendingStore } from './pending-store'

interface FakeStore {
	collection(name: string): unknown
	getOperationLog(): unknown
}

describe('createPendingStore', () => {
	const accessor = { insert: () => {} }

	it('serves the app early collection accessors', () => {
		const store = createPendingStore<FakeStore>({ todos: accessor })
		expect(store.collection('todos')).toBe(accessor)
	})

	it('refuses a collection that is not in the schema', () => {
		const store = createPendingStore<FakeStore>({ todos: accessor })
		expect(() => store.collection('nope')).toThrow(AppNotReadyError)
	})

	it('throws AppNotReadyError for any other member, only when it is called', () => {
		const store = createPendingStore<FakeStore>({})
		const method = store.getOperationLog
		expect(typeof method).toBe('function')
		expect(() => method()).toThrow(AppNotReadyError)
	})

	it('looks inert to promise and serialization probes', () => {
		const store = createPendingStore<Record<string, unknown>>({})
		expect(store.then).toBeUndefined()
		expect(JSON.stringify(store)).toBe('{}')
	})

	it('is recognised by isPendingStore and nothing else is', () => {
		const store = createPendingStore<FakeStore>({})
		expect(isPendingStore(store)).toBe(true)
		expect(isPendingStore({})).toBe(false)
		expect(isPendingStore(null)).toBe(false)
		expect(isPendingStore(undefined)).toBe(false)
	})
})
