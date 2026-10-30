import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TemplateSpec } from './templates'

const here = dirname(fileURLToPath(import.meta.url))

/** The repository root. */
export const REPO_ROOT = resolve(here, '../..')

/** Where packed tarballs of the workspace packages live (reused across templates and runs). */
export function packedDir(): string {
	return process.env.KORA_PACKED_DIR ?? join(tmpdir(), 'kora-offline-suite', 'packed')
}

/** Where the scaffolded apps live. */
export function appsDir(): string {
	return process.env.KORA_OFFLINE_APPS_DIR ?? join(tmpdir(), 'kora-offline-suite', 'apps')
}

/** The newest modification time of any file under `dir` (a directory's own mtime misses edits). */
function newestMtime(dir: string): number {
	let newest = 0
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs)
	}
	return newest
}

interface PackedPackage {
	name: string
	archive: string
}

/** Runs a command to completion and throws with its output on a non-zero exit. */
export function runChecked(
	cmd: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): string {
	const result = spawnSync(cmd, args, {
		cwd: options.cwd,
		encoding: 'utf8',
		env: { ...process.env, CI: 'true', ...options.env },
		timeout: options.timeoutMs ?? 600_000,
		maxBuffer: 64 * 1024 * 1024,
	})
	if (result.status !== 0) {
		throw new Error(
			`\`${cmd} ${args.join(' ')}\` failed in ${options.cwd} (exit ${result.status ?? 'none'}${
				result.error ? `, ${result.error.message}` : ''
			}):\n${(result.stdout ?? '').slice(-4000)}\n${(result.stderr ?? '').slice(-4000)}`,
		)
	}
	return result.stdout
}

/**
 * The archives already in `dir`, untouched. `KORA_PACKED_EXACT=1` (the release matrix) installs
 * exactly the tarballs it packed and validated, instead of packing again.
 */
function existingArchives(dir: string): PackedPackage[] {
	const archives = readdirSync(dir).filter((name) => name.endsWith('.tgz'))
	if (archives.length === 0) throw new Error(`KORA_PACKED_EXACT=1 but ${dir} holds no .tgz`)
	return archives.map((name) => {
		const archive = join(dir, name)
		const manifest = runChecked('tar', ['-xOf', archive, 'package/package.json'], { cwd: dir })
		const parsed = JSON.parse(manifest) as { name: string }
		return { name: parsed.name, archive }
	})
}

/**
 * Packs every publishable workspace package with `pnpm pack`, exactly what `npm publish` would
 * upload (workspace ranges rewritten, only declared files), and returns the archives by package
 * name. Packing is skipped for a package whose archive is already newer than its `dist`.
 */
export function packWorkspace(): PackedPackage[] {
	const dest = packedDir()
	mkdirSync(dest, { recursive: true })
	if (process.env.KORA_PACKED_EXACT === '1') return existingArchives(dest)
	const dirs = ['kora', 'create-kora-app']
	for (const entry of readdirSync(join(REPO_ROOT, 'packages'))) dirs.push(join('packages', entry))

	const packed: PackedPackage[] = []
	for (const dir of dirs) {
		const manifestPath = join(REPO_ROOT, dir, 'package.json')
		if (!existsSync(manifestPath)) continue
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
			name: string
			version: string
			private?: boolean
		}
		if (manifest.private === true) continue
		const archiveName = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
		const archive = join(dest, archiveName)
		const distDir = join(REPO_ROOT, dir, 'dist')
		const fresh =
			existsSync(archive) && existsSync(distDir) && statSync(archive).mtimeMs > newestMtime(distDir)
		if (!fresh) {
			runChecked('pnpm', ['pack', '--pack-destination', dest], {
				cwd: join(REPO_ROOT, dir),
				timeoutMs: 120_000,
			})
		}
		if (!existsSync(archive)) throw new Error(`pnpm pack did not produce ${archive}`)
		packed.push({ name: manifest.name, archive })
	}
	return packed
}

/**
 * The scaffolding entry. `KORA_OFFLINE_CREATE_ENTRY` points it at the `create.js` of an INSTALLED
 * packed `@korajs/cli` (the release matrix, `scripts/release/packed-matrix`), so the templates
 * under test are the ones in the tarball and not the workspace build. Unset, it is the
 * workspace build, which is what a local `pnpm test:e2e:offline` wants.
 */
const CREATE_ENTRY =
	process.env.KORA_OFFLINE_CREATE_ENTRY ?? join(REPO_ROOT, 'packages', 'cli', 'dist', 'create.js')

/** The single line the harness adds to an app so the helpers can reach `app.offline`. */
export const EXPOSE_MARKER = '__koraCreateApp'

