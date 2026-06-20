import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { SchemaDefinition } from '@korajs/core'
import { findSchemaFile } from '../../utils/fs-helpers'
import { loadKoraConfig } from '../dev/kora-config'
import { loadSchemaDefinition } from '../migrate/schema-loader'

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface DoctorCheckResult {
	id: string
	title: string
	status: DoctorCheckStatus
	message: string
	fix?: string
}

export interface DoctorRunOptions {
	projectRoot: string
	/** HTTP base URL for sync status probe (e.g. http://localhost:3001) */
	syncHttpUrl?: string
	/** Skip network checks */
	skipNetwork?: boolean
}

const STATUS_ENDPOINT = '/__kora/status'

/**
 * Run all static and optional network diagnostics for a Kora project.
 */
export async function runDoctorChecks(options: DoctorRunOptions): Promise<DoctorCheckResult[]> {
	const { projectRoot } = options
	const results: DoctorCheckResult[] = []

	results.push({
		id: 'project-root',
		title: 'Project root',
		status: 'pass',
		message: projectRoot,
	})

	const config = await loadKoraConfig(projectRoot)
	if (!config) {
		results.push({
			id: 'kora-config',
			title: 'kora.config',
			status: 'warn',
			message: 'No kora.config.* file found.',
			fix: 'Add kora.config.ts with schema path and dev settings (see create-kora-app templates).',
		})
	} else {
		results.push({
			id: 'kora-config',
			title: 'kora.config',
			status: 'pass',
			message: 'Configuration file loaded.',
		})
	}

	const schemaPath = await resolveSchemaPath(projectRoot, config?.schema)
	if (!schemaPath) {
		results.push({
			id: 'schema',
			title: 'Schema',
			status: 'fail',
			message: 'Could not find schema.ts in src/ or project root.',
			fix: 'Add src/schema.ts or set schema in kora.config.ts.',
		})
	} else {
		try {
			const schema = await loadSchemaDefinition(schemaPath, projectRoot)
			results.push({
				id: 'schema',
				title: 'Schema',
				status: 'pass',
				message: `Loaded schema v${schema.version} (${Object.keys(schema.collections).length} collection(s)).`,
			})

			const workerCheck = await checkWorkerFile(projectRoot)
			results.push(workerCheck)

			const depsCheck = await checkDependencies(projectRoot)
			results.push(depsCheck)

			results.push(opfsBrowserNote())

			if (!options.skipNetwork) {
				const syncUrl = options.syncHttpUrl ?? (await resolveSyncHttpUrl(projectRoot, config))
				const syncChecks = await checkSyncServer(syncUrl, schema)
				results.push(...syncChecks)
			} else {
				results.push({
					id: 'sync-server',
					title: 'Sync server',
					status: 'skip',
					message: 'Network checks skipped.',
				})
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			results.push({
				id: 'schema',
				title: 'Schema',
				status: 'fail',
				message: `Failed to load schema: ${message}`,
				fix: 'Ensure the schema exports defineSchema() as default and TypeScript can be evaluated (install tsx).',
			})
		}
	}

	return results
}

async function resolveSchemaPath(
	projectRoot: string,
	configSchema?: string,
): Promise<string | null> {
	if (typeof configSchema === 'string') {
		const resolved = resolve(projectRoot, configSchema)
		try {
			await access(resolved)
			return resolved
		} catch {
			// fall through to search
		}
	}
	return findSchemaFile(projectRoot)
}

async function checkWorkerFile(projectRoot: string): Promise<DoctorCheckResult> {
	const candidates = [
		join(projectRoot, 'src', 'kora-worker.ts'),
		join(projectRoot, 'src', 'kora-worker.js'),
	]

	for (const path of candidates) {
		try {
			await access(path)
			return {
				id: 'worker',
				title: 'SQLite WASM worker',
				status: 'pass',
				message: `Found ${path.replace(projectRoot, '.')}.`,
			}
		} catch {
			// try next
		}
	}

	return {
		id: 'worker',
		title: 'SQLite WASM worker',
		status: 'warn',
		message: 'No src/kora-worker.ts found.',
		fix: 'Add kora-worker.ts and pass store.workerUrl from Vite (?worker&url) in createApp().',
	}
}

async function checkDependencies(projectRoot: string): Promise<DoctorCheckResult> {
	try {
		const raw = await readFile(join(projectRoot, 'package.json'), 'utf-8')
		const pkg = JSON.parse(raw) as {
			dependencies?: Record<string, string>
			devDependencies?: Record<string, string>
		}
		const deps = { ...pkg.dependencies, ...pkg.devDependencies }
		const hasKora = Boolean(deps.korajs || deps.kora)
		const hasStore = Boolean(deps['@korajs/store'])
		if (hasKora || hasStore) {
			return {
				id: 'dependencies',
				title: 'Dependencies',
				status: 'pass',
				message: hasKora
					? 'korajs is listed in package.json.'
					: '@korajs/store is listed in package.json.',
			}
		}
		return {
			id: 'dependencies',
			title: 'Dependencies',
			status: 'fail',
			message: 'No korajs or @korajs/store dependency found.',
			fix: 'Run pnpm add korajs @korajs/react (or your package manager equivalent).',
		}
	} catch {
		return {
			id: 'dependencies',
			title: 'Dependencies',
			status: 'fail',
			message: 'Could not read package.json.',
			fix: 'Run this command from a Kora app directory with a valid package.json.',
		}
	}
}

function opfsBrowserNote(): DoctorCheckResult {
	return {
		id: 'opfs',
		title: 'OPFS persistence',
		status: 'skip',
		message:
			'OPFS availability is checked in the browser at runtime. Open the app and confirm no IndexedDB fallback warning in the console.',
		fix: 'Use a Chromium-based browser with storage access; avoid private mode if persistence fails.',
	}
}

async function resolveSyncHttpUrl(
	projectRoot: string,
	config: Awaited<ReturnType<typeof loadKoraConfig>>,
): Promise<string> {
	const envUrl = await readEnvSyncUrl(projectRoot)
	if (envUrl) {
		return toSyncStatusHttpBase(envUrl)
	}

	const syncPort =
		typeof config?.dev?.sync === 'object' && typeof config.dev.sync.port === 'number'
			? config.dev.sync.port
			: 3001

	return `http://localhost:${syncPort}`
}

async function readEnvSyncUrl(projectRoot: string): Promise<string | null> {
	for (const file of ['.env', '.env.local']) {
		const path = join(projectRoot, file)
		try {
			const content = await readFile(path, 'utf-8')
			for (const line of content.split('\n')) {
				const trimmed = line.trim()
				if (!trimmed || trimmed.startsWith('#')) continue
				const match = trimmed.match(/^VITE_SYNC_URL=(.+)$/)
				if (match?.[1]) {
					return match[1].trim().replace(/^["']|["']$/g, '')
				}
			}
		} catch {
			// continue
		}
	}
	return null
}

/** Converts a WebSocket sync URL to an HTTP base for {@link STATUS_ENDPOINT}. */
export function toSyncStatusHttpBase(url: string): string {
	try {
		const parsed = new URL(url)
		if (parsed.protocol === 'ws:') {
			parsed.protocol = 'http:'
		} else if (parsed.protocol === 'wss:') {
			parsed.protocol = 'https:'
		}
		parsed.pathname = ''
		parsed.search = ''
		parsed.hash = ''
		return parsed.toString().replace(/\/$/, '')
	} catch {
		return 'http://localhost:3001'
	}
}

interface ServerStatusResponse {
	schemaVersion: number
	running: boolean
	version: string
}

async function checkSyncServer(
	httpBase: string,
	schema: SchemaDefinition,
): Promise<DoctorCheckResult[]> {
	const statusUrl = `${httpBase.replace(/\/$/, '')}${STATUS_ENDPOINT}`

	try {
		const response = await fetch(statusUrl, {
			signal: AbortSignal.timeout(5000),
		})
		if (!response.ok) {
			return [
				{
					id: 'sync-server',
					title: 'Sync server',
					status: 'fail',
					message: `GET ${statusUrl} returned ${response.status}.`,
					fix: 'Start the sync server with `kora dev` or `pnpm run dev` in a sync template.',
				},
			]
		}

		const body = (await response.json()) as ServerStatusResponse
		const results: DoctorCheckResult[] = [
			{
				id: 'sync-server',
				title: 'Sync server',
				status: 'pass',
				message: `Reachable at ${statusUrl} (server v${body.version ?? 'unknown'}).`,
			},
		]

		if (typeof body.schemaVersion === 'number' && body.schemaVersion !== schema.version) {
			results.push({
				id: 'schema-version',
				title: 'Schema version',
				status: 'warn',
				message: `Client schema v${schema.version} differs from server schema v${body.schemaVersion}.`,
				fix: 'Run migrations on the server and client, or align schema.version before syncing.',
			})
		} else {
			results.push({
				id: 'schema-version',
				title: 'Schema version',
				status: 'pass',
				message: `Client and server both use schema v${schema.version}.`,
			})
		}

		return results
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		return [
			{
				id: 'sync-server',
				title: 'Sync server',
				status: 'warn',
				message: `Could not reach ${statusUrl}: ${detail}`,
				fix: 'Start the sync server, or pass --skip-network for local-only checks.',
			},
		]
	}
}

/**
 * True when any check failed (doctor should exit non-zero).
 */
export function doctorHasFailures(results: DoctorCheckResult[]): boolean {
	return results.some((r) => r.status === 'fail')
}
