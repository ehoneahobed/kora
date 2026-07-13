import { createKoraAuth } from '@korajs/auth'

export const authServerUrl =
	import.meta.env.VITE_AUTH_URL || `${window.location.protocol}//${window.location.host}`

export const authClient = createKoraAuth({
	serverUrl: authServerUrl,
})

export async function completeOAuthCallbackFromLocation(): Promise<void> {
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
