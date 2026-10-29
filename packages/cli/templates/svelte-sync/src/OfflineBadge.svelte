<script lang="ts">
import { useOfflineReady } from '@korajs/svelte'

const offline = useOfflineReady()
// `vite dev` registers no service worker (a stale one must never shadow the dev server), so
// the badge would only say "not available" there.
const hidden = import.meta.env.DEV

const text = $derived.by(() => {
	if ($offline.state === 'ready') {
		return $offline.storage.persisted === false
			? 'Available offline \u00b7 may be cleared if unused'
			: 'Available offline'
	}
	if ($offline.state === 'preparing') {
		const progress = $offline.data.progress
		return `Preparing offline copy...${progress === null ? '' : ` ${Math.round(progress * 100)}%`}`
	}
	return 'Not available offline yet'
})
</script>

{#if !hidden}
	<output class="offline-badge" title={$offline.reasons[0]}>
		<span class="offline-dot {$offline.state}"></span>
		<span>{text}</span>
	</output>
{/if}
