<script lang="ts">
import { onDestroy } from 'svelte'
import type { AuthSessionSnapshot } from '../bindings/create-auth-session'
import type { AuthClient } from '../client/auth-client'
import { destroyAuthProvider, initAuthProvider } from './auth-context'

interface Props {
	client: AuthClient
	fallback?: import('svelte').Snippet
	children?: import('svelte').Snippet
}

const { client, fallback, children }: Props = $props()

const authContext = initAuthProvider(client)
let snapshot = $state<AuthSessionSnapshot>(authContext.session.getSnapshot())

$effect(() => {
	return authContext.session.subscribe(() => {
		snapshot = authContext.session.getSnapshot()
	})
})

onDestroy(() => {
	destroyAuthProvider(authContext)
})
</script>

{#if snapshot.initError}
	<div role="alert" style="color: red; padding: 1rem; font-family: monospace;">
		<strong>Kora Auth initialization error: </strong>{snapshot.initError.message}
	</div>
{:else if snapshot.isLoading && fallback}
	{@render fallback()}
{:else if children}
	{@render children()}
{/if}
