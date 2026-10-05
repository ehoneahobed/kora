import type { SyncStatusInfo } from '@korajs/sync'
import { OFFLINE_SYNC_STATUS } from '@korajs/sync'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { Profiler, StrictMode, createElement, startTransition, useEffect } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	createFakeApp,
	createFakeQuery,
	createFakeStore,
	row,
} from '../../tests/fixtures/fake-query'
import { KoraProvider } from '../context/kora-context'
import type { KoraAppLike } from '../types'
import { useMutation } from './use-mutation'
import { useQuery } from './use-query'
import { useSyncStatus } from './use-sync-status'

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

function provider(app: KoraAppLike, strict = false) {
	return ({ children }: { children: ReactNode }) => {
		const tree = createElement(KoraProvider, { app }, children)
		return strict ? createElement(StrictMode, null, tree) : tree
	}
}

describe('useQuery render stability (DX-5)', () => {
	it('does not re-render when the store notifies an unchanged result', async () => {
		const fake = createFakeQuery('stable', [row('a')])
		const app = createFakeApp({})
		let renders = 0
		function List() {
			renders++
			const rows = useQuery(fake.query)
			return createElement('span', { 'data-testid': 'rows' }, rows.map((r) => r.id).join(','))
		}
		render(createElement(provider(app), null, createElement(List)))
		await waitFor(() => expect(screen.getByTestId('rows').textContent).toBe('a'))
		const settled = renders

		// Re-renders of the parent tree do not resubscribe, and a store emission that
		// keeps the same array is not a change.
		const store = app.getQueryStoreCache?.()
		expect(store?.size).toBe(1)
		expect(fake.subscribeCount()).toBe(1)
		await act(async () => {})
		expect(renders).toBe(settled)

		act(() => fake.emit([row('a'), row('b')]))
		expect(screen.getByTestId('rows').textContent).toBe('a,b')
		expect(renders).toBe(settled + 1)
		expect(fake.subscribeCount()).toBe(1)
	})

	it('keeps the array identity across parent re-renders', async () => {
		const fake = createFakeQuery('identity', [row('a')])
		const app = createFakeApp({})
		const seen: unknown[] = []
		const { rerender } = renderHook(
			() => {
				const rows = useQuery(fake.query)
				seen.push(rows)
				return rows
			},
			{ wrapper: provider(app) },
		)
		await waitFor(() => expect((seen.at(-1) as unknown[]).length).toBe(1))
		const settled = seen.at(-1)
		rerender()
		rerender()
		expect(seen.at(-1)).toBe(settled)
		expect(fake.subscribeCount()).toBe(1)
	})

	it('never tears: every reader in one concurrent render commits the same snapshot', async () => {
		const fake = createFakeQuery('tearing', [row('v0')])
		const app = createFakeApp({})
		let mutated = false
		const committed: string[] = []

		function Reader({ index }: { index: number }) {
			const rows = useQuery(fake.query)
			const value = rows.map((r) => r.id).join(',')
			// The first reader changes the external store in the middle of the render pass;
			// readers after it must not commit a different value than readers before it.
			if (index === 0 && !mutated && value === 'v0') {
				mutated = true
				fake.emit([row('v1')])
			}
			useEffect(() => {
				committed[index] = value
			})
			return createElement('i', null, value)
		}

		function Readers() {
			return createElement(
				'div',
				null,
				[0, 1, 2, 3, 4].map((index) => createElement(Reader, { key: index, index })),
			)
		}

		const { rerender } = render(createElement(provider(app), null, null))
		await act(async () => {})
		await act(async () => {
			startTransition(() => {
				rerender(createElement(provider(app), null, createElement(Readers)))
			})
		})
		await waitFor(() => expect(committed).toHaveLength(5))
		expect(mutated).toBe(true)
		expect(new Set(committed).size).toBe(1)
		expect(committed[0]).toBe('v1')
	})
})

