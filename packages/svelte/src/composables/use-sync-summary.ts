import { type SyncSummary, summarizeSyncStatus } from '@korajs/sync/lite'
import { type Readable, derived } from 'svelte/store'
import { getKoraContext } from '../context'
import { createSyncStatusStore } from './use-sync-status'

/**
 * Readable store of the sync status summarized for an indicator: tone (`ok`, `working`,
 * `attention`), a short title, one honest line of detail, pending writes, and whether the
 * first download is still running. Follows {@link createSyncStatusStore}.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useSyncSummary } from '@korajs/svelte'
 *   const sync = useSyncSummary()
 * </script>
 * <span class="chip {$sync.tone}" title={$sync.detail}>{$sync.title}</span>
 * ```
 */
export function createSyncSummaryStore(): Readable<SyncSummary> {
	const context = getKoraContext()
	return derived(createSyncStatusStore(), (status) =>
		summarizeSyncStatus(status, {
			// Read per status: the engine arrives when the store opens.
			syncConfigured: context.syncEngine != null || context.subscribeSyncStatus != null,
		}),
	)
}

/** Alias for {@link createSyncSummaryStore}. */
export const useSyncSummary = createSyncSummaryStore
