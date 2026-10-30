import { join } from 'node:path'
import { type AuditFs, nodeAuditFs } from './audit-fs'
import type { DoctorCheckResult } from './doctor-checks'

/** Stable ids of the deployed-server probe (`kora doctor --production --url`). */
export const PRODUCTION_SERVER_HEALTH_ID = 'production-server-health'
export const PRODUCTION_SERVER_PROTOCOL_ID = 'production-server-protocol'
export const PRODUCTION_SERVER_AUTH_ID = 'production-server-auth'

/** The probe gives up on one request after this long. */
export const PROBE_TIMEOUT_MS = 5_000

/** Sync protocol the app's client speaks, by Kora release (see docs/guide/sync-protocol.md). */
export const CURRENT_SYNC_PROTOCOL = 2

/** The seams of the probe: the network, the timeout and the project's files. */
export interface ProbeDeps {
	fetch: typeof fetch
	/** A signal that aborts after `ms` milliseconds (tests pass an aborted one). */
	timeoutSignal(ms: number): AbortSignal
	fs: AuditFs
}

/** The real network, clock and file system. */
export const defaultProbeDeps: ProbeDeps = {
	fetch: (input, init) => fetch(input, init),
	timeoutSignal: (ms) => AbortSignal.timeout(ms),
	fs: nodeAuditFs,
}

interface Semver {
	major: number
	minor: number
	patch: number
	prerelease: string | null
}

function parseSemver(version: string): Semver | null {
	const match = version
		.trim()
		.replace(/^[\^~=v]/, '')
		.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
	if (!match) return null
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ?? null,
	}
}

/**
 * The sync protocol a Kora release speaks: 1 up to 1.0.0-beta.12, 2 from 1.0.0-beta.13.
 * Null for a version this cannot place (a canary build, an unparsable string).
 */
export function protocolOfVersion(version: string): number | null {
	const parsed = parseSemver(version)
	if (!parsed) return null
	const { major, minor, patch, prerelease } = parsed
	// A snapshot build (`0.0.0-canary-<datetime>`, from main) has no release line to place it on:
	// without this guard its major 0 reads as the 0.x releases, which speak protocol 1, and a
	// canary client would never be told it cannot sync with a beta.12 server.
	if (prerelease?.startsWith('canary')) return null
	if (major === 0) return 1
	if (major > 1 || minor > 0 || patch > 0) return 2
	if (prerelease === null) return 2
	const beta = prerelease.match(/^beta\.(\d+)$/)
	if (beta) return Number(beta[1]) >= 13 ? 2 : 1
	return null
}

/** Normalize `--url`: a ws(s) sync URL becomes its http(s) origin; credentials are dropped. */
export function probeBaseUrl(raw: string): { base: string; hadCredentials: boolean } | null {
	try {
		const url = new URL(raw)
		if (url.protocol === 'ws:') url.protocol = 'http:'
		else if (url.protocol === 'wss:') url.protocol = 'https:'
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
		const hadCredentials = url.username !== '' || url.password !== ''
		url.username = ''
		url.password = ''
		url.pathname = ''
		url.search = ''
		url.hash = ''
		return { base: url.toString().replace(/\/$/, ''), hadCredentials }
	} catch {
		return null
	}
}

async function installedVersion(
	projectRoot: string,
	name: string,
	fs: AuditFs,
): Promise<string | null> {
	const installed = await fs.readText(
		join(projectRoot, 'node_modules', ...name.split('/'), 'package.json'),
	)
	if (installed !== null) {
		try {
			const version = (JSON.parse(installed) as { version?: unknown }).version
			if (typeof version === 'string') return version
		} catch {
			// fall through to the declared range
		}
	}
	const manifest = await fs.readText(join(projectRoot, 'package.json'))
	if (manifest === null) return null
	try {
		const parsed = JSON.parse(manifest) as {
			dependencies?: Record<string, string>
			devDependencies?: Record<string, string>
		}
		const range = parsed.dependencies?.[name] ?? parsed.devDependencies?.[name]
		return range && parseSemver(range) ? range.replace(/^[\^~=v]/, '') : null
	} catch {
		return null
	}
}

interface Fetched {
	response: Response | null
	error: string | null
	timedOut: boolean
}

