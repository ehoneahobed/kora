import { spawn as spawnChild } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

export interface ManagedProcessConfig {
	label: string
	command: string
	args: string[]
	cwd: string
	env?: Record<string, string>
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
}

interface RunningProcess {
	child: ChildProcess
	exitPromise: Promise<void>
	stdoutBuffer: string
	stderrBuffer: string
}

/**
 * Manages long-running child processes for the dev command.
 */
export class ProcessManager {
	private readonly processes = new Map<string, RunningProcess>()

	spawn(config: ManagedProcessConfig): void {
		const options: SpawnOptions = {
			cwd: config.cwd,
			env: { ...process.env, ...config.env },
			stdio: ['ignore', 'pipe', 'pipe'],
			// On Windows, .cmd shims require shell to execute
			shell: process.platform === 'win32',
		}

		const child = spawnChild(config.command, config.args, options)
		let resolveExit: (() => void) | undefined

		const runningProcess: RunningProcess = {
			child,
			exitPromise: new Promise<void>((resolve) => {
				resolveExit = resolve
			}),
			stdoutBuffer: '',
			stderrBuffer: '',
		}

		this.processes.set(config.label, runningProcess)

		child.stdout?.on('data', (chunk: Buffer) => {
			runningProcess.stdoutBuffer = this.writeChunk(
				config.label,
				runningProcess.stdoutBuffer,
				chunk,
				false,
			)
		})

		child.stderr?.on('data', (chunk: Buffer) => {
			runningProcess.stderrBuffer = this.writeChunk(
				config.label,
				runningProcess.stderrBuffer,
				chunk,
				true,
			)
		})

		child.on('exit', (code, signal) => {
			this.flushBuffer(config.label, runningProcess.stdoutBuffer, false)
			this.flushBuffer(config.label, runningProcess.stderrBuffer, true)
			this.processes.delete(config.label)
			config.onExit?.(code, signal)
			resolveExit?.()
		})
	}

	hasRunning(): boolean {
		return this.processes.size > 0
	}

	async shutdownAll(): Promise<void> {
		const running = Array.from(this.processes.values())
		if (running.length === 0) return

		for (const processEntry of running) {
			processEntry.child.kill('SIGTERM')
		}

		await Promise.race([Promise.all(running.map((entry) => entry.exitPromise)), delay(5000)])

		const remaining = Array.from(this.processes.values())
		if (remaining.length === 0) return

		for (const processEntry of remaining) {
			processEntry.child.kill('SIGKILL')
		}

		await Promise.all(remaining.map((entry) => entry.exitPromise))
	}

	private writeChunk(label: string, buffer: string, chunk: Buffer, isError: boolean): string {
		const combined = `${buffer}${chunk.toString('utf-8')}`
		const lines = combined.split(/\r?\n/)
		const remaining = lines.pop() ?? ''

		for (const line of lines) {
			this.writeLine(label, line, isError)
		}

		return remaining
	}

	private flushBuffer(label: string, buffer: string, isError: boolean): void {
		if (!buffer) return
		this.writeLine(label, buffer, isError)
	}

	private writeLine(label: string, line: string, isError: boolean): void {
		const stream = isError ? process.stderr : process.stdout
		stream.write(`[${label}] ${line}\n`)
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms)
	})
}
