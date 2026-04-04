import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** Checks if a directory exists at the given path */
export async function directoryExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

/**
 * Walks up the directory tree from startDir looking for a package.json
 * that contains a kora or @kora/* dependency.
 *
 * @param startDir - Directory to start searching from (defaults to cwd)
 * @returns Absolute path to the project root, or null if not found
 */
export async function findProjectRoot(startDir?: string): Promise<string | null> {
	let current = resolve(startDir ?? process.cwd())

	// Walk up until the filesystem root (where dirname(x) === x)
	for (;;) {
		const pkgPath = join(current, 'package.json')
		try {
			const content = await readFile(pkgPath, 'utf-8')
			const pkg: unknown = JSON.parse(content)
			if (isKoraProject(pkg)) {
				return current
			}
		} catch {
			// No package.json at this level, keep walking up
		}
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}

	return null
}

/**
 * Searches for a schema file in common locations within a project.
 *
 * @param projectRoot - The project root directory
 * @returns Absolute path to the schema file, or null if not found
 */
export async function findSchemaFile(projectRoot: string): Promise<string | null> {
	const candidates = [
		join(projectRoot, 'src', 'schema.ts'),
		join(projectRoot, 'schema.ts'),
		join(projectRoot, 'src', 'schema.js'),
		join(projectRoot, 'schema.js'),
	]

	for (const candidate of candidates) {
		try {
			await access(candidate)
			return candidate
		} catch {
			// Not found, try next
		}
	}

	return null
}

function isKoraProject(pkg: unknown): boolean {
	if (typeof pkg !== 'object' || pkg === null) return false
	const record = pkg as Record<string, unknown>
	return hasKoraDep(record.dependencies) || hasKoraDep(record.devDependencies)
}

function hasKoraDep(deps: unknown): boolean {
	if (typeof deps !== 'object' || deps === null) return false
	return Object.keys(deps).some((key) => key === 'kora' || key.startsWith('@kora/'))
}