async function get(url: string, deps: ProbeDeps): Promise<Fetched> {
	try {
		// No credentials of any kind: no Authorization header, no cookies.
		const response = await deps.fetch(url, {
			method: 'GET',
			headers: { accept: 'application/json' },
			credentials: 'omit',
			signal: deps.timeoutSignal(PROBE_TIMEOUT_MS),
		})
		return { response, error: null, timedOut: false }
	} catch (error) {
		const name = error instanceof Error ? error.name : ''
		return {
			response: null,
			error: error instanceof Error ? error.message : String(error),
			timedOut: name === 'TimeoutError' || name === 'AbortError',
		}
	}
}

function skipped(id: string, title: string, why: string): DoctorCheckResult {
	return { id, title, status: 'skip', message: `Skipped: ${why}` }
}

/**
 * Probe a deployed Kora server over HTTP without credentials: `GET /health` for liveness and
 * version, then the release's sync protocol against what this app's client speaks, then
 * whether the operational endpoints answer anonymous requests. Every request has a 5 s
 * timeout. A network failure or timeout is a warning, never an error, so the audit stays
 * usable offline and from CI runners that cannot reach the server.
 *
 * Handshake authentication happens inside the sync protocol, which a credential-free HTTP
 * request cannot exercise; it is read from `/health` when the server reports `authRequired`.
 *
 * @param projectRoot - The app, for the versions it installed
 * @param url - The deployed server's HTTP(S) or WS(S) base URL
 * @param deps - Network, timeout and file seams (tests)
 */
