<script setup lang="ts">
import { useOfflineReady } from '@korajs/vue'
import { computed } from 'vue'

const offline = useOfflineReady()
// `vite dev` registers no service worker (a stale one must never shadow the dev server), so
// the badge would only say "not available" there.
const hidden = import.meta.env.DEV

const text = computed(() => {
	const status = offline.value
	if (status.state === 'ready') {
		return status.storage.persisted === false
			? 'Available offline \u00b7 may be cleared if unused'
			: 'Available offline'
	}
	if (status.state === 'preparing') {
		const progress = status.data.progress
		return `Preparing offline copy...${progress === null ? '' : ` ${Math.round(progress * 100)}%`}`
	}
	return 'Not available offline yet'
})
</script>

<template>
	<output v-if="!hidden" class="offline-badge" :title="offline.reasons[0]">
		<span :class="['offline-dot', offline.state]" />
		<span>{{ text }}</span>
	</output>
</template>
