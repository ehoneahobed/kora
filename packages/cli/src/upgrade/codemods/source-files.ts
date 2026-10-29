import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SourceFile } from './types'

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|svelte)$/
const IGNORED_DIRECTORIES = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'out',
	'coverage',
	'.next',
	'.nuxt',
	'.svelte-kit',
	'.turbo',
	'.vite',
	'.output',
	'target',
])
/** A generated bundle or data dump, not hand-written source. */
const MAX_FILE_BYTES = 1_000_000

/**
 * Reads the project's source files for the codemods. Skips dependency, build and cache
 * directories and declaration files; never follows symlinks. Sorted so output is stable.
 */
export async function readSourceFiles(projectRoot: string): Promise<SourceFile[]> {
	const files: SourceFile[] = []

	async function walk(directory: string, prefix: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true })
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		for (const entry of entries) {
			const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
			if (entry.isDirectory()) {
				if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(join(directory, entry.name), relative)
				continue
			}
			if (!entry.isFile() || !SOURCE_EXTENSIONS.test(entry.name) || entry.name.endsWith('.d.ts')) {
				continue
			}
			const absolute = join(directory, entry.name)
			if ((await stat(absolute)).size > MAX_FILE_BYTES) continue
			files.push({ path: relative, text: await readFile(absolute, 'utf-8') })
		}
	}

	await walk(projectRoot, '')
	return files
}

/** One-based line number of a character offset. */
export function lineOf(text: string, offset: number): number {
	let line = 1
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text.charCodeAt(i) === 10) line++
	}
	return line
}
