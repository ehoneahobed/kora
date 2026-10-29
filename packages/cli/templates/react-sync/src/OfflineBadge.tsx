import { useOfflineReady } from '@korajs/react'

/**
 * Whether this app would open with no network: "Available offline" once the app shell and
 * the data are stored on this device. Hover for the first reason it is not. Read from
 * `useOfflineReady()`; `app.offline.status()` has the full picture.
 */
export function OfflineBadge() {
	const offline = useOfflineReady()
	// `vite dev` registers no service worker (a stale one must never shadow the dev server),
	// so the badge would only say "not available" there.
	if (import.meta.env.DEV) return null

	const progress = offline.data.progress
	const text =
		offline.state === 'ready'
			? offline.storage.persisted === false
				? 'Available offline \u00b7 may be cleared if unused'
				: 'Available offline'
			: offline.state === 'preparing'
				? `Preparing offline copy...${progress === null ? '' : ` ${Math.round(progress * 100)}%`}`
				: 'Not available offline yet'

	return (
		<output className="offline-badge" title={offline.reasons[0]}>
			<span className={`offline-dot ${offline.state}`} />
			<span>{text}</span>
		</output>
	)
}
