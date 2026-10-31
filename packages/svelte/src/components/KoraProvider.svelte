<script lang="ts">
import type { KoraAppLike } from '../types'
import KoraContextBridge from './KoraContextBridge.svelte'
import KoraStoreBridge from './KoraStoreBridge.svelte'

interface Props {
	app: KoraAppLike
	fallback?: import('svelte').Snippet
	/**
	 * Hold the children back (render `fallback`) until `app.ready`. By default the children
	 * render at once: queries are empty and writes wait until the store opens.
	 */
	waitForStorage?: boolean
	children?: import('svelte').Snippet
}

const { app, fallback, waitForStorage = false, children }: Props = $props()

// An app whose accessors work before `app.ready` renders at once (first-visit parity, S4a);
// an older or hand-made app object cannot, and keeps the gate.
const renderEarly = $derived(!waitForStorage && app.collections !== undefined)

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
{:else if !ready && !renderEarly}
	{#if fallback}
		{@render fallback()}
	{:else}
		<div>Loading...</div>
	{/if}
{:else if children}
	<KoraContextBridge {app} opened={ready}>
		{@render children()}
	</KoraContextBridge>
{/if}