/**
 * Exposes the app on `window.app` (the default accessor of `@korajs/test/playwright`).
 *
 * The templates keep their `app` module-local, as an app should; a test needs a handle. The
 * patch renames the `createApp` import and wraps it with a function that returns the same app
 * after storing it on `globalThis`. Nothing else in the template changes, so the build, the
 * service worker and the badge are exactly what a user gets.
 *
 * @param source - The contents of the template's `src/main.ts` or `src/main.tsx`
 * @returns The patched source
 */
export function exposeAppOnWindow(source: string): string {
	const importPattern = /import\s*\{([^}]*)\}\s*from\s*'korajs'/
	const match = importPattern.exec(source)
	if (!match) throw new Error("main entry has no `import { ... } from 'korajs'`")
	const specifiers = (match[1] ?? '').split(',').map((s) => s.trim())
	const index = specifiers.findIndex((s) => /^createApp(\s+as\s+\w+)?$/.test(s))
	if (index < 0) throw new Error("main entry does not import createApp from 'korajs'")
	const spec = specifiers[index] ?? ''
	const local = /\sas\s+(\w+)$/.exec(spec)?.[1] ?? 'createApp'
	specifiers[index] = `createApp as ${EXPOSE_MARKER}`
	const patchedImport = `import { ${specifiers.join(', ')} } from 'korajs'`
	const withImport = source.replace(importPattern, patchedImport)
	const shim = `const ${local} = ((...args: Parameters<typeof ${EXPOSE_MARKER}>) => {
	const created = ${EXPOSE_MARKER}(...args)
	Object.assign(globalThis, { app: created })
	return created
}) as typeof ${EXPOSE_MARKER}
`
	const useAt = withImport.search(new RegExp(`^(?:export )?const \\w+ = ${local}\\(`, 'm'))
	if (useAt < 0) throw new Error(`main entry never calls ${local}(...)`)
	return withImport.slice(0, useAt) + shim + withImport.slice(useAt)
}

/** Whether a source file imports `createApp` from `korajs` (under any local name). */
function importsCreateApp(source: string): boolean {
	return /import\s*\{[^}]*\bcreateApp\b[^}]*\}\s*from\s*'korajs'/.test(source)
}

/** Variations of {@link scaffoldInstallBuild} for scenarios beyond the offline-readiness suite. */
export interface ScaffoldOptions {
	/** Directory name under the apps directory (default: the template name). */
	dirName?: string
	/** Edits the scaffolded sources after the harness's own patches and before install and build. */
	patch?: (dir: string) => void
	/** Extra arguments of the template's `build` script (for example `--base=/app/`). */
	buildArgs?: string[]
}

export interface ScaffoldedApp {
	spec: TemplateSpec
	dir: string
	/** `dist/` of the production build. */
	distDir: string
}

/**
 * Scaffolds one template with the built CLI, installs it from the packed tarballs (the
 * template's third-party dependencies come from the registry, as for a user), exposes `window.app`
 * and runs the template's own `build` script.
 */