describe('useMutation render stability (DX-5)', () => {
	it('returns the same result object until isLoading or error changes', async () => {
		let resolve: (value: string) => void = () => {}
		const fn = vi.fn(
			() =>
				new Promise<string>((r) => {
					resolve = r
				}),
		)
		const { result, rerender } = renderHook(() => useMutation(fn))
		const idle = result.current
		rerender()
		expect(result.current).toBe(idle)

		let pending: Promise<string> = Promise.resolve('')
		act(() => {
			pending = result.current.mutateAsync()
		})
		expect(result.current.isLoading).toBe(true)
		expect(result.current.mutate).toBe(idle.mutate)
		await act(async () => {
			resolve('ok')
			await pending
		})
		expect(result.current.isLoading).toBe(false)
		expect(result.current.mutateAsync).toBe(idle.mutateAsync)
		expect(result.current.reset).toBe(idle.reset)
	})

	it('keeps callbacks stable and working under StrictMode double mount', async () => {
		const fn = vi.fn().mockResolvedValue('done')
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(StrictMode, null, children)
		const { result, rerender } = renderHook(() => useMutation(fn), { wrapper })
		await act(async () => {})
		const first = result.current.mutateAsync
		rerender()
		expect(result.current.mutateAsync).toBe(first)
		await act(async () => {
			await result.current.mutateAsync()
		})
		expect(fn).toHaveBeenCalledTimes(1)
		expect(result.current.isLoading).toBe(false)
	})
})

