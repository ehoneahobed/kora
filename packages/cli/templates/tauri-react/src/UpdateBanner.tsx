import { useEffect, useState } from 'react'
import { type UpdateCheck, checkForUpdate } from './updater'

type Available = Extract<UpdateCheck, { state: 'available' }>

/**
 * Offers a newer version once, when the built app starts: "Version x is available" with Install
 * and Later. Installing downloads and installs it, then asks for a restart (Windows restarts the
 * app itself). Nothing installs without a click.
 */
export function UpdateBanner() {
	const [update, setUpdate] = useState<Available | null>(null)
	const [status, setStatus] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		// `tauri dev` has nothing to update; the check is for built apps.
		if (import.meta.env.DEV) return
		let cancelled = false
		void checkForUpdate().then((result) => {
			if (!cancelled && result.state === 'available') setUpdate(result)
		})
		return () => {
			cancelled = true
		}
	}, [])

	if (!update) return null

	const install = async () => {
		setBusy(true)
		setStatus('Downloading...')
		try {
			await update.install((fraction) => setStatus(`Downloading... ${Math.round(fraction * 100)}%`))
			setStatus(
				`Version ${update.version} is installed. Close the app and open it again to use it.`,
			)
		} catch (error) {
			setStatus(error instanceof Error ? error.message : 'The update could not be installed.')
			setBusy(false)
		}
	}

	return (
		<div
			role="status"
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: '12px',
				padding: '8px 16px',
				fontSize: '13px',
				color: '#e5e7eb',
				background: '#1f2937',
				borderBottom: '1px solid #374151',
			}}
		>
			<span style={{ flex: 1 }}>{status ?? `Version ${update.version} is available.`}</span>
			{status === null ? (
				<>
					<button type="button" onClick={() => setUpdate(null)} style={{ cursor: 'pointer' }}>
						Later
					</button>
					<button
						type="button"
						onClick={() => void install()}
						disabled={busy}
						style={{ cursor: 'pointer' }}
					>
						Install
					</button>
				</>
			) : null}
		</div>
	)
}
