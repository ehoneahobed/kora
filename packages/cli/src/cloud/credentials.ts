import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Kora Cloud's API, unless KORA_CLOUD_API_URL points elsewhere (a staging or self-run control plane). */
export const DEFAULT_KORA_CLOUD_API_URL = 'https://api.koracloud.app'

export interface KoraCloudCredentials {
	apiUrl: string
	token: string
	email: string | null
}

/**
 * Where `kora login` keeps its sign-in: `$XDG_CONFIG_HOME/kora/cloud.json`, else
 * `~/.config/kora/cloud.json`. Readable by the user only.
 */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
	const base =
		env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
			? env.XDG_CONFIG_HOME
			: join(homedir(), '.config')
	return join(base, 'kora', 'cloud.json')
}

export function resolveApiUrl(env: NodeJS.ProcessEnv = process.env): string {
	const value = env.KORA_CLOUD_API_URL?.trim()
	return (value && value.length > 0 ? value : DEFAULT_KORA_CLOUD_API_URL).replace(/\/+$/, '')
}

/**
 * The sign-in to use. KORA_CLOUD_TOKEN wins, so CI never needs a file; otherwise the one
 * `kora login` saved, if it was made against the same API.
 */
export async function readCredentials(
	env: NodeJS.ProcessEnv = process.env,
): Promise<KoraCloudCredentials | null> {
	const apiUrl = resolveApiUrl(env)
	const fromEnv = env.KORA_CLOUD_TOKEN?.trim()
	if (fromEnv) return { apiUrl, token: fromEnv, email: null }
	let parsed: unknown
	try {
		parsed = JSON.parse(await readFile(credentialsPath(env), 'utf8'))
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const record = parsed as Record<string, unknown>
	if (
		typeof record.token !== 'string' ||
		typeof record.apiUrl !== 'string' ||
		record.apiUrl !== apiUrl
	)
		return null
	return {
		apiUrl,
		token: record.token,
		email: typeof record.email === 'string' ? record.email : null,
	}
}

export async function writeCredentials(
	credentials: KoraCloudCredentials,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const path = credentialsPath(env)
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
	// An existing file keeps its mode on write, so it is narrowed explicitly.
	await chmod(path, 0o600)
	return path
}

export async function deleteCredentials(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	await rm(credentialsPath(env), { force: true })
}
