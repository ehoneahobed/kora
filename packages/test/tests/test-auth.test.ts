import { describe, expect, test, vi } from 'vitest'
import { createTestAuthBinding } from '../src/test-auth'

describe('createTestAuthBinding', () => {
	test('drives loading, multiple users, token refresh, and sign-out', async () => {
		const binding = createTestAuthBinding()
		const listener = vi.fn()
		binding.subscribe?.(listener)

		await expect(binding.resolveSyncState?.()).resolves.toEqual({ state: 'loading' })
		binding.signIn('user-a')
		const first = await binding.resolveSyncState?.()
		expect(first).toMatchObject({ state: 'authenticated', userId: 'user-a' })
		binding.refreshToken()
		const refreshed = await binding.resolveSyncState?.()
		expect(refreshed).toMatchObject({ state: 'authenticated', userId: 'user-a' })
		expect(refreshed).not.toEqual(first)

		binding.signOut()
		await expect(binding.resolveSyncState?.()).resolves.toEqual({
			state: 'signed-out',
			mayConnectAnonymously: false,
		})
		binding.signIn('user-b')
		await expect(binding.resolveUserId?.()).resolves.toBe('user-b')
		expect(listener).toHaveBeenCalledTimes(4)
	})
})
