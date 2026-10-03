import type { CollectionRecord, QueryBuilder, QueryStore } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store'
import { derived, get, writable } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryStateStore, createQueryStore } from './query-store'

const context = vi.hoisted(() => ({ cache: null as QueryStoreCache | null }))

vi.mock('../context', () => ({
	getKoraContext: () => ({
		store: {},
		syncEngine: null,
		app: null,
		events: null,
		subscribeSyncStatus: null,
		queryStoreCache: context.cache,
	}),
}))

afterEach(() => {
	vi.restoreAllMocks()
	context.cache = null
})

interface Fake {
	query: QueryBuilder
	emit(rows: CollectionRecord[]): void
	fail(error: Error): void
	unsubscribed: () => number
}

function fakeQuery(key: string, rows: CollectionRecord[]): Fake {
	let cb: ((rows: CollectionRecord[]) => void) | null = null
	let onError: ((error: Error) => void) | null = null
	let unsubscribes = 0
	return {
		query: {
			getDescriptor: () => ({ collection: 'todos', where: { key }, orderBy: [] }),
			subscribe: (callback: (rows: CollectionRecord[]) => void, errorCb?: (e: Error) => void) => {
				cb = callback
				onError = errorCb ?? null
				callback(rows)
				return () => {
					unsubscribes++
				}
			},
		} as unknown as QueryBuilder,
		emit: (next) => cb?.(next),
		fail: (error) => onError?.(error),
		unsubscribed: () => unsubscribes,
	}
}

const rec = (id: string): CollectionRecord => ({ id, createdAt: 1, updatedAt: 1 })

class ErrorChannelCache extends QueryStoreCache {
	override getOrCreate<T>(query: QueryBuilder<T>): QueryStore<T> {
		let rows: readonly T[] = []
		let loaded = false
		let error: Error | null = null
		const listeners = new Set<() => void>()
		const notify = () => {
			for (const l of listeners) l()
		}
		const subscribe = query.subscribe as unknown as (
			cb: (rows: T[]) => void,
			onError: (e: Error) => void,
		) => () => void
		let started = false
		return {
			subscribe: (listener: () => void) => {
				listeners.add(listener)
				if (!started) {
					started = true
					subscribe(
						(next) => {
							loaded = true
							error = null
							rows = Object.freeze([...next])
							notify()
						},
						(failure) => {
							error = failure
							notify()
						},
					)
				}
				return () => listeners.delete(listener)
			},
			getSnapshot: () => rows,
			hasSnapshot: () => loaded,
			getError: () => error,
		} as unknown as QueryStore<T>
	}
	override release(): void {}
}

describe('Svelte createQueryStore reactive inputs (DX-7)', () => {
	it('follows a readable store of the query and releases the previous one', () => {
		context.cache = new QueryStoreCache()
		const open = fakeQuery('open', [rec('o')])
		const done = fakeQuery('done', [rec('d')])
		const filter = writable<'open' | 'done'>('open')
		const rows = createQueryStore(derived(filter, (f) => (f === 'open' ? open.query : done.query)))
		const seen: string[] = []
		const stop = rows.subscribe((value) => seen.push(value.map((r) => r.id).join(',')))
		expect(seen.at(-1)).toBe('o')
		filter.set('done')
		expect(seen.at(-1)).toBe('d')
		expect(open.unsubscribed()).toBe(1)
		stop()
		expect(done.unsubscribed()).toBe(1)
	})

	it('accepts enabled as a readable store', () => {
		context.cache = new QueryStoreCache()
		const fake = fakeQuery('enabled', [rec('a')])
		const enabled = writable(false)
		const rows = createQueryStore(fake.query, { enabled })
		const stop = rows.subscribe(() => {})
		expect(get(rows)).toHaveLength(0)
		enabled.set(true)
		expect(get(rows)).toHaveLength(1)
		enabled.set(false)
		expect(get(rows)).toHaveLength(0)
		stop()
	})
})

describe('Svelte query error state (STORE-12 consumer)', () => {
	it('createQueryStateStore exposes the error and clears it on the next result', () => {
		context.cache = new ErrorChannelCache()
		const fake = fakeQuery('state', [rec('a')])
		const state = createQueryStateStore(fake.query)
		const stop = state.subscribe(() => {})
		expect(get(state)).toMatchObject({ ready: true, error: null })
		fake.fail(new Error('boom'))
		expect(get(state).error?.message).toBe('boom')
		expect(get(state).data).toHaveLength(1)
		fake.emit([rec('a'), rec('b')])
		expect(get(state).error).toBeNull()
		expect(get(state).data).toHaveLength(2)
		stop()
	})

	it('createQueryStore logs a failure without an onError handler', () => {
		context.cache = new ErrorChannelCache()
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		const fake = fakeQuery('logged', [rec('a')])
		const rows = createQueryStore(fake.query)
		const stop = rows.subscribe(() => {})
		fake.fail(new Error('bad field'))
		expect(errors).toHaveBeenCalledTimes(1)
		stop()
	})
})
