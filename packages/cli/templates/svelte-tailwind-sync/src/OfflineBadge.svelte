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

const DOT = {
	ready: 'bg-emerald-400',
	preparing: 'bg-amber-400',
	'not-ready': 'bg-gray-500',
} as const
</script>

{#if !hidden}
	<output
		title={$offline.reasons[0]}
		class="flex items-center gap-2 rounded-full bg-gray-800 px-3 py-1.5 text-sm text-gray-400"
	>
		<span class="h-2 w-2 rounded-full {DOT[$offline.state]}"></span>
		<span>{text}</span>
	</output>
{/if}
