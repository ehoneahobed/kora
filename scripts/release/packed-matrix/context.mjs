/**
 * Shared plumbing of the packed-artifact release matrix: packing the workspace exactly as
 * `npm publish` would, installing the tarballs into throwaway consumer projects, and running
 * child processes with their output captured for failure messages.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The repository root. */
export const ROOT = resolve(import.meta.dirname, '../../..')

/** Where the consumer-side scripts (run by plain `node` inside a fixture) live. */
export const CONSUMER_DIR = join(import.meta.dirname, 'consumer')

/**
 * Third-party packages a consumer installs next to the candidate tarballs. `better-sqlite3`
 * comes from `@korajs/server`; `postgres` is its optional peer, `ws` is the WebSocket a Node
 * client needs before Node 22 ships one globally.
 */
const THIRD_PARTY = { postgres: '^3.4.0', ws: '^8.18.0' }

/** @returns {{ dir: string, manifest: Record<string, any> }[]} every publishable package */
export function listPublishable() {
	const dirs = ['kora', 'create-kora-app']
	for (const entry of readdirSync(join(ROOT, 'packages'))) dirs.push(join('packages', entry))
	return dirs
		.map((dir) => ({ dir, path: join(ROOT, dir, 'package.json') }))
		.filter(({ path }) => existsSync(path))
		.map(({ dir, path }) => ({ dir, manifest: JSON.parse(readFileSync(path, 'utf8')) }))
		.filter(({ manifest }) => manifest.private !== true)
}

/**
 * Runs a command to completion and captures its output.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string | undefined>, timeoutMs?: number, input?: string }} options
 * @returns {{ status: number | null, stdout: string, stderr: string, error?: Error }}
 */
export function run(cmd, args, options) {
	const result = spawnSync(cmd, args, {
		cwd: options.cwd,
		encoding: 'utf8',
		env: { ...process.env, CI: 'true', ...options.env },
		timeout: options.timeoutMs ?? 300_000,
		maxBuffer: 64 * 1024 * 1024,
		...(options.input !== undefined ? { input: options.input } : {}),
	})
	return {
		status: result.status,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		...(result.error ? { error: result.error } : {}),
	}
}

/** Like {@link run} but throws, with the tail of the output, on a non-zero exit. */
export function runChecked(cmd, args, options) {
	const result = run(cmd, args, options)
	if (result.status !== 0) {
		throw new Error(
			`\`${cmd} ${args.join(' ')}\` failed in ${options.cwd} (exit ${result.status ?? 'none'}${
				result.error ? `, ${result.error.message}` : ''
			}):\n${result.stdout.slice(-3000)}\n${result.stderr.slice(-3000)}`,
		)
	}
	return result.stdout
}

/**
 * Starts a long-lived child (a server, a dev process) and resolves with a handle once `ready`
 * matches its output. No sleeps: the wait ends on the child's own line or a deadline.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string | undefined>, ready: RegExp, timeoutMs?: number }} options
 */
