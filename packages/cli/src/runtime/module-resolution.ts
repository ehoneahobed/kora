import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

/** Stable Node resolution anchors that work in both ESM and CommonJS bundles. */
export function runtimeResolutionAnchors(projectRoot?: string): string[] {
	const anchors = [
		projectRoot ? resolve(projectRoot, 'package.json') : null,
		process.argv[1] ? resolve(process.argv[1]) : null,
		resolve(process.cwd(), 'package.json'),
		process.execPath,
	]
	return [...new Set(anchors.filter((anchor): anchor is string => anchor !== null))]
}

/** Resolve a package export from the app, the running CLI, or the current workspace. */
export function resolveRuntimePackageExport(
	specifier: string,
	projectRoot?: string,
): string | null {
	for (const anchor of runtimeResolutionAnchors(projectRoot)) {
		try {
			return createRequire(anchor).resolve(specifier)
		} catch {
			// Try the next independently useful runtime anchor.
		}
	}
	return null
}

/** Load a CommonJS-compatible dependency using the stable runtime anchors. */
export function requireRuntimePackage(name: string, projectRoot?: string): unknown {
	const errors: string[] = []
	for (const anchor of runtimeResolutionAnchors(projectRoot)) {
		try {
			return createRequire(anchor)(name)
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error))
		}
	}
	throw new Error(errors.at(-1) ?? `Cannot resolve package "${name}"`)
}

/** Find the installed CLI root, including when executing a packed binary. */
export function resolveCliPackageRoot(): string | null {
	const packageJson = resolveRuntimePackageExport('@korajs/cli/package.json')
	if (packageJson) return dirname(packageJson)

	// A source checkout may not have a workspace self-link.
	let directory = process.cwd()
	for (;;) {
		const candidate = resolve(directory, 'package.json')
		if (existsSync(candidate)) {
			try {
				const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }
				if (manifest.name === '@korajs/cli') return directory
			} catch {
				// An unrelated malformed manifest is not the CLI root.
			}
		}
		const parent = dirname(directory)
		if (parent === directory) return null
		directory = parent
	}
}
