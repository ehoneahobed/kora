/**
 * Auto-updater integration via tauri-plugin-updater.
 *
 * Checks for updates on app launch and periodically. When an update is
 * available, the user is notified and can install it with a restart.
 *
 * Configure the update endpoint in src-tauri/tauri.conf.json under
 * plugins.updater.endpoints. For GitHub Releases, use:
 *   "endpoints": ["https://github.com/YOUR_ORG/YOUR_REPO/releases/latest/download/latest.json"]
 *
 * To generate signing keys: `pnpm tauri signer generate -w ~/.tauri/myapp.key`
 * Set the pubkey in tauri.conf.json and TAURI_SIGNING_PRIVATE_KEY in CI.
 */

let updateChecked = false

/**
 * Check for updates once on app startup.
 * Silently skips if the updater is not configured (empty endpoints/pubkey).
 */
export async function checkForUpdates(): Promise<void> {
	if (updateChecked) return
	updateChecked = true

	try {
		const { check } = await import('@tauri-apps/plugin-updater')
		const update = await check()
		if (update) {
			console.log(`Update available: v${update.version}`)
			// Download and install — the app will restart automatically
			await update.downloadAndInstall()
		}
	} catch (err) {
		// Updater not configured or network unavailable — this is fine.
		// The app works fully offline; updates are best-effort.
		console.debug('Update check skipped:', err)
	}
}
