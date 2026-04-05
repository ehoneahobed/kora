import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveProjectBinary } from '../../utils/fs-helpers'

export interface KoraConfigFile {
	schema?: string
	dev?: {
		port?: number
			sync?:
				| boolean
				| {
					enabled?: boolean
					port?: number
					store?:
						| 'memory'
						| 'sqlite'
						| 'postgres'
						| {
							type: 'memory'
						}
						| {
							type: 'sqlite'
							filename?: string
						}
						| {
							type: 'postgres'
							connectionString: string
						}
				}
		watch?:
			| boolean
			| {
				enabled?: boolean
				debounceMs?: number
			}
	}
}

const CONFIG_CANDIDATES = [
	'kora.config.ts',
	'kora.config.mts',
	'kora.config.cts',
	'kora.config.js',
	'kora.config.mjs',
	'kora.config.cjs',
]

/**
 * Loads `kora.config.*` from the project root if present.
 */
export async function loadKoraConfig(projectRoot: string): Promise<KoraConfigFile | null> {
	const configPath = await findKoraConfigFile(projectRoot)
	if (!configPath) return null

	const ext = extname(configPath)
	if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
		const loaded = await loadTypeScriptConfig(configPath, projectRoot)
		return toConfigObject(loaded)
	}

	const loaded = await import(pathToFileURL(configPath).href)
	return toConfigObject(loaded)
}

async function findKoraConfigFile(projectRoot: string): Promise<string | null> {
	for (const file of CONFIG_CANDIDATES) {
		const candidate = join(projectRoot, file)
		try {
			await access(candidate)
			return candidate
		} catch {
			// continue
		}
	}

	return null
}

async function loadTypeScriptConfig(configPath: string, projectRoot: string): Promise<unknown> {
	const tsxBinary = await resolveProjectBinary(projectRoot, 'tsx')
	if (!tsxBinary) {
		throw new Error(
			`Found TypeScript config at ${configPath}, but "tsx" is not installed in this project. Install tsx or use kora.config.js.`,
		)
	}

	// Use dynamic import() and .then() to avoid top-level await,
	// which fails when tsx treats --eval as CJS.
	const script =
		'const configPath = process.argv[process.argv.length - 1];' +
		"import('node:url').then(u => import(u.pathToFileURL(configPath).href))" +
		'.then(mod => { const v = mod.default ?? mod; process.stdout.write(JSON.stringify(v)) })' +
		'.catch(e => { process.stderr.write(String(e)); process.exit(1) })'

	const output = await runCommand(tsxBinary, ['--eval', script, configPath], projectRoot)

	try {
		return JSON.parse(output)
	} catch {
		throw new Error(`Failed to parse ${configPath} output as JSON.`)
	}
}

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: process.env,
			shell: process.platform === 'win32',
		})

		let stdout = ''
		let stderr = ''

		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf-8')
		})

		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf-8')
		})

		child.on('error', (error) => {
			reject(error)
		})

		child.on('exit', (code) => {
			if (code === 0) {
				resolve(stdout.trim())
				return
			}

			reject(new Error(`Failed to load kora config (exit ${code ?? 'unknown'}): ${stderr.trim()}`))
		})
	})
}

function toConfigObject(mod: unknown): KoraConfigFile {
	if (typeof mod !== 'object' || mod === null) {
		throw new Error('kora config must export an object.')
	}

	const value = (mod as Record<string, unknown>).default ?? mod
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('kora config must export an object.')
	}

	return value as KoraConfigFile
}
