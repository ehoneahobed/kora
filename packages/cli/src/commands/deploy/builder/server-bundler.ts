import { mkdir } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'

/**
 * Options used to produce a deployable server bundle artifact.
 */
export interface ServerBundleOptions {
	projectRoot: string
	deployDirectory: string
	entryFileCandidates?: readonly string[]
}

/**
 * Result details for the generated server bundle artifact.
 */
export interface ServerBundleResult {
	entryFilePath: string
	outputFilePath: string
}

const DEFAULT_ENTRY_CANDIDATES = [
	'server.ts',
	'server.js',
	'src/server.ts',
	'src/server.js',
] as const
/**
 * Bundles the server entry into a single deployable JavaScript file.
 */
export async function bundleServer(options: ServerBundleOptions): Promise<ServerBundleResult> {
	const candidates = options.entryFileCandidates ?? DEFAULT_ENTRY_CANDIDATES
	const entryFilePath = await resolveServerEntry(options.projectRoot, candidates)
	if (!entryFilePath) {
		throw new Error(
			`Could not find a server entry file in ${options.projectRoot}. Looked for: ${candidates.join(', ')}`,
		)
	}

	await mkdir(options.deployDirectory, { recursive: true })
	const outputFilePath = join(options.deployDirectory, 'server-bundled.js')

	await build({
		entryPoints: [entryFilePath],
		outfile: outputFilePath,
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: ['node20'],
		sourcemap: false,
		logLevel: 'silent',
	})

	return {
		entryFilePath,
		outputFilePath,
	}
}

async function resolveServerEntry(
	projectRoot: string,
	candidates: readonly string[],
): Promise<string | null> {
	for (const candidate of candidates) {
		const fullPath = join(projectRoot, candidate)
		try {
			await access(fullPath)
			return fullPath
		} catch {
			// continue scanning candidates
		}
	}

	return null
}
