import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/**
 * The file access the production audit needs, so tests can inject a project without a
 * disk. Paths are absolute; `walk` returns paths relative to the directory, with `/`.
 */
export interface AuditFs {
	/** The file's text, or null when it is missing or unreadable. */
	readText(path: string): Promise<string | null>
	/** Every file under `directory` except inside a directory named in `skip`; null when it is missing. */
	walk(directory: string, skip: ReadonlySet<string>): Promise<string[] | null>
}

/** Directories no audit looks into: dependencies, VCS data and tool caches. */
export const AUDIT_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
	'node_modules',
	'.git',
	'.turbo',
	'.next',
	'.nuxt',
	'.svelte-kit',
	'.output',
	'.kora',
	'coverage',
	'target',
	'fixtures',
	'__fixtures__',
	'__tests__',
])

const MAX_WALKED_FILES = 5000

/** The real file system. */
export const nodeAuditFs: AuditFs = {
	async readText(path) {
		try {
			return await readFile(path, 'utf-8')
		} catch {
			return null
		}
	},
	async walk(directory, skip) {
		const files: string[] = []
		const visit = async (current: string): Promise<boolean> => {
			let entries: Dirent[]
			try {
				entries = await readdir(current, { withFileTypes: true })
			} catch {
				return false
			}
			entries.sort((a, b) => a.name.localeCompare(b.name))
			for (const entry of entries) {
				if (files.length >= MAX_WALKED_FILES) return true
				const path = join(current, entry.name)
				if (entry.isDirectory()) {
					if (!skip.has(entry.name)) await visit(path)
				} else if (entry.isFile()) {
					files.push(relative(directory, path).split(sep).join('/'))
				}
			}
			return true
		}
		return (await visit(directory)) ? files : null
	},
}
