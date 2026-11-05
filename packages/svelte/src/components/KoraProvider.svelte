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

// What opened (or failed) is remembered with the app it belongs to, so a new `app` prop never
// shows the previous app's state for a moment.
let openedApp = $state.raw<KoraAppLike | null>(null)
let failure = $state.raw<{ app: KoraAppLike; error: Error } | null>(null)
const ready = $derived(openedApp === app)
const initError = $derived(failure !== null && failure.app === app ? failure.error : null)

$effect(() => {
	const current = app
	let cancelled = false

	void (async () => {
		try {
			await current.ready
			if (cancelled) return
			openedApp = current
		} catch (error: unknown) {
			if (cancelled) return
			const err = error instanceof Error ? error : new Error(String(error))
			console.error('[Kora] Initialization failed:', err)
			failure = { app: current, error: err }
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
	<!-- The bridge reads its app once: a new app gets a new bridge. -->
	{#key app}
		<KoraContextBridge {app} opened={ready}>
			{@render children()}
		</KoraContextBridge>
	{/key}
{/if}
