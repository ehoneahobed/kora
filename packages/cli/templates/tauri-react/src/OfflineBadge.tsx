import { useOfflineReady } from '@korajs/react'

const DOT = { ready: '#34d399', preparing: '#fbbf24', 'not-ready': '#6b7280' } as const

/**
 * Whether this app would open with no network. The desktop build embeds its interface in
 * the binary and keeps its data in native SQLite, so this reads "Available offline" as soon
 * as the data is here. Hover for the first reason it is not. Read from `useOfflineReady()`.
 */
export function OfflineBadge() {
	const offline = useOfflineReady()
	// `tauri dev` serves the interface from the dev server; the badge is for built apps.
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
		<output
			title={offline.reasons[0]}
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				fontSize: '12px',
				color: '#9ca3af',
				background: '#1f2937',
				padding: '4px 12px',
				borderRadius: '9999px',
			}}
		>
			<span
				style={{
					width: '8px',
					height: '8px',
					borderRadius: '9999px',
					background: DOT[offline.state],
				}}
			/>
			<span>{text}</span>
		</output>
	)
}
