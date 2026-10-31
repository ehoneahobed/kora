<script lang="ts">
import type { KoraAppLike } from '@korajs/svelte'
import KoraProvider from '@korajs/svelte/KoraProvider.svelte'
import App from './App.svelte'
import { loadAuthBridge } from './load-auth-bridge'

const { kora }: { kora: KoraAppLike } = $props()

// The sign-in client is not on the first paint's path: the list renders from the local database.
const authBridge = loadAuthBridge(() => import('./AuthBridge.svelte'))
</script>

<KoraProvider app={kora}>
	<App />
	{#await authBridge then bridge}
		<bridge.default />
	{:catch}
		<!-- reported above -->
	{/await}
</KoraProvider>
