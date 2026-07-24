import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineCommand } from 'citty'
import { findProjectRoot } from '../../utils/fs-helpers'
import { createLogger } from '../../utils/logger'
import {
	type AgentsFramework,
	detectFrameworkFromManifest,
	generateAgentsMd,
	isAgentsFramework,
} from './agents-md-content'

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

async function readManifest(root: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(join(root, 'package.json'), 'utf-8'))
	} catch {
		return null
	}
}

/**
 * Resolves the framework to document: an explicit override wins, otherwise it is
 * detected from the project manifest, otherwise it falls back to React.
 */
function resolveFramework(override: string | undefined, manifest: unknown): AgentsFramework {
	if (override !== undefined && isAgentsFramework(override)) return override
	return detectFrameworkFromManifest(manifest) ?? 'react'
}

/**
 * Writes an AGENTS.md into an existing project so AI coding agents follow Kora
 * conventions. Refuses to overwrite an existing file unless `--force` is passed.
 */
export const agentsCommand = defineCommand({
	meta: {
		name: 'agents-md',
		description: 'Write an AGENTS.md with Kora rules for AI coding agents into this project',
	},
	args: {
		force: {
			type: 'boolean',
			description: 'Overwrite an existing AGENTS.md',
			default: false,
		},
		framework: {
			type: 'string',
			description: 'Override framework detection (react, vue, or svelte)',
		},
	},
	async run({ args }) {
		const logger = createLogger()
		const projectRoot = (await findProjectRoot()) ?? process.cwd()
		const manifest = await readManifest(projectRoot)

		const override = typeof args.framework === 'string' ? args.framework : undefined
		if (override !== undefined && !isAgentsFramework(override)) {
			logger.error(`Unknown framework "${override}". Use one of: react, vue, svelte.`)
			process.exitCode = 1
			return
		}

		const framework = resolveFramework(override, manifest)
		const target = join(projectRoot, 'AGENTS.md')
		const force = args.force === true

		if ((await fileExists(target)) && !force) {
			logger.warn('AGENTS.md already exists. Re-run with --force to overwrite it.')
			process.exitCode = 1
			return
		}

		await writeFile(target, generateAgentsMd(framework), 'utf-8')

		logger.banner()
		logger.success(`Wrote AGENTS.md (${framework} bindings) to ${target}`)
		logger.step('Commit it so coding agents pick up Kora conventions automatically.')
		logger.blank()
	},
})