export function start(cmd, args, options) {
	const child = spawn(cmd, args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let output = ''
	const onData = (chunk) => {
		output += chunk.toString()
	}
	child.stdout.on('data', onData)
	child.stderr.on('data', onData)
	return new Promise((resolveStart, reject) => {
		const deadline = setTimeout(() => {
			child.kill('SIGKILL')
			reject(
				new Error(`\`${cmd} ${args.join(' ')}\` was not ready in time:\n${output.slice(-3000)}`),
			)
		}, options.timeoutMs ?? 60_000)
		const check = () => {
			if (options.ready.test(output)) {
				clearTimeout(deadline)
				resolveStart({
					output: () => output,
					stop: () =>
						new Promise((resolveStop) => {
							if (child.exitCode !== null) return resolveStop()
							child.once('exit', () => resolveStop())
							child.kill('SIGTERM')
						}),
				})
			}
		}
		child.stdout.on('data', check)
		child.stderr.on('data', check)
		child.once('exit', (code) => {
			clearTimeout(deadline)
			reject(
				new Error(`\`${cmd}\` exited with ${code} before it was ready:\n${output.slice(-3000)}`),
			)
		})
		check()
	})
}

/**
 * The shared state of one matrix run: the packed tarballs, the work directory and helpers to
 * create consumer projects from the tarballs. Checks only ever read the tarballs; every check
 * gets a directory of its own, so one failing check cannot poison another.
 */
export class MatrixContext {
	/** @param {{ keep: boolean, templates: string[] | 'all' | undefined }} options */
	constructor(options) {
		this.keep = options.keep
		this.templates = options.templates
		this.work = process.env.KORA_MATRIX_DIR
			? resolve(process.env.KORA_MATRIX_DIR)
			: mkdtempSync(join(tmpdir(), 'kora-packed-matrix-'))
		mkdirSync(this.work, { recursive: true })
		this.packedDir = join(this.work, 'packed')
		/** @type {Map<string, string>} package name -> tarball */
		this.archives = new Map()
		/** @type {Map<string, string>} package name -> packed version */
		this.versions = new Map()
		this.counter = 0
		/** State handed from a prerequisite check to the checks that need it. */
		this.shared = {}
	}

	/** A fresh empty directory for one check. */
	dir(name) {
		this.counter += 1
		const path = join(this.work, `${String(this.counter).padStart(2, '0')}-${name}`)
		mkdirSync(path, { recursive: true })
		return path
	}

	/**
	 * Packs every publishable package with `pnpm pack`: the exact bytes `npm publish` uploads
	 * (workspace ranges rewritten, only the declared files). The A7 offline suite reads the same
	 * directory through `KORA_PACKED_DIR`, so it installs these very tarballs.
	 */
	pack() {
		mkdirSync(this.packedDir, { recursive: true })
		for (const { dir, manifest } of listPublishable()) {
			const before = new Set(readdirSync(this.packedDir))
			runChecked('pnpm', ['pack', '--pack-destination', this.packedDir], {
				cwd: join(ROOT, dir),
				timeoutMs: 120_000,
			})
			const name = readdirSync(this.packedDir).find((entry) => !before.has(entry))
			if (!name) throw new Error(`pnpm pack produced no archive for ${manifest.name}`)
			this.archives.set(manifest.name, join(this.packedDir, name))
			this.versions.set(manifest.name, manifest.version)
		}
	}

	/** `{ name: 'file:/abs/archive.tgz' }` for every packed package, as pnpm overrides. */
	overrides(except = []) {
		return Object.fromEntries(
			[...this.archives]
				.filter(([name]) => !except.includes(name))
				.map(([name, archive]) => [name, `file:${archive}`]),
		)
	}

	/** The packed version of `name`. */
	version(name) {
		const version = this.versions.get(name)
		if (!version) throw new Error(`${name} is not part of the packed release`)
		return version
	}

	/**
	 * Creates a consumer project that depends on the given packed packages (and the third-party
	 * packages in `extra`), with every other packed package overridden to its tarball, and
	 * installs it. Lifecycle scripts run: `better-sqlite3` must fetch or build its binding.
	 *
	 * @param {string} dir
	 * @param {{ packages: string[], extra?: Record<string, string>, name?: string }} options
	 */
	installConsumer(dir, options) {
		const dependencies = { ...THIRD_PARTY, ...(options.extra ?? {}) }
		for (const name of options.packages) {
			const archive = this.archives.get(name)
			if (!archive) throw new Error(`${name} is not part of the packed release`)
			dependencies[name] = `file:${archive}`
		}
		writeFileSync(
			join(dir, 'package.json'),
			`${JSON.stringify(
				{
					name: options.name ?? 'kora-packed-consumer',
					private: true,
					type: 'module',
					dependencies,
					// pnpm 10 skips dependency build scripts unless they are allowed; a user on pnpm 10
					// approves these three once (`pnpm approve-builds`). Without better-sqlite3's binding
					// there is no Node server and no Node client.
					pnpm: {
						overrides: this.overrides(),
						onlyBuiltDependencies: ['better-sqlite3', 'esbuild', 'protobufjs'],
					},
				},
				null,
				2,
			)}\n`,
		)
		runChecked('pnpm', ['install', '--frozen-lockfile=false'], { cwd: dir, timeoutMs: 300_000 })
	}

	/** Removes the work directory unless the run was asked to keep it. */
	cleanup() {
		if (!this.keep) rmSync(this.work, { recursive: true, force: true })
	}
}
