import { preReadyWritesAllowed } from '@korajs/core/internal'
import type { QueryBuilder } from '@korajs/store'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { KoraProvider } from '../context/kora-context'
import type { KoraAppLike } from '../types'
import { useMutation } from './use-mutation'
import { useQueryState } from './use-query'

afterEach(() => {
	cleanup()
})

function appWith(collections: Record<string, unknown>): KoraAppLike {
	return {
		ready: new Promise<void>(() => {}),
		getStore: () => {
			throw new Error('not open')
		},
		getSyncEngine: () => null,
		collections,
	}
}

describe('hooks before the store opens (S4a)', () => {
	it('useMutation lets the write queue: the write scope is open inside mutate, closed outside', async () => {
		const seen: boolean[] = []
		const app = appWith({})
		const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
			createElement(KoraProvider, { app }, children)
		const { result } = renderHook(
			() =>
				useMutation(async () => {
					seen.push(preReadyWritesAllowed())
					return 'queued'
				}),
			{ wrapper },
		)
		expect(preReadyWritesAllowed()).toBe(false)
		await act(async () => {
			await result.current.mutateAsync()
		})
		expect(seen).toEqual([true])
		expect(preReadyWritesAllowed()).toBe(false)
	})

	it('useQueryState on a query built before the store opened reports not ready, with no rows', () => {
		const descriptor = { collection: 'todos', where: {}, orderBy: [] }
		const subscribed: unknown[] = []
		// What the early accessor returns: a query that records itself and waits.
		const deferred = {
			getDescriptor: () => descriptor,
			subscribe: (...args: unknown[]) => {
				subscribed.push(args)
				return () => {}
			},
		} as unknown as QueryBuilder<{ id: string }>
		const app = appWith({})
		const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
			createElement(KoraProvider, { app }, children)
		const { result } = renderHook(() => useQueryState(deferred), { wrapper })
		expect(result.current.data).toEqual([])
		expect(result.current.ready).toBe(false)
		expect(result.current.error).toBeNull()
		expect(subscribed.length).toBeGreaterThan(0)
	})
})