describe('useSyncStatus render stability (DX-5)', () => {
	function createStatusBridge() {
		const listeners = new Set<(status: SyncStatusInfo) => void>()
		let current: SyncStatusInfo = { ...OFFLINE_SYNC_STATUS }
		return {
			subscribeStatus: (listener: (status: SyncStatusInfo) => void) => {
				listeners.add(listener)
				listener(current)
				return () => listeners.delete(listener)
			},
			push(next: SyncStatusInfo) {
				current = next
				for (const listener of listeners) listener(next)
			},
			listenerCount: () => listeners.size,
		}
	}

	it('does not re-render for an equal status and keeps nested identities', async () => {
		const bridge = createStatusBridge()
		const app = createFakeApp({ subscribeStatus: bridge.subscribeStatus })
		const statuses: SyncStatusInfo[] = []
		let renders = 0
		function Probe() {
			const status = useSyncStatus()
			statuses.push(status)
			return createElement(
				Profiler,
				{
					id: 'p',
					onRender: () => {
						renders++
					},
				},
				createElement('span', { 'data-testid': 'status' }, status.status),
			)
		}
		render(createElement(provider(app), null, createElement(Probe)))
		await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('offline'))
		const held = [{ nodeId: 'n1', operationCount: 2, reason: 'other-user', principal: 'u1' }]

		act(() =>
			bridge.push({
				...OFFLINE_SYNC_STATUS,
				status: 'synced',
				heldOperations: 2,
				heldNodes: held.map((h) => ({ ...h })) as SyncStatusInfo['heldNodes'],
				localDurability: 'degraded',
				serverProtocolVersion: 1,
				protocolDeprecated: true,
			}),
		)
		const synced = statuses.at(-1) as SyncStatusInfo
		expect(synced.status).toBe('synced')
		expect(synced.heldOperations).toBe(2)
		expect(synced.localDurability).toBe('degraded')
		expect(synced.protocolDeprecated).toBe(true)
		const rendersAfterSynced = renders

		// Equal payload, fresh objects: no re-render, same object.
		act(() =>
			bridge.push({
				...OFFLINE_SYNC_STATUS,
				status: 'synced',
				heldOperations: 2,
				heldNodes: held.map((h) => ({ ...h })) as SyncStatusInfo['heldNodes'],
				localDurability: 'degraded',
				serverProtocolVersion: 1,
				protocolDeprecated: true,
			}),
		)
		expect(renders).toBe(rendersAfterSynced)
		expect(statuses.at(-1)).toBe(synced)

		// One field changes: a new object, but unchanged nested values keep identity.
		act(() =>
			bridge.push({
				...OFFLINE_SYNC_STATUS,
				status: 'synced',
				pendingOperations: 1,
				heldOperations: 2,
				heldNodes: held.map((h) => ({ ...h })) as SyncStatusInfo['heldNodes'],
				localDurability: 'degraded',
				serverProtocolVersion: 1,
				protocolDeprecated: true,
			}),
		)
		const next = statuses.at(-1) as SyncStatusInfo
		expect(next).not.toBe(synced)
		expect(next.pendingOperations).toBe(1)
		expect(next.heldNodes).toBe(synced.heldNodes)
		expect(next.initialSync).toBe(synced.initialSync)
	})

	it('defaults the Phase 2/3 fields when the engine omits them', async () => {
		const bridge = createStatusBridge()
		const app = createFakeApp({ subscribeStatus: bridge.subscribeStatus })
		const { result } = renderHook(() => useSyncStatus(), { wrapper: provider(app) })
		await waitFor(() => expect(result.current.status).toBe('offline'))
		act(() =>
			bridge.push({
				status: 'synced',
				reconnecting: false,
				pendingOperations: 0,
				lastSyncedAt: 1,
				lastSuccessfulPush: null,
				lastSuccessfulPull: null,
				conflicts: 0,
				clockSkewMs: null,
			}),
		)
		expect(result.current.status).toBe('synced')
		expect(result.current.heldOperations).toBe(0)
		expect(result.current.heldNodes).toEqual([])
		expect(result.current.localDurability).toBe('durable')
		expect(result.current.serverProtocolVersion).toBeNull()
		expect(result.current.protocolDeprecated).toBe(false)
	})

	it('reads a live engine (no bridge) without looping and unsubscribes on unmount', async () => {
		// Each getStatus() call builds a new object, like the real engine.
		const syncEngine = {
			getStatus: vi.fn(() => ({ ...OFFLINE_SYNC_STATUS, status: 'synced' as const })),
		}
		const store = createFakeStore()
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		let renders = 0
		function Probe() {
			renders++
			return createElement('span', null, useSyncStatus().status)
		}
		const view = render(
			createElement(KoraProvider, { store, syncEngine: syncEngine as never }, createElement(Probe)),
		)
		await act(async () => {})
		expect(view.container.textContent).toBe('synced')
		expect(renders).toBeLessThan(5)
		expect(errors).not.toHaveBeenCalled()
		view.unmount()
	})

	it('StrictMode: one live subscription after the double mount, none after unmount', async () => {
		const bridge = createStatusBridge()
		const app = createFakeApp({ subscribeStatus: bridge.subscribeStatus })
		const view = render(createElement(provider(app, true), null, createElement(StatusText)))
		await waitFor(() => expect(view.container.textContent).toBe('offline'))
		expect(bridge.listenerCount()).toBe(1)
		act(() => bridge.push({ ...OFFLINE_SYNC_STATUS, status: 'synced' }))
		expect(view.container.textContent).toBe('synced')
		view.unmount()
		expect(bridge.listenerCount()).toBe(0)
	})

	it('resubscribes once when the bridge is replaced, and cleans up on unmount', async () => {
		const first = createStatusBridge()
		const second = createStatusBridge()
		const appA = createFakeApp({ subscribeStatus: first.subscribeStatus })
		const appB = createFakeApp({ subscribeStatus: second.subscribeStatus })
		// Mount under app A, then swap to app B.
		const view = render(createElement(provider(appA), null, createElement(StatusText)))
		await waitFor(() => expect(view.container.textContent).toBe('offline'))
		expect(first.listenerCount()).toBe(1)
		view.rerender(createElement(provider(appB), null, createElement(StatusText)))
		await act(async () => {})
		act(() => second.push({ ...OFFLINE_SYNC_STATUS, status: 'synced' }))
		await waitFor(() => expect(view.container.textContent).toBe('synced'))
		expect(first.listenerCount()).toBe(0)
		expect(second.listenerCount()).toBe(1)
		view.unmount()
		expect(second.listenerCount()).toBe(0)
	})
})

function StatusText() {
	return createElement('span', null, useSyncStatus().status)
}
