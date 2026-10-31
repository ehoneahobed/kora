import { type Readable, get, writable } from 'svelte/store'

/** The signed-in user as the screen needs it. */
export interface AuthUser {
	id: string
	email?: string | null
}

/** What the screen knows about the session. `isLoading` until the sign-in client has loaded. */
export interface AuthState {
	isLoading: boolean
	user: AuthUser | null
	isAuthenticated: boolean
	error: string | null
	signInWithOAuth: (provider: string) => void
	signOut: () => Promise<void>
}

const state = writable<AuthState>({
	isLoading: true,
	user: null,
	isAuthenticated: false,
	error: null,
	signInWithOAuth: () => {},
	signOut: async () => {},
})

/** Called by AuthBridge once the sign-in client is running. */
export function publishAuth(next: AuthState): void {
	state.set(next)
}

/**
 * The session for the screen. The sign-in client (about 11 KB gzip) loads after the first paint,
 * so this reports `isLoading: true` for the first moments: the list and the form do not wait for it.
 */
export const auth: Readable<AuthState> = { subscribe: state.subscribe }

/**
 * The sign-in client failed to load (a stale chunk after a deploy, a dropped request, offline
 * before the precache finished). The app keeps working; the session stays unknown (`isLoading`)
 * and the screen is told why, so nothing is mistaken for "signed out".
 */
export function failAuth(): void {
	state.set({
		...get(state),
		error: 'Sign-in is unavailable right now. The app keeps working offline; reload to try again.',
	})
}
