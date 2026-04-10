import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeployPlatform } from '../adapters/adapter'
import { isDeployPlatform } from '../adapters/adapter'

const KORA_DEPLOY_DIRECTORY = join('.kora', 'deploy')
const DEPLOY_STATE_FILENAME = 'deploy.json'

/**
 * Durable deployment settings stored for subsequent `kora deploy` runs.
 */
export interface DeployState {
	platform: DeployPlatform
	appName: string
	region: string | null
	projectRoot: string
	liveUrl: string | null
	syncUrl: string | null
	databaseId: string | null
	lastDeploymentId: string | null
	createdAt: string
	updatedAt: string
}

/**
 * Input required to create a new deployment state record.
 */
export interface DeployStateCreateInput {
	platform: DeployPlatform
	appName: string
	region: string | null
	projectRoot: string
	liveUrl?: string | null
	syncUrl?: string | null
	databaseId?: string | null
	lastDeploymentId?: string | null
}

/**
 * Partial update fields for an existing deployment state record.
 */
export interface DeployStatePatch {
	platform?: DeployPlatform
	appName?: string
	region?: string | null
	projectRoot?: string
	liveUrl?: string | null
	syncUrl?: string | null
	databaseId?: string | null
	lastDeploymentId?: string | null
}

/**
 * Returns the absolute path to `.kora/deploy`.
 */
export function resolveDeployDirectory(projectRoot: string): string {
	return join(projectRoot, KORA_DEPLOY_DIRECTORY)
}

/**
 * Returns the absolute path to `.kora/deploy/deploy.json`.
 */
export function resolveDeployStatePath(projectRoot: string): string {
	return join(resolveDeployDirectory(projectRoot), DEPLOY_STATE_FILENAME)
}

/**
 * Loads deployment state from `.kora/deploy/deploy.json`.
 * Returns null when the file does not exist.
 */
export async function readDeployState(projectRoot: string): Promise<DeployState | null> {
	const statePath = resolveDeployStatePath(projectRoot)

	try {
		const source = await readFile(statePath, 'utf-8')
		const parsed = JSON.parse(source) as unknown
		return parseDeployState(parsed)
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ENOENT') return null
		throw error
	}
}

/**
 * Writes a brand-new deployment state record, replacing any existing file.
 */
export async function writeDeployState(
	projectRoot: string,
	input: DeployStateCreateInput,
	now = new Date(),
): Promise<DeployState> {
	const timestamp = now.toISOString()
	const state: DeployState = {
		platform: input.platform,
		appName: input.appName,
		region: input.region,
		projectRoot: input.projectRoot,
		liveUrl: input.liveUrl ?? null,
		syncUrl: input.syncUrl ?? null,
		databaseId: input.databaseId ?? null,
		lastDeploymentId: input.lastDeploymentId ?? null,
		createdAt: timestamp,
		updatedAt: timestamp,
	}

	await persistDeployState(projectRoot, state)
	return state
}

/**
 * Applies a partial update to deployment state.
 * Throws when state does not exist.
 */
export async function updateDeployState(
	projectRoot: string,
	patch: DeployStatePatch,
	now = new Date(),
): Promise<DeployState> {
	const existing = await readDeployState(projectRoot)
	if (!existing) {
		throw new Error('Cannot update deploy state because deploy.json does not exist yet.')
	}

	const nextState: DeployState = {
		platform: patch.platform ?? existing.platform,
		appName: patch.appName ?? existing.appName,
		region: patch.region === undefined ? existing.region : patch.region,
		projectRoot: patch.projectRoot ?? existing.projectRoot,
		liveUrl: patch.liveUrl === undefined ? existing.liveUrl : patch.liveUrl,
		syncUrl: patch.syncUrl === undefined ? existing.syncUrl : patch.syncUrl,
		databaseId: patch.databaseId === undefined ? existing.databaseId : patch.databaseId,
		lastDeploymentId:
			patch.lastDeploymentId === undefined ? existing.lastDeploymentId : patch.lastDeploymentId,
		createdAt: existing.createdAt,
		updatedAt: now.toISOString(),
	}

	await persistDeployState(projectRoot, nextState)
	return nextState
}

/**
 * Removes the entire `.kora/deploy` directory tree.
 */
export async function resetDeployState(projectRoot: string): Promise<void> {
	await rm(resolveDeployDirectory(projectRoot), { recursive: true, force: true })
}

async function persistDeployState(projectRoot: string, state: DeployState): Promise<void> {
	const deployDir = resolveDeployDirectory(projectRoot)
	const statePath = resolveDeployStatePath(projectRoot)
	await mkdir(deployDir, { recursive: true })
	await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
}

function parseDeployState(value: unknown): DeployState {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Invalid deploy state: expected an object.')
	}

	const record = value as Record<string, unknown>

	const platform = readPlatform(record.platform)
	const appName = readString(record.appName, 'appName')
	const region = readOptionalString(record.region, 'region')
	const projectRoot = readString(record.projectRoot, 'projectRoot')
	const liveUrl = readOptionalString(record.liveUrl, 'liveUrl')
	const syncUrl = readOptionalString(record.syncUrl, 'syncUrl')
	const databaseId = readOptionalString(record.databaseId, 'databaseId')
	const lastDeploymentId = readOptionalString(record.lastDeploymentId, 'lastDeploymentId')
	const createdAt = readString(record.createdAt, 'createdAt')
	const updatedAt = readString(record.updatedAt, 'updatedAt')

	return {
		platform,
		appName,
		region,
		projectRoot,
		liveUrl,
		syncUrl,
		databaseId,
		lastDeploymentId,
		createdAt,
		updatedAt,
	}
}

function readPlatform(value: unknown): DeployPlatform {
	if (typeof value !== 'string' || !isDeployPlatform(value)) {
		throw new Error('Invalid deploy state: "platform" must be a supported platform.')
	}
	return value
}

function readString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Invalid deploy state: "${field}" must be a non-empty string.`)
	}
	return value
}

function readOptionalString(value: unknown, field: string): string | null {
	if (value === null) return null
	if (typeof value === 'string') return value
	throw new Error(`Invalid deploy state: "${field}" must be a string or null.`)
}
