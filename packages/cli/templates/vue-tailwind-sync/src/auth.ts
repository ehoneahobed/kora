import { createKoraAuth, createKoraAuthSync } from '@korajs/auth'
import schema from './schema'

// This module is loaded after the first paint (see main.ts and AuthBridge.ts): the task list
// renders from the local database and does not wait for the sign-in client.

export const authServerUrl =
	import.meta.env.VITE_AUTH_URL || `${window.location.protocol}//${window.location.host}`

export const authClient = createKoraAuth({
	serverUrl: authServerUrl,
})

/** The sync auth binding: the sync scope and the offline sign-in answer come from the session. */
export const authSync = createKoraAuthSync({ authClient, schema })

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
