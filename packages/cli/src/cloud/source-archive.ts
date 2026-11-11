import { execFile } from 'node:child_process'
import type { Stats } from 'node:fs'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { compileIgnore } from './ignore-file'

const run = promisify(execFile)

/** Kora Cloud refuses larger uploads; checking first saves sending one that would be refused. */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024
/** What an upload may unpack to on the server. */
const MAX_SOURCE_BYTES = 512 * 1024 * 1024

/** Never uploaded, whatever .gitignore says: dependencies, build output, local state and secrets. */
const ALWAYS_LEFT_OUT = [
	/(^|\/)node_modules(\/|$)/,
	/(^|\/)\.git(\/|$)/,
	/(^|\/)\.kora(\/|$)/,
	/(^|\/)\.env(\.(?!example$|sample$)[^/]*)?$/,
	/(^|\/)\.DS_Store$/,
]
/** Also left out when the project isn't in git, since there is no .gitignore to go by. */
const DEFAULT_IGNORED = [
	/(^|\/)(dist|build|coverage|\.next|\.turbo|\.vite|\.cache)(\/|$)/,
	/\.log$/,
]

export interface PackedSource {
	archive: Uint8Array
	/** Where the Kora project is inside the archive: `.` or a path such as `apps/web`. */
	root: string
	/** The commit, when the upload is exactly a clean git commit. */
	gitCommit: string | null
	files: number
	/** Files that weren't uploaded, with why: links aren't followed, and paths too long for tar. */
	skipped: string[]
}

export function isLeftOut(path: string, inGit: boolean): boolean {
	return (
		ALWAYS_LEFT_OUT.some((pattern) => pattern.test(path)) ||
		(!inGit && DEFAULT_IGNORED.some((pattern) => pattern.test(path)))
	)
}

async function git(cwd: string, args: string[]): Promise<string | null> {
	try {
		return (await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout
	} catch {
		return null
	}
}

async function walk(root: string, directory = root): Promise<string[]> {
	const found: string[] = []
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		const name = relative(root, path).split(sep).join('/')
		if (isLeftOut(name, false)) continue
		if (entry.isDirectory()) found.push(...(await walk(root, path)))
		else found.push(name)
	}
	return found
}

/**
 * Packs a project's source for Kora Cloud as a gzipped tar with one top-level folder. Inside a git
 * repository the whole repository is packed (a monorepo's lockfile and shared packages are part
 * of the build), and only the files git would commit: tracked ones and untracked ones not ignored.
 */
export async function packSource(givenRoot: string): Promise<PackedSource> {
	// git reports resolved paths, so the root is resolved too (temporary and linked folders differ).
	const projectRoot = await realpath(givenRoot)
	const reported = (await git(projectRoot, ['rev-parse', '--show-toplevel']))?.trim() || null
	const top = reported ? await realpath(reported) : null
	const base = top ?? projectRoot
	const listed = top
		? await git(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
		: null
	const candidates =
		listed !== null ? listed.split('\0').filter((path) => path.length > 0) : await walk(base)
	const root = top ? relative(top, projectRoot).split(sep).join('/') || '.' : '.'
	const koraIgnored = await readKoraIgnore(base, root)
	const paths = [...new Set(candidates)]
		.filter((path) => !isLeftOut(path, listed !== null) && !koraIgnored(path))
		.sort()
	const clean = top ? (await git(top, ['status', '--porcelain']))?.trim() === '' : false
	const gitCommit = clean ? ((await git(base, ['rev-parse', 'HEAD']))?.trim() ?? null) : null

	const parts: Buffer[] = []
	const skipped: string[] = []
	let total = 0
	let files = 0
	for (const path of paths) {
		const absolute = join(base, path)
		let stats: Stats
		try {
			stats = await lstat(absolute)
		} catch {
			// Listed by git but deleted in the working tree.
			continue
		}
		if (stats.isSymbolicLink()) {
			skipped.push(`${path} (a link)`)
			continue
		}
		if (!stats.isFile()) continue
		const header = tarHeader(`source/${path}`, stats.mode & 0o111 ? 0o755 : 0o644, stats.size)
		if (!header) {
			skipped.push(`${path} (path too long)`)
			continue
		}
		total += stats.size
		if (total > MAX_SOURCE_BYTES)
			throw new Error(
				'The project is larger than 512 MiB without dependencies. Check that build output and large files are ignored.',
			)
		const content = await readFile(absolute)
		parts.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512))
		files += 1
	}
	parts.push(Buffer.alloc(1024))
	return {
		archive: new Uint8Array(gzipSync(Buffer.concat(parts))),
		root,
		gitCommit: gitCommit && /^[a-f0-9]{40}$/.test(gitCommit) ? gitCommit : null,
		files,
		skipped,
	}
}

/**
 * Files to leave out per `.koraignore`: the repository root's applies to every path, and a
 * project folder's (in a monorepo) to the paths inside it, relative to that folder.
 */
async function readKoraIgnore(base: string, root: string): Promise<(path: string) => boolean> {
	const read = async (directory: string): Promise<((path: string) => boolean) | null> => {
		try {
			return compileIgnore(await readFile(join(directory, '.koraignore'), 'utf8'))
		} catch {
			return null
		}
	}
	const atRoot = await read(base)
	const atProject = root === '.' ? null : await read(join(base, root))
	const prefix = `${root}/`
	return (path) =>
		Boolean(atRoot?.(path)) ||
		Boolean(atProject && path.startsWith(prefix) && atProject(path.slice(prefix.length)))
}

/**
 * A POSIX ustar header. Long paths are split between the name and prefix fields; a path that
 * fits neither is reported instead of being written under a wrong name.
 */
export function tarHeader(path: string, mode: number, size: number): Buffer | null {
	const bytes = Buffer.from(path, 'utf8')
	let name = path
	let prefix = ''
	if (bytes.length > 100) {
		const split = path.lastIndexOf('/', path.length - 1)
		let cut = -1
		for (let index = split; index > 0; index = path.lastIndexOf('/', index - 1)) {
			if (
				Buffer.byteLength(path.slice(0, index)) <= 155 &&
				Buffer.byteLength(path.slice(index + 1)) <= 100
			) {
				cut = index
				break
			}
		}
		if (cut === -1) return null
		prefix = path.slice(0, cut)
		name = path.slice(cut + 1)
	}
	const header = Buffer.alloc(512)
	header.write(name, 0, 100, 'utf8')
	header.write(mode.toString(8).padStart(7, '0'), 100, 8, 'ascii')
	header.write('0000000', 108, 8, 'ascii')
	header.write('0000000', 116, 8, 'ascii')
	header.write(size.toString(8).padStart(11, '0'), 124, 12, 'ascii')
	header.write('00000000000', 136, 12, 'ascii')
	header.write('        ', 148, 8, 'ascii')
	header.write('0', 156, 1, 'ascii')
	header.write('ustar\u000000', 257, 8, 'ascii')
	header.write(prefix, 345, 155, 'utf8')
	let sum = 0
	for (const byte of header) sum += byte
	header.write(`${sum.toString(8).padStart(6, '0')}\u0000 `, 148, 8, 'ascii')
	return header
}
