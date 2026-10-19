import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every test run gets its own temporary directory: `os.tmpdir()` points into it for the
 * run (its workers and the processes they start inherit the environment), and it is
 * removed when the run ends. A test that forgets to remove what it creates under the
 * temporary directory, or a worker that is killed before its cleanup runs, then leaves
 * nothing behind, so repeated runs cannot fill the disk. What a run left is reported;
 * with KORA_TEST_STRICT_TMP=1 it fails the run, to find the test that leaks.
 *
 * Postgres schemas are not covered: each test file drops the schemas it creates.
 */

const RUN_PREFIX = 'kora-vitest-'
/** A run directory of a process that no longer exists is removed after this long. */
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000
/** Node's module compile cache, kept across runs (a link to the shared one). */
const COMPILE_CACHE = 'node-compile-cache'

interface RunState {
	dir: string
	users: number
	saved: Record<'TMPDIR' | 'TMP' | 'TEMP', string | undefined>
}

const STATE_KEY = Symbol.for('kora.vitest.runTempDir')

/** Shared by every project of one Vitest process (the root config runs several). */
function state(): { current: RunState | null } {
	const holder = globalThis as { [STATE_KEY]?: { current: RunState | null } }
	if (!holder[STATE_KEY]) holder[STATE_KEY] = { current: null }
	return holder[STATE_KEY]
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/** Remove run directories of runs that crashed (their process is gone) long ago. */
function sweepOrphans(base: string): void {
	let entries: string[]
	try {
		entries = readdirSync(base)
	} catch {
		return
	}
	const now = Date.now()
	for (const entry of entries) {
		if (!entry.startsWith(RUN_PREFIX)) continue
		const pid = Number(entry.slice(RUN_PREFIX.length).split('-')[0])
		if (!Number.isInteger(pid) || pid <= 0 || isAlive(pid)) continue
		const path = join(base, entry)
		try {
			if (now - statSync(path).mtimeMs < ORPHAN_AGE_MS) continue
			rmSync(path, { recursive: true, force: true })
		} catch (error) {
			console.warn(`[kora test] could not remove the orphaned run directory ${path}:`, error)
		}
	}
}

export default function setup(): () => void {
	const shared = state()
	if (shared.current) {
		shared.current.users += 1
	} else {
		const base = tmpdir()
		sweepOrphans(base)
		const dir = mkdtempSync(join(base, `${RUN_PREFIX}${process.pid}-`))
		try {
			// Workers keep using the compile cache every run shares.
			mkdirSync(join(base, COMPILE_CACHE), { recursive: true })
			symlinkSync(join(base, COMPILE_CACHE), join(dir, COMPILE_CACHE), 'dir')
		} catch {
			// Without the link, workers only compile without a cache.
		}
		shared.current = {
			dir,
			users: 1,
			saved: { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP },
		}
		process.env.TMPDIR = dir
		process.env.TMP = dir
		process.env.TEMP = dir
	}
	return () => {
		const run = shared.current
		if (!run) return
		run.users -= 1
		if (run.users > 0) return
		shared.current = null
		for (const [key, value] of Object.entries(run.saved)) {
			if (value === undefined) Reflect.deleteProperty(process.env, key)
			else process.env[key] = value
		}
		let left: string[] = []
		try {
			left = readdirSync(run.dir).filter((entry) => entry !== COMPILE_CACHE)
		} catch {
			left = []
		}
		// rmSync removes the compile cache link, never what it points to.
		rmSync(run.dir, { recursive: true, force: true })
		if (left.length > 0) {
			const message = `[kora test] tests left ${left.length} temporary entr${left.length === 1 ? 'y' : 'ies'} (removed with the run directory): ${left.slice(0, 20).join(', ')}${left.length > 20 ? ', ...' : ''}`
			if (process.env.KORA_TEST_STRICT_TMP === '1') throw new Error(message)
			console.warn(message)
		}
	}
}
