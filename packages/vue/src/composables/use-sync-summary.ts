import type { SyncStatusInfo } from '@korajs/sync'
import { type SyncSummary, summarizeSyncStatus } from '@korajs/sync/lite'
import { type ComputedRef, computed } from 'vue'
import { useKoraContextRef } from '../context'
import { useSyncStatus } from './use-sync-status'

/**
 * The sync status summarized for an indicator: tone (`ok`, `working`, `attention`), a short
 * title, one honest line of detail, pending writes, and whether the first download is still
 * running. A computed ref that follows {@link useSyncStatus}.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useSyncSummary } from '@korajs/vue'
 * const sync = useSyncSummary()
 * </script>
 * <template><span :class="['chip', sync.tone]" :title="sync.detail">{{ sync.title }}</span></template>
 * ```
 */
export function useSyncSummary(): ComputedRef<SyncSummary> {
	const context = useKoraContextRef()
	const status = useSyncStatus()
	return computed(() => {
		const { syncEngine, subscribeSyncStatus } = context.value
		return summarizeSyncStatus(status.value as SyncStatusInfo, {
			syncConfigured: syncEngine != null || subscribeSyncStatus != null,
		})
	})
}
