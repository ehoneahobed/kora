/**
 * Updates for the installed app, through tauri-plugin-updater. The app asks the update address
 * (plugins.updater.endpoints in src-tauri/tauri.conf.json) for a newer, signed version; when one
 * is there, `<UpdateBanner />` offers it and nothing is installed until the person agrees. A check
 * that can't be made (offline, or a build without updates set up) says so rather than claiming
 * the app is up to date. See "Updates for installed apps" in the README to set it up.
 */

export type UpdateCheck =
	| { state: 'up-to-date' }
	| {
			state: 'available'
			version: string
			notes: string
			install: (onProgress?: (fraction: number) => void) => Promise<void>
	  }
	| { state: 'unavailable'; reason: string }

/** Ask the update address whether a newer version is available. */
export async function checkForUpdate(): Promise<UpdateCheck> {
	try {
		const { check } = await import('@tauri-apps/plugin-updater')
		const update = await check({ timeout: 15_000 })
		if (!update) return { state: 'up-to-date' }
		return {
			state: 'available',
			version: update.version,
			notes: update.body ?? '',
			install: async (onProgress) => {
				let total = 0
				let received = 0
				await update.downloadAndInstall((event) => {
					if (event.event === 'Started') total = event.data.contentLength ?? 0
					if (event.event === 'Progress') {
						received += event.data.chunkLength
						if (total > 0) onProgress?.(Math.min(1, received / total))
					}
				})
			},
		}
	} catch (error) {
		return { state: 'unavailable', reason: describeUpdateError(error) }
	}
}

/** What went wrong with a check, in words for the person using the app. */
export function describeUpdateError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error)
	if (/pubkey|endpoints|not configured/i.test(text)) return 'Updates are not set up for this build.'
	if (/network|connect|dns|timed? ?out|offline|request/i.test(text))
		return 'Could not reach the update server.'
	if (/signature/i.test(text)) return 'An update was found but its signature did not match, so it was not installed.'
	return `Could not check for updates (${text}).`
}
