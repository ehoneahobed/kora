import { preReadyWritesAllowed } from '@korajs/core/internal'
import type { QueryBuilder } from '@korajs/store'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { KoraProvider } from '../context/kora-context'
import type { KoraAppLike } from '../types'
import { useApp } from './use-app'
import { useCollaborators } from './use-collaborators'
import { useCollection } from './use-collection'
import { useFormDraft } from './use-form-draft'
import { useMutation } from './use-mutation'
import { useOfflineKeep } from './use-offline-keep'
import { useOfflineReady } from './use-offline-ready'
import { usePresence } from './use-presence'
import { useQuery, useQueryState } from './use-query'
import { useRichText } from './use-rich-text'
import { useSyncStatus } from './use-sync-status'

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

describe('every exported hook renders before the store opens', () => {
	// With first-visit read-through the tree renders before `app.ready`, when `getStore()` throws.
	// A hook that asks the app for the store while rendering takes the page down (the spaces
	// hooks did, found by koraforms' e2e). This mounts all of them at once against such an app;
	// add a new hook to the list when one is exported.
	it('mounts all of them without throwing', () => {
		const descriptor = { collection: 'todos', where: {}, orderBy: [] }
		const deferred = {
			getDescriptor: () => descriptor,
			subscribe: () => () => {},
		} as unknown as QueryBuilder<{ id: string }>
		const early = {
			where: () => deferred,
			findById: () => new Promise(() => {}),
		}
		const app = appWith({ todos: early })
		const wrapper = ({ children }: { children: ReactNode }): ReactNode =>
			createElement(KoraProvider, { app }, children)
		const { result } = renderHook(
			() => {
				useApp()
				useCollection('todos')
				useQuery(deferred)
				useQueryState(deferred)
				useMutation(async () => 'queued')
				useOfflineKeep(deferred)
				useOfflineReady()
				useSyncStatus()
				useFormDraft('draft', { title: '' }, { userId: 'u1', fields: ['title'] })
				useRichText('todos', 't1', 'notes')
				usePresence({ name: 'Ann', color: '#000' })
				useCollaborators()
				return true
			},
			{ wrapper },
		)
		expect(result.current).toBe(true)
	})
})
