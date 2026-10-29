import { spawn } from 'node:child_process'
import type { PackageManager } from '../types'

/**
 * Runs a command in a directory and resolves with its exit code. Output goes to the terminal
 * (inherited stdio). Injected so tests use a fake package manager and never spawn.
 */
export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<number>

/** Default runner: spawns the command with inherited stdio. */
export const spawnCommandRunner: CommandRunner = (command, args, cwd) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: 'inherit',
			// npm/pnpm/yarn are .cmd shims on Windows and cannot be spawned directly.
			shell: process.platform === 'win32',
		})
		child.on('error', reject)
		child.on('close', (code) => resolve(code ?? 1))
	})

/** The install invocation for a package manager. */
export function installInvocation(pm: PackageManager): { command: string; args: string[] } {
	// CI environments make pnpm default to --frozen-lockfile, which would refuse the lockfile
	// change an upgrade necessarily makes.
	return { command: pm, args: pm === 'pnpm' ? ['install', '--no-frozen-lockfile'] : ['install'] }
}

/**
 * Runs the project's own `kora` binary after the upgrade, so the doctor that checks the
 * project is the upgraded CLI, not the older one that is running this command.
 */
export function koraBinInvocation(
	pm: PackageManager,
	koraArgs: string[],
): { command: string; args: string[] } {
	switch (pm) {
		case 'pnpm':
			return { command: 'pnpm', args: ['exec', 'kora', ...koraArgs] }
		case 'yarn':
			return { command: 'yarn', args: ['kora', ...koraArgs] }
		case 'bun':
			return { command: 'bun', args: ['run', 'kora', ...koraArgs] }
		default:
			return { command: 'npx', args: ['--no-install', 'kora', ...koraArgs] }
	}
}
