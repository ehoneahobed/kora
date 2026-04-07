import { spawn } from 'node:child_process'
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
	return { outDir: options.outDir }
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
