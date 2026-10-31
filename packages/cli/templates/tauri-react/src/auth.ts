import { type AuthClient, createKoraAuth, createKoraAuthSync } from '@korajs/auth'
import schema from './schema'

// This module is loaded after the first paint (see AppShell.tsx and AuthBridge.tsx): the task
// list renders from the local database and does not wait for the sign-in client.

export function createDesktopAuthClient(syncUrl: string | null): AuthClient {
	return createKoraAuth({
		serverUrl: getAuthServerUrl(syncUrl),
	})
}

const desktopAuthByUrl = new Map<string | null, DesktopAuth>()

interface DesktopAuth {
	authClient: AuthClient
	authSync: ReturnType<typeof createKoraAuthSync>
}

/** The sign-in client and the sync binding for one sync server, created once and shared. */
export function getDesktopAuth(syncUrl: string | null): DesktopAuth {
	let auth = desktopAuthByUrl.get(syncUrl)
	if (!auth) {
		const authClient = createDesktopAuthClient(syncUrl)
		auth = { authClient, authSync: createKoraAuthSync({ authClient, schema }) }
		desktopAuthByUrl.set(syncUrl, auth)
	}
	return auth
}

export function getAuthServerUrl(syncUrl: string | null): string {
	if (import.meta.env.VITE_AUTH_URL) {
		return import.meta.env.VITE_AUTH_URL
	}
	if (!syncUrl) {
		return 'http://localhost:3001'
	}

	const url = new URL(syncUrl)
	url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
	url.pathname = url.pathname.replace(/\/kora-sync\/?$/, '') || '/'
	url.search = ''
	url.hash = ''
	return url.toString().replace(/\/+$/, '')
}

export async function openOAuthSignIn(authClient: AuthClient, provider = 'google'): Promise<void> {
	const { url } = await authClient.getOAuthAuthorizationUrl(provider)
	window.open(url, '_blank', 'noopener,noreferrer')
}

export async function completeOAuthCallbackFromLocation(authClient: AuthClient): Promise<void> {
	const url = new URL(window.location.href)
	const code = url.searchParams.get('code')
	const state = url.searchParams.get('state')
	const provider = url.searchParams.get('provider') || 'google'

	if (!code || !state) {
		return
	}

	await authClient.completeOAuthSignIn(provider, { code, state })
	url.searchParams.delete('code')
	url.searchParams.delete('state')
	url.searchParams.delete('provider')
	window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`)
}
