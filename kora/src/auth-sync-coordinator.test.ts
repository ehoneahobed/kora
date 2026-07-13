import { describe, expect, test, vi } from 'vitest'
import { AuthSyncCoordinator } from './auth-sync-coordinator'
import type { AuthSyncBinding } from './types'

function createMockEngine() {
	return {
		stop: vi.fn(async () => {}),
		start: vi.fn(async () => {}),
		updateScope: vi.fn(),
		getStatus: vi.fn(() => ({ status: 'connected' as const })),
	}
}

function createBinding(overrides: Partial<AuthSyncBinding> = {}): AuthSyncBinding {
	return {
		auth: async () => ({ token: 'token' }),
		resolveScopeMap: async () => ({ todos: { userId: 'u1' } }),
		...overrides,
	}
}

describe('AuthSyncCoordinator', () => {
	test('serializes overlapping reconnect requests without concurrent runs', async () => {
		const engine = createMockEngine()
		let inFlightAuth = 0
		let maxConcurrentAuth = 0

		const binding = createBinding({
			auth: async () => {
				inFlightAuth++
				maxConcurrentAuth = Math.max(maxConcurrentAuth, inFlightAuth)
				await new Promise((resolve) => setTimeout(resolve, 10))
				inFlightAuth--
				return { token: 'token' }
			},
		})

		const coordinator = new AuthSyncCoordinator(() => engine as never, binding)
		coordinator.scheduleReconnect()
		coordinator.scheduleReconnect()
		coordinator.scheduleReconnect()

		await vi.waitFor(() => {
			expect(engine.start).toHaveBeenCalledTimes(2)
		})

		expect(maxConcurrentAuth).toBe(1)
	})

	test('stops sync when token is empty', async () => {
		const engine = createMockEngine()
		const coordinator = new AuthSyncCoordinator(
			() => engine as never,
			createBinding({ auth: async () => ({ token: '' }) }),
		)

		coordinator.scheduleReconnect()

		await vi.waitFor(() => {
			expect(engine.stop).toHaveBeenCalled()
		})
		expect(engine.start).not.toHaveBeenCalled()
	})
})
