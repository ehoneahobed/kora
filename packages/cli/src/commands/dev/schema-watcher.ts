import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { resolveProjectBinary } from '../../utils/fs-helpers'

export interface SchemaWatcherConfig {
	schemaPath: string
	projectRoot: string
	debounceMs?: number
	onRegenerate?: () => void
	onError?: (error: Error) => void
}

/**
 * Watches a schema file and regenerates types when it changes.
 */
export class SchemaWatcher {
	private readonly debounceMs: number
	private watcher: FSWatcher | null = null
	private debounceTimer: NodeJS.Timeout | null = null

	constructor(private readonly config: SchemaWatcherConfig) {
		this.debounceMs = config.debounceMs ?? 300
	}

	start(): void {
		if (this.watcher) return

		this.watcher = watch(this.config.schemaPath, () => {
			this.scheduleRegeneration()
		})

		this.watcher.on('error', (error) => {
			this.config.onError?.(toError(error))
		})
	}

	stop(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = null
		}

		this.watcher?.close()
		this.watcher = null
	}

	async regenerate(): Promise<void> {
		const koraBinary = await resolveProjectBinary(this.config.projectRoot, 'kora')
		if (!koraBinary) {
			throw new Error('Could not find project binary "kora" in node_modules/.bin.')
		}

		const tsxBinary = await resolveProjectBinary(this.config.projectRoot, 'tsx')
		if (!tsxBinary) {
			process.stderr.write('[kora] Could not find "tsx" binary. Falling back to node.\n')
		}

		const command = tsxBinary ?? process.execPath
		const args = [koraBinary, 'generate', 'types', '--schema', this.config.schemaPath]

		await spawnCommand(command, args, this.config.projectRoot)
		this.config.onRegenerate?.()
	}

	private scheduleRegeneration(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
		}

		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null
			void this.regenerate().catch((error) => {
				this.config.onError?.(toError(error))
			})
		}, this.debounceMs)
	}
}

async function spawnCommand(command: string, args: string[], cwd: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: process.env,
			shell: process.platform === 'win32',
		})

		child.stdout?.on('data', (chunk: Buffer) => {
			writePrefixedLines(chunk, false)
		})

		child.stderr?.on('data', (chunk: Buffer) => {
			writePrefixedLines(chunk, true)
		})

		child.on('error', (error) => {
			reject(error)
		})

		child.on('exit', (code) => {
			if (code === 0) {
				resolve()
				return
			}
			reject(new Error(`Type generation exited with code ${code ?? 'unknown'}.`))
		})
	})
}

function writePrefixedLines(chunk: Buffer, isError: boolean): void {
	const text = chunk.toString('utf-8')
	const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
	const stream = isError ? process.stderr : process.stdout

	for (const line of lines) {
		stream.write(`[kora] ${line}\n`)
	}
}

function toError(error: unknown): Error {
	if (error instanceof Error) return error
	return new Error(String(error))
}
