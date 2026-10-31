import type { AuthSyncBinding } from '@korajs/core/bindings'
import { describe, expect, test, vi } from 'vitest'
import { lazyAuthSync } from './lazy-auth-sync'

function realBinding(overrides: Partial<AuthSyncBinding> = {}): AuthSyncBinding {
	return {
		auth: vi.fn(async () => ({ token: 'tok' })),
		resolveSyncState: vi.fn(async () => ({
			state: 'authenticated' as const,
			userId: 'u1',
			token: 'tok',
		})),
		resolveUserId: vi.fn(async () => 'u1'),
		...overrides,
	}
}

describe('lazyAuthSync', () => {
	test('loads nothing until a method is called, then once', async () => {
		const load = vi.fn(async () => realBinding())
		const binding = lazyAuthSync(load)
		expect(load).not.toHaveBeenCalled()
		await binding.auth?.()
		await binding.resolveUserId?.()
		expect(load).toHaveBeenCalledTimes(1)
	})

	test('delegates every method to the loaded binding', async () => {
		const real = realBinding()
		const binding = lazyAuthSync(async () => real)
		expect(await binding.auth({ forceRefresh: true })).toEqual({ token: 'tok' })
		expect(real.auth).toHaveBeenCalledWith({ forceRefresh: true })
		expect(await binding.resolveSyncState?.()).toMatchObject({ state: 'authenticated' })
		expect(await binding.resolveUserId?.()).toBe('u1')
	})

	test('absent optional methods degrade without throwing', async () => {
		const binding = lazyAuthSync(async () => ({ auth: async () => ({ token: '' }) }))
		expect(await binding.resolveScopeMap?.()).toBeUndefined()
		expect(await binding.resolveNodeId?.()).toBeUndefined()
		expect(await binding.resolveOfflineRestore?.()).toEqual({
			restorable: 'unknown',
			reason: 'credential-durability-unknown',
		})
		expect(await binding.resolveSyncState?.()).toEqual({
			state: 'signed-out',
			mayConnectAnonymously: false,
		})
	})

	test('a failed load is reported to the caller and retried by the next call', async () => {
		const load = vi
			.fn<() => Promise<AuthSyncBinding>>()
			.mockRejectedValueOnce(new Error('chunk dropped'))
			.mockResolvedValue(realBinding())
		const binding = lazyAuthSync(load)
		await expect(binding.auth()).rejects.toThrow('chunk dropped')
		expect(await binding.auth()).toEqual({ token: 'tok' })
		expect(load).toHaveBeenCalledTimes(2)
	})

	test('a subscriber is attached after the load and told once that the binding exists', async () => {
		const inner = vi.fn(() => () => {})
		const binding = lazyAuthSync(async () => realBinding({ subscribe: inner }))
		const listener = vi.fn()
		const off = binding.subscribe?.(listener)
		await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
		expect(inner).toHaveBeenCalledWith(listener)
		off?.()
	})

	test('unsubscribing before the load finishes never attaches the listener', async () => {
		let release: (b: AuthSyncBinding) => void = () => {}
		const inner = vi.fn(() => () => {})
		const binding = lazyAuthSync(
			() =>
				new Promise<AuthSyncBinding>((resolve) => {
					release = resolve
				}),
		)
		const listener = vi.fn()
		const off = binding.subscribe?.(listener)
		off?.()
		release(realBinding({ subscribe: inner }))
		await binding.auth()
		expect(inner).not.toHaveBeenCalled()
		expect(listener).not.toHaveBeenCalled()
	})
})
