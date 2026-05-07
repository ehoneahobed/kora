import { describe, expect, it, vi } from 'vitest'
import { KoraAuthProvider } from './kora-auth-provider'

// Minimal mock implementations matching the structural interfaces

function createMockTokenValidator(payloads: Record<string, { sub: string; dev: string; type: string } | null>) {
	return {
		validateToken(token: string) {
			return payloads[token] ?? null
		},
	}
}

function createMockUserLookup(users: Record<string, { id: string; email: string; name: string }>) {
	return {
		findById: vi.fn(async (userId: string) => users[userId] ?? null),
	}
}

function createMockDeviceTracker() {
	return {
		touchDevice: vi.fn(async (_deviceId: string) => {}),
	}
}

describe('KoraAuthProvider', () => {
	const VALID_TOKEN = 'valid-access-token'
	const REFRESH_TOKEN = 'valid-refresh-token'
	const EXPIRED_TOKEN = 'expired-token'

	const tokenValidator = createMockTokenValidator({
		[VALID_TOKEN]: { sub: 'user-1', dev: 'device-1', type: 'access' },
		[REFRESH_TOKEN]: { sub: 'user-1', dev: 'device-1', type: 'refresh' },
	})

	const userLookup = createMockUserLookup({
		'user-1': { id: 'user-1', email: 'alice@example.com', name: 'Alice' },
	})

	const deviceTracker = createMockDeviceTracker()

	it('authenticates a valid access token', async () => {
		const provider = new KoraAuthProvider({
			tokenValidator,
			userLookup,
			deviceTracker,
		})

		const context = await provider.authenticate(VALID_TOKEN)
		expect(context).not.toBeNull()
		expect(context?.userId).toBe('user-1')
		expect(context?.metadata?.deviceId).toBe('device-1')
		expect(context?.metadata?.email).toBe('alice@example.com')
		expect(context?.metadata?.name).toBe('Alice')
	})

	it('rejects an invalid token', async () => {
		const provider = new KoraAuthProvider({ tokenValidator, userLookup })

		const context = await provider.authenticate('garbage-token')
		expect(context).toBeNull()
	})

	it('rejects a refresh token (only access tokens allowed for sync)', async () => {
		const provider = new KoraAuthProvider({ tokenValidator, userLookup })

		const context = await provider.authenticate(REFRESH_TOKEN)
		expect(context).toBeNull()
	})

	it('rejects if the user no longer exists', async () => {
		const emptyUserLookup = createMockUserLookup({})
		const provider = new KoraAuthProvider({
			tokenValidator,
			userLookup: emptyUserLookup,
		})

		const context = await provider.authenticate(VALID_TOKEN)
		expect(context).toBeNull()
	})

	it('touches the device when deviceTracker is provided', async () => {
		const tracker = createMockDeviceTracker()
		const provider = new KoraAuthProvider({
			tokenValidator,
			userLookup,
			deviceTracker: tracker,
		})

		await provider.authenticate(VALID_TOKEN)
		expect(tracker.touchDevice).toHaveBeenCalledWith('device-1')
	})

	it('works without deviceTracker', async () => {
		const provider = new KoraAuthProvider({ tokenValidator, userLookup })

		const context = await provider.authenticate(VALID_TOKEN)
		expect(context).not.toBeNull()
	})

	it('resolves scopes when resolver is provided', async () => {
		const provider = new KoraAuthProvider({
			tokenValidator,
			userLookup,
			resolveScopes: async (userId) => ({
				forms: { userId },
				responses: { formOwnerId: userId },
			}),
		})

		const context = await provider.authenticate(VALID_TOKEN)
		expect(context).not.toBeNull()
		expect(context?.scopes).toEqual({
			forms: { userId: 'user-1' },
			responses: { formOwnerId: 'user-1' },
		})
	})

	it('does not include scopes when no resolver is provided', async () => {
		const provider = new KoraAuthProvider({ tokenValidator, userLookup })

		const context = await provider.authenticate(VALID_TOKEN)
		expect(context).not.toBeNull()
		expect(context?.scopes).toBeUndefined()
	})
})
