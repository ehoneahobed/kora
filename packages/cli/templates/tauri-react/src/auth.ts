import { type AuthClient, createKoraAuth } from '@korajs/auth'

export function createDesktopAuthClient(syncUrl: string | null): AuthClient {
	return createKoraAuth({
		serverUrl: getAuthServerUrl(syncUrl),
	})
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
