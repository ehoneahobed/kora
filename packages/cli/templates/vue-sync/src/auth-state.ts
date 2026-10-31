import { reactive } from 'vue'

/** The signed-in user as the screen needs it. */
export interface AuthUser {
	id: string
	email?: string | null
}

/** What the screen knows about the session. `loading` until the sign-in client has loaded. */
export interface AuthState {
	loading: boolean
	user: AuthUser | null
	isAuthenticated: boolean
	error: string | null
	signIn: () => void
	signOut: () => Promise<void>
}

const state = reactive<AuthState>({
	loading: true,
	user: null,
	isAuthenticated: false,
	error: null,
	signIn: () => {},
	signOut: async () => {},
})

/** Called by AuthBridge once the sign-in client is running. */
export function publishAuth(next: AuthState): void {
	Object.assign(state, next)
}

/**
 * The session for the screen. The sign-in client (about 11 KB gzip) loads after the first paint,
 * so this reports `loading: true` for the first moments: the list and the form do not wait for it.
 */
export function useAuthState(): AuthState {
	return state
}
