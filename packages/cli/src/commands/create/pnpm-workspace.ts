import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Write `pnpm-workspace.yaml` for a project scaffolded with pnpm.
 *
 * pnpm 10 blocks dependency build scripts unless allowed, and pnpm 11+ no longer reads the
 * `pnpm` field of package.json and FAILS the install (`ERR_PNPM_IGNORED_BUILDS`) when a
 * dependency such as esbuild or better-sqlite3 has an unapproved build script, so a freshly
 * scaffolded app would not install at all. The allow list lives in the template's
 * `package.json` (`pnpm.onlyBuiltDependencies`, still read by pnpm 9); this mirrors it into
 * the workspace file in both the pnpm 10 (`onlyBuiltDependencies`) and pnpm 11+
 * (`allowBuilds`) forms. `packages: ['.']` keeps pnpm 9 happy and makes the app its own
 * workspace root even when it is created inside another pnpm workspace.
 *
 * @param targetDir - The scaffolded project directory
 * @returns The packages allowed to run build scripts
 */
export async function writePnpmWorkspaceSettings(targetDir: string): Promise<string[]> {
	const manifest = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf-8')) as {
		pnpm?: { onlyBuiltDependencies?: unknown }
	}
	const listed = manifest.pnpm?.onlyBuiltDependencies
	const allowed = Array.isArray(listed)
		? [...new Set(listed.filter((name): name is string => typeof name === 'string'))].sort()
		: []
	await writeFile(join(targetDir, 'pnpm-workspace.yaml'), renderPnpmWorkspace(allowed), 'utf-8')
	return allowed
}

/**
 * Render the workspace file for a list of packages allowed to run build scripts.
 *
 * @param allowed - Package names
 * @returns YAML text
 */
export function renderPnpmWorkspace(allowed: readonly string[]): string {
	const quote = (name: string): string => `'${name.replace(/'/g, "''")}'`
	const lines = [
		'# pnpm settings for this app. Dependencies listed here may run their install',
		'# (build) scripts: pnpm 10 reads onlyBuiltDependencies, pnpm 11+ reads allowBuilds.',
		'packages:',
		"  - '.'",
	]
	if (allowed.length > 0) {
		lines.push('onlyBuiltDependencies:', ...allowed.map((name) => `  - ${quote(name)}`))
		lines.push('allowBuilds:', ...allowed.map((name) => `  ${quote(name)}: true`))
	}
	return `${lines.join('\n')}\n`
}
