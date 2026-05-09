import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { resolveProjectBinaryEntryPoint } from '../../../utils/fs-helpers'

/**
 * Inputs used to execute a client build through Vite.
 */
export interface ClientBuildOptions {
	projectRoot: string
	outDir: string
	mode?: 'development' | 'production'
}

/**
 * Result returned after a successful Vite build.
 */
export interface ClientBuildResult {
	outDir: string
}

/**
 * Builds the client bundle with the project's local Vite installation.
 *
 * After Vite completes, patches the output to ensure SQLite WASM assets
 * are present. The template's sqliteWasmHotfix Vite plugin writes to the
 * default `dist/` directory, but `kora deploy` redirects output to
 * `.kora/deploy/dist/`. This post-build step fills in any missing assets.
 */
export async function buildClient(options: ClientBuildOptions): Promise<ClientBuildResult> {
	const viteEntryPoint = await resolveProjectBinaryEntryPoint(options.projectRoot, 'vite', 'vite')
	if (!viteEntryPoint) {
		throw new Error(
			`Could not find local Vite binary in ${options.projectRoot}. Install dependencies before deploying.`,
		)
	}

	const args = [
		viteEntryPoint,
		'build',
		'--outDir',
		options.outDir,
		'--mode',
		options.mode ?? 'production',
	]

	await runProcess(process.execPath, args, options.projectRoot)
	await patchSqliteWasmAssets(options.projectRoot, options.outDir)
	return { outDir: options.outDir }
}

/**
 * Ensures the SQLite WASM assets required for OPFS are present in the build output.
 *
 * 1. Copies the content-hashed `sqlite3-XXXX.wasm` to `sqlite3.wasm` (Emscripten's
 *    locateFile expects the unhashed name).
 * 2. Copies `sqlite3-opfs-async-proxy.js` from node_modules (dynamically loaded by
 *    sqlite3, invisible to Vite's bundler).
 */
async function patchSqliteWasmAssets(projectRoot: string, outDir: string): Promise<void> {
	const assetsDir = join(outDir, 'assets')
	if (!existsSync(assetsDir)) return

	const files = await readdir(assetsDir)

	// Copy hashed sqlite3 WASM to unhashed name
	const hashedWasm = files.find((f) => /^sqlite3-.+\.wasm$/.test(f))
	if (hashedWasm && !files.includes('sqlite3.wasm')) {
		await copyFile(join(assetsDir, hashedWasm), join(assetsDir, 'sqlite3.wasm'))
	}

	// Copy OPFS async proxy worker
	if (!files.includes('sqlite3-opfs-async-proxy.js')) {
		const proxyFile = resolve(
			projectRoot,
			'node_modules',
			'@sqlite.org',
			'sqlite-wasm',
			'sqlite-wasm',
			'jswasm',
			'sqlite3-opfs-async-proxy.js',
		)
		if (existsSync(proxyFile)) {
			await copyFile(proxyFile, join(assetsDir, 'sqlite3-opfs-async-proxy.js'))
		}
	}
}

async function runProcess(command: string, args: string[], cwd: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: 'inherit',
			env: process.env,
		})

		child.on('error', (error) => {
			reject(error)
		})

		child.on('exit', (code) => {
			if (code === 0) {
				resolve()
				return
			}

			reject(new Error(`Client build failed with exit code ${String(code ?? 'unknown')}.`))
		})
	})
}
