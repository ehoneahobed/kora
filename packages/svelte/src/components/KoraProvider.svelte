<script lang="ts">
import type { KoraAppLike } from '../types'
import KoraContextBridge from './KoraContextBridge.svelte'
import KoraStoreBridge from './KoraStoreBridge.svelte'

interface Props {
	app: KoraAppLike
	fallback?: import('svelte').Snippet
	children?: import('svelte').Snippet
}

const { app, fallback, children }: Props = $props()

let ready = $state(false)
let initError = $state<Error | null>(null)

$effect(() => {
	let cancelled = false
	ready = false
	initError = null

	void (async () => {
		try {
			await app.ready
			if (cancelled) return
			ready = true
		} catch (error: unknown) {
			if (cancelled) return
			initError = error instanceof Error ? error : new Error(String(error))
			console.error('[Kora] Initialization failed:', initError)
		}
	})()

	return () => {
		cancelled = true
	}
})
</script>

{#if initError}
	<div role="alert" style="color: red; padding: 1rem; font-family: monospace;">
		<strong>Kora initialization error: </strong>{initError.message}
	</div>
{:else if !ready}
	{#if fallback}
		{@render fallback()}
	{:else}
		<div>Loading...</div>
	{/if}
{:else if children}
	<KoraContextBridge {app}>
		{@render children()}
	</KoraContextBridge>
{/if}
