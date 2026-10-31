<script lang="ts">
import type { KoraAppLike } from '@korajs/svelte'
import KoraProvider from '@korajs/svelte/KoraProvider.svelte'
import App from './App.svelte'
import { failAuth } from './auth-state'

const { kora }: { kora: KoraAppLike } = $props()

// The sign-in client is not on the first paint's path: the list renders from the local database.
const authBridge = import('./AuthBridge.svelte')
// A failed load must not take the app down: the screen is told, nothing renders.
authBridge.catch((error: unknown) => {
	console.error(
		'[Kora Auth] The sign-in client did not load; the app keeps working offline:',
		error,
	)
	failAuth()
})
</script>

<KoraProvider app={kora}>
	<App />
	{#await authBridge then bridge}
		<bridge.default />
	{:catch}
		<!-- reported above -->
	{/await}
</KoraProvider>
