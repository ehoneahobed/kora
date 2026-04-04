import { execSync } from 'node:child_process'
import type { PackageManager } from '../types'

/**
 * Detects the package manager used to invoke the current process
 * by reading the npm_config_user_agent environment variable.
 * Falls back to 'npm' if detection fails.
 */
export function detectPackageManager(): PackageManager {
	const userAgent = process.env['npm_config_user_agent']
	if (!userAgent) return 'npm'

	if (userAgent.startsWith('pnpm/')) return 'pnpm'
	if (userAgent.startsWith('yarn/')) return 'yarn'
	if (userAgent.startsWith('bun/')) return 'bun'
	return 'npm'
}

/** Returns the install command for the given package manager */
export function getInstallCommand(pm: PackageManager): string {
	return pm === 'yarn' ? 'yarn' : `${pm} install`
}

/** Returns the dev server run command for the given package manager */
export function getRunDevCommand(pm: PackageManager): string {
	if (pm === 'npm') return 'npm run dev'
	return `${pm} dev`
}

/** Checks if a package manager is available on PATH */
export function isPackageManagerAvailable(pm: PackageManager): boolean {
	try {
		execSync(`${pm} --version`, { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}
