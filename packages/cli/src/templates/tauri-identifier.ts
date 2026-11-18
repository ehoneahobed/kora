/**
 * The Tauri bundle identifier a scaffolded desktop app starts with: `com.<name>`, from the app
 * name. Tauri keys the app's data directory on it, so each app needs its own, and it must not
 * change once the app ships (the data would stay behind under the old one).
 *
 * The result is reverse-DNS valid: segments of lowercase letters, digits and hyphens that
 * start with a letter. It never ends in `.app` (Tauri warns that clashes with macOS bundles).
 */
export function tauriIdentifierFor(projectName: string): string {
	const segment = projectName
		.toLowerCase()
		.replace(/^@[^/]*\//, '')
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
	const name =
		segment.length === 0
			? 'desktop'
			: segment === 'app'
				? 'app-desktop'
				: /^[a-z]/.test(segment)
					? segment
					: `app-${segment}`
	return `com.${name}`
}
