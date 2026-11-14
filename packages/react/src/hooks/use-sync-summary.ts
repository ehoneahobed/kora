import { type SyncSummary, summarizeSyncStatus } from '@korajs/sync'
import { useMemo } from 'react'
import { useKoraContext } from '../context/kora-context'
import { useSyncStatus } from './use-sync-status'

/**
 * The sync status summarized for an indicator: tone (`ok`, `working`, `attention`), a short
 * title, one honest line of detail, pending writes, and whether the first download is still
 * running (show "Downloading…" then, not an empty state or a first-run setup). Re-renders when
 * the status changes, like {@link useSyncStatus}.
 *
 * @example
 * ```tsx
 * function SyncChip() {
 *   const sync = useSyncSummary()
 *   return <span className={`chip ${sync.tone}`} title={sync.detail}>{sync.title}</span>
 * }
 * ```
 */
export function useSyncSummary(): SyncSummary {
	const { syncEngine, subscribeSyncStatus } = useKoraContext()
	const info = useSyncStatus()
	const configured = syncEngine != null || subscribeSyncStatus != null
	return useMemo(
		() => summarizeSyncStatus(info, { syncConfigured: configured }),
		[info, configured],
	)
}
