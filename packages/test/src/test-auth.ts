import type { AuthSyncBinding, AuthSyncState } from '@korajs/core/bindings'

/** Controllable auth binding for lifecycle and authenticated-only sync tests. */
export interface TestAuthBinding extends AuthSyncBinding {
	readonly state: AuthSyncState
	setLoading(): void
	signIn(userId: string, token?: string): void
	refreshToken(token?: string): void
	signOut(): void
}

function testJwt(userId: string, generation: number): string {
	const encode = (value: unknown): string =>
		Buffer.from(JSON.stringify(value)).toString('base64url')
	return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, dev: 'test-device', generation })}.test`
}

/**
 * Create a deterministic auth binding that can transition between loading,
 * signed-out, and multiple authenticated users without a real auth server.
 */
export function createTestAuthBinding(options?: {
	initialUserId?: string
	anonymous?: boolean
}): TestAuthBinding {
	let generation = 0
	let state: AuthSyncState = options?.initialUserId
		? {
				state: 'authenticated',
				userId: options.initialUserId,
				token: testJwt(options.initialUserId, generation),
			}
		: { state: 'loading' }
	const listeners = new Set<() => void>()
	const notify = (): void => {
		for (const listener of listeners) listener()
	}

	return {
		get state() {
			return state
		},
		auth: async () => ({ token: state.state === 'authenticated' ? state.token : '' }),
		resolveSyncState: async () => state,
		resolveUserId: async () => (state.state === 'authenticated' ? state.userId : undefined),
		resolveNodeId: async () => (state.state === 'authenticated' ? 'test-device' : undefined),
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		setLoading() {
			state = { state: 'loading' }
			notify()
		},
		signIn(userId, token) {
			generation++
			state = { state: 'authenticated', userId, token: token ?? testJwt(userId, generation) }
			notify()
		},
		refreshToken(token) {
			if (state.state !== 'authenticated') throw new Error('Cannot refresh while signed out')
			generation++
			state = {
				...state,
				token: token ?? testJwt(state.userId, generation),
			}
			notify()
		},
		signOut() {
			state = options?.anonymous
				? { state: 'anonymous', mayConnectAnonymously: true }
				: { state: 'signed-out', mayConnectAnonymously: false }
			notify()
		},
	}
}
