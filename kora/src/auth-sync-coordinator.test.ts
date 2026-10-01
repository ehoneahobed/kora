import { describe, expect, test, vi } from 'vitest'
import { AuthSyncCoordinator, transportAuthState } from './auth-sync-coordinator'
import type { AuthSyncBinding } from './types'

function createMockEngine() {
	return {
		stop: vi.fn(async () => {}),
		start: vi.fn(async () => {}),
		reconnect: vi.fn(async () => {}),
		updateScope: vi.fn(),
		getStatus: vi.fn(() => ({ status: 'connected' as const, reconnecting: false })),
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
			expect(engine.reconnect).toHaveBeenCalledTimes(2)
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
		expect(engine.reconnect).not.toHaveBeenCalled()
	})
})

describe('transportAuthState (authenticated-offline)', () => {
	test('keeps the transport suspended while the session has no fresh token', async () => {
		const offline = transportAuthState(
			createBinding({
				resolveSyncState: async () => ({
					state: 'authenticated',
					userId: 'u1',
					token: null,
					offline: true,
				}),
			}),
		)
		expect(await offline?.()).toEqual({ state: 'loading' })

		const fresh = transportAuthState(
			createBinding({
				resolveSyncState: async () => ({ state: 'authenticated', userId: 'u1', token: 't' }),
			}),
		)
		expect(await fresh?.()).toEqual({ state: 'authenticated', userId: 'u1', token: 't' })
		expect(transportAuthState(createBinding())).toBeUndefined()
		expect(transportAuthState(null)).toBeUndefined()
	})

	test('the coordinator stops and suspends the engine while offline, and reconnects once fresh', async () => {
		const engine = createMockEngine()
		let token: string | null = null
		const binding = createBinding({
			auth: async () => ({ token: token ?? '' }),
			resolveSyncState: async () => ({
				state: 'authenticated',
				userId: 'u1',
				token,
				...(token ? {} : { offline: true }),
			}),
		})
		const coordinator = new AuthSyncCoordinator(() => engine as never, binding)
		coordinator.scheduleReconnect()
		await vi.waitFor(() => expect(engine.start).toHaveBeenCalledTimes(1))
		expect(engine.reconnect).not.toHaveBeenCalled()

		token = 'fresh'
		coordinator.scheduleReconnect()
		await vi.waitFor(() => expect(engine.reconnect).toHaveBeenCalledTimes(1))
	})
})