export async function probeDeployedServer(
	projectRoot: string,
	url: string,
	deps: ProbeDeps = defaultProbeDeps,
): Promise<DoctorCheckResult[]> {
	const healthTitle = 'Deployed server'
	const protocolTitle = 'Deployed server protocol'
	const authTitle = 'Deployed server access'
	const target = probeBaseUrl(url)
	if (!target) {
		return [
			{
				id: PRODUCTION_SERVER_HEALTH_ID,
				title: healthTitle,
				status: 'warn',
				message: `--url "${url}" is not an http(s) or ws(s) URL, so the deployed server was not probed.`,
				fix: 'Pass the server origin, for example --url https://sync.example.com.',
			},
		]
	}
	const notices = target.hadCredentials ? ' The credentials in the URL were not sent.' : ''
	const healthUrl = `${target.base}/health`
	const health = await get(healthUrl, deps)
	if (health.response === null) {
		return [
			{
				id: PRODUCTION_SERVER_HEALTH_ID,
				title: healthTitle,
				status: 'warn',
				message: health.timedOut
					? `GET ${healthUrl} did not answer within ${PROBE_TIMEOUT_MS / 1000} s.${notices}`
					: `Could not reach ${healthUrl}: ${health.error ?? 'unknown error'}.${notices}`,
				fix: 'Check the URL and your network. A server that cannot be reached from here may still be healthy; this is a warning, not an error.',
			},
			skipped(PRODUCTION_SERVER_PROTOCOL_ID, protocolTitle, 'the server did not answer.'),
			skipped(PRODUCTION_SERVER_AUTH_ID, authTitle, 'the server did not answer.'),
		]
	}
	const { response } = health
	if (!response.ok) {
		return [
			{
				id: PRODUCTION_SERVER_HEALTH_ID,
				title: healthTitle,
				status: response.status >= 500 ? 'fail' : 'warn',
				message:
					response.status >= 500
						? `GET ${healthUrl} returned ${response.status}: the server is up but unhealthy.${notices}`
						: `GET ${healthUrl} returned ${response.status}: this URL does not look like a Kora server (a CDN, a static host or a proxy path).${notices}`,
				fix: 'Point --url at the origin that runs createProductionServer or kora deploy.',
			},
			skipped(PRODUCTION_SERVER_PROTOCOL_ID, protocolTitle, `/health answered ${response.status}.`),
			skipped(PRODUCTION_SERVER_AUTH_ID, authTitle, `/health answered ${response.status}.`),
		]
	}
	let body: Record<string, unknown> = {}
	try {
		const parsed: unknown = await response.json()
		if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
	} catch {
		// reported below
	}
	const version = typeof body.version === 'string' ? body.version : null
	if (body.status !== 'ok') {
		return [
			{
				id: PRODUCTION_SERVER_HEALTH_ID,
				title: healthTitle,
				status: 'warn',
				message: `GET ${healthUrl} answered ${response.status} but not with a Kora health document ({"status":"ok",...}).${notices}`,
				fix: 'Point --url at the Kora server, not at a proxy or static host in front of it.',
			},
			skipped(PRODUCTION_SERVER_PROTOCOL_ID, protocolTitle, 'no Kora health document.'),
			skipped(PRODUCTION_SERVER_AUTH_ID, authTitle, 'no Kora health document.'),
		]
	}
	const results: DoctorCheckResult[] = [
		{
			id: PRODUCTION_SERVER_HEALTH_ID,
			title: healthTitle,
			status: 'pass',
			message: `${healthUrl} is healthy${version ? ` (server v${version})` : ''}.${notices}`,
		},
	]

	// Protocol and release line against what this app installed.
	const appServer = await installedVersion(projectRoot, '@korajs/server', deps.fs)
	const appClient =
		(await installedVersion(projectRoot, '@korajs/sync', deps.fs)) ??
		(await installedVersion(projectRoot, 'korajs', deps.fs))
	const serverProtocol =
		typeof body.protocolVersion === 'number' &&
		Number.isInteger(body.protocolVersion) &&
		body.protocolVersion >= 1
			? body.protocolVersion
			: version
				? protocolOfVersion(version)
				: null
	const clientProtocol = appClient ? protocolOfVersion(appClient) : null
	if (serverProtocol === null) {
		results.push({
			id: PRODUCTION_SERVER_PROTOCOL_ID,
			title: protocolTitle,
			status: 'skip',
			message: 'The server reports no version this audit can map to a sync protocol.',
		})
	} else if (clientProtocol !== null && serverProtocol < clientProtocol) {
		results.push({
			id: PRODUCTION_SERVER_PROTOCOL_ID,
			title: protocolTitle,
			status: 'warn',
			message: `The deployed server (v${version ?? '?'}) speaks sync protocol ${serverProtocol}, but this app's client (v${appClient}) speaks protocol ${clientProtocol}. Protocol-2 clients cannot sync with a protocol-1 server.`,
			fix: 'Upgrade the deployed server to the same Kora release as the app (`kora upgrade`, then redeploy).',
		})
	} else if (version && appServer && version.replace(/^v/, '') !== appServer) {
		results.push({
			id: PRODUCTION_SERVER_PROTOCOL_ID,
			title: protocolTitle,
			status: 'warn',
			message: `The deployed server is v${version} (sync protocol ${serverProtocol}); this app installs @korajs/server v${appServer}. They speak the same protocol${clientProtocol === serverProtocol ? '' : ' only if the release lines match'}, but the builds differ.`,
			fix: 'Redeploy the server from this app so server and client run one release.',
		})
	} else {
		results.push({
			id: PRODUCTION_SERVER_PROTOCOL_ID,
			title: protocolTitle,
			status: 'pass',
			message: `Server v${version ?? '?'} speaks sync protocol ${serverProtocol}${clientProtocol === null ? '' : `, as this app's client does`}.`,
		})
	}

	// Access: handshake auth when the server reports it, operational endpoints anonymously.
	const status = await get(`${target.base}/__kora/status`, deps)
	const statusOpen = status.response?.status === 200
	const problems: string[] = []
	const facts: string[] = []
	if (typeof body.authRequired === 'boolean') {
		if (body.authRequired) facts.push('the sync handshake requires authentication')
		else
			problems.push(
				'the sync handshake accepts unauthenticated devices (no AuthProvider): anyone who finds the URL can read and write the scopes it grants',
			)
	} else {
		facts.push(
			'handshake authentication is not reported by this server (verify it with a real connection)',
		)
	}
	if (statusOpen) {
		problems.push(
			'GET /__kora/status answered 200 with no credentials: the operational endpoints are public',
		)
	} else if (status.response) {
		facts.push(`/__kora/status answered ${status.response.status} without credentials`)
	}
	results.push({
		id: PRODUCTION_SERVER_AUTH_ID,
		title: authTitle,
		status: problems.length > 0 ? 'warn' : 'pass',
		message:
			problems.length > 0
				? `${problems.join('; ')}${facts.length > 0 ? ` (${facts.join('; ')})` : ''}.`
				: `${facts.join('; ')}.`,
		...(problems.length > 0
			? {
					fix: 'Pass an AuthProvider to the server and set operationalAuth tokens (adminToken, metricsToken) so /__kora/* needs a bearer token.',
				}
			: {}),
	})
	return results
}