export function scaffoldInstallBuild(
	spec: TemplateSpec,
	packed: PackedPackage[],
	log: (line: string) => void = () => {},
	options: ScaffoldOptions = {},
): ScaffoldedApp {
	const root = appsDir()
	mkdirSync(root, { recursive: true })
	const dir = join(root, options.dirName ?? spec.name)
	if (existsSync(dir)) {
		// KORA_OFFLINE_REUSE=1 re-runs the tests against an app a previous local run built.
		if (process.env.KORA_OFFLINE_REUSE === '1' && existsSync(join(dir, 'dist', 'sw.js'))) {
			log(`reuse ${spec.name}`)
			return { spec, dir, distDir: join(dir, 'dist') }
		}
		throw new Error(`${dir} already exists; remove it or set KORA_OFFLINE_APPS_DIR`)
	}

	log(`scaffold ${spec.name}`)
	runChecked(
		process.execPath,
		[
			CREATE_ENTRY,
			options.dirName ?? spec.name,
			'--template',
			spec.name,
			'--skip-install',
			'--yes',
		],
		{ cwd: root, env: { NODE_ENV: 'test' } },
	)

	const manifestPath = join(dir, 'package.json')
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
		pnpm?: { overrides?: Record<string, string> }
	}
	manifest.pnpm = manifest.pnpm ?? {}
	manifest.pnpm.overrides = {
		...manifest.pnpm.overrides,
		...Object.fromEntries(packed.map((p) => [p.name, `file:${p.archive}`])),
	}
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

	// The file that creates the app: `src/main.ts(x)`, or `src/kora.ts` in the templates that
	// keep the app in its own module.
	const appFile = ['src/main.tsx', 'src/main.ts', 'src/kora.ts']
		.map((f) => join(dir, f))
		.find((f) => existsSync(f) && importsCreateApp(readFileSync(f, 'utf8')))
	if (appFile && !spec.desktop) {
		writeFileSync(appFile, exposeAppOnWindow(readFileSync(appFile, 'utf8')))
	} else if (!spec.desktop) {
		throw new Error(`${spec.name}: no source file creates the app with createApp from 'korajs'`)
	}

	// A sync template signs in with Google OAuth only; the suite needs an account it can create
	// headlessly, so the auth client is exposed too (`window.authClient.signUp(...)`).
	const authFile = join(dir, 'src', 'auth.ts')
	if (spec.sync && !spec.desktop && existsSync(authFile)) {
		writeFileSync(
			authFile,
			`${readFileSync(authFile, 'utf8')}\nObject.assign(globalThis, { authClient })\n`,
		)
	}

	// A scenario's own change to the template (the packed browser suite turns on a store option).
	options.patch?.(dir)

	log(`install ${spec.name}`)
	runChecked('pnpm', ['install', '--frozen-lockfile=false'], { cwd: dir, timeoutMs: 600_000 })
	log(`build ${spec.name}`)
	runChecked('pnpm', ['build', ...(options.buildArgs ?? [])], { cwd: dir, timeoutMs: 600_000 })

	const distDir = join(dir, 'dist')
	for (const artifact of ['index.html', 'sw.js']) {
		if (!existsSync(join(distDir, artifact))) {
			throw new Error(`${spec.name}: the production build did not emit dist/${artifact}`)
		}
	}
	return { spec, dir, distDir }
}

/** Finds a free TCP port. */
export async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address !== null ? address.port : 0
			server.close(() => resolvePort(port))
		})
	})
}

export interface RunningApp {
	origin: string
	port: number
	/** Output of the server process, for failure messages. */
	output: () => string
	stop: () => Promise<void>
}

/**
 * Serves the production build the way the template says to: `vite preview` for a local-only
 * template, `node --import tsx server.ts` (its own sync server, auth and static files) for a
 * sync template. Resolves when the server prints that it is listening.
 */
export async function serveApp(app: ScaffoldedApp): Promise<RunningApp> {
	const port = await freePort()
	const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), NODE_ENV: 'production' }
	let child: ChildProcess
	if (app.spec.sync) {
		env.KORA_AUTH_SECRET = 'offline-suite-secret-that-is-long-enough-0123456789'
		env.KORA_SERVER_DB = join(app.dir, '.kora', 'suite-server.db')
		env.KORA_AUTH_DB = join(app.dir, '.kora', 'suite-auth.db')
		mkdirSync(join(app.dir, '.kora'), { recursive: true })
		child = spawn('node', ['--import', 'tsx', 'server.ts'], { cwd: app.dir, env })
	} else {
		child = spawn(
			join(app.dir, 'node_modules', '.bin', 'vite'),
			['preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
			{ cwd: app.dir, env },
		)
	}
	let output = ''
	child.stdout?.on('data', (chunk: Buffer) => {
		output += chunk.toString()
	})
	child.stderr?.on('data', (chunk: Buffer) => {
		output += chunk.toString()
	})
	const origin = app.spec.sync ? `http://localhost:${port}` : `http://127.0.0.1:${port}`

	// Wait on the server's own "listening" line, then on the first successful request. No sleeps:
	// each wait ends on an event or a response, bounded by a deadline.
	await new Promise<void>((resolveReady, reject) => {
		const deadline = setTimeout(
			() => reject(new Error(`${app.spec.name}: server did not start in 60 s:\n${output}`)),
			60_000,
		)
		const check = (): void => {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
			const plain = output.replace(/\u001b\[[0-9;]*m/g, '')
			if (/running at|Local:\s+http|localhost:\d+|127\.0\.0\.1:\d+/.test(plain)) {
				clearTimeout(deadline)
				resolveReady()
			}
		}
		child.stdout?.on('data', check)
		child.stderr?.on('data', check)
		child.once('exit', (code) => {
			clearTimeout(deadline)
			reject(new Error(`${app.spec.name}: server exited with ${code} before listening:\n${output}`))
		})
		check()
	})
	const response = await fetch(`${origin}/`)
	if (!response.ok) throw new Error(`${app.spec.name}: GET / returned ${response.status}`)

	return {
		origin,
		port,
		output: () => output,
		stop: async () => {
			if (child.exitCode !== null) return
			await new Promise<void>((resolveStop) => {
				child.once('exit', () => resolveStop())
				child.kill('SIGTERM')
			})
		},
	}
}
