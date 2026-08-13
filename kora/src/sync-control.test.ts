import { defineSchema, t } from '@korajs/core'
import { OFFLINE_SYNC_STATUS } from '@korajs/sync'
import type { SyncEngine, SyncStatusInfo } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { createSyncControl } from './sync-control'
import type { SyncRuntimeState } from './sync-lifecycle'

function harness(initial: SyncStatusInfo) {
	let status = initial
	const listeners = new Set<(status: SyncStatusInfo) => void>()
	const engine = { getStatus: () => status } as unknown as SyncEngine
	const state = {
		syncEngine: engine,
		syncStatusBridge: {
			get status() {
				return status
			},
			subscribe(listener: (next: SyncStatusInfo) => void) {
				listeners.add(listener)
				listener(status)
				return () => listeners.delete(listener)
			},
			refresh: vi.fn(),
			destroy: vi.fn(),
		},
	} as unknown as SyncRuntimeState
	const control = createSyncControl({
		config: {
			schema: defineSchema({
				version: 1,
				collections: { todos: { fields: { title: t.string() } } },
			}),
			sync: { url: 'ws://test' },
		},
		ready: Promise.resolve(),
		state,
	})
	if (!control) throw new Error('Expected sync control')
	return {
		control,
		set(next: SyncStatusInfo) {
			status = next
			for (const listener of listeners) listener(next)
		},
		listeners,
	}
}

describe('SyncControl.waitForSettled', () => {
	test('waits for both upload acknowledgement and active-view completion', async () => {
		const pending = {
			...OFFLINE_SYNC_STATUS,
			status: 'syncing' as const,
			phase: 'receiving' as const,
			pendingOperations: 1,
			activeViewComplete: false,
		}
		const test = harness(pending)
		const result = test.control.waitForSettled({ timeoutMs: 1000 })
		test.set({
			...pending,
			status: 'synced',
			phase: 'streaming',
			pendingOperations: 0,
			activeViewComplete: true,
		})
		await expect(result).resolves.toMatchObject({ outcome: 'settled' })
		expect(test.listeners.size).toBe(0)
	})

	test('returns structured suspended, blocked, timeout, and aborted outcomes', async () => {
		const suspended = harness({
			...OFFLINE_SYNC_STATUS,
			status: 'auth-required',
			phase: 'suspended',
			reason: 'auth-required',
		})
		await expect(suspended.control.waitForSettled()).resolves.toMatchObject({
			outcome: 'suspended',
			reason: 'auth-required',
		})
		const failure = {
			operationId: 'op-1',
			collection: 'todos',
			recordId: 'todo-1',
			code: 'APPLY_FAILED',
			message: 'failed',
			retriable: true,
			firstSeenAt: 1,
			retryCount: 0,
		}
		const blocked = harness({
			...OFFLINE_SYNC_STATUS,
			status: 'error',
			phase: 'blocked',
			blockedFailure: failure,
		})
		await expect(blocked.control.waitForSettled()).resolves.toMatchObject({
			outcome: 'blocked',
			failure,
		})

		const syncing = harness({ ...OFFLINE_SYNC_STATUS, status: 'syncing', phase: 'receiving' })
		await expect(syncing.control.waitForSettled({ timeoutMs: 1 })).resolves.toMatchObject({
			outcome: 'timeout',
		})
		const controller = new AbortController()
		const aborted = syncing.control.waitForSettled({ signal: controller.signal })
		controller.abort()
		await expect(aborted).resolves.toMatchObject({ outcome: 'aborted' })
		expect(syncing.listeners.size).toBe(0)
	})
})
