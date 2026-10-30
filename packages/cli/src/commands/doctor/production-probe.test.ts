import { describe, expect, it } from 'vitest'
import type { AuditFs } from './audit-fs'
import {
	type ProbeDeps,
	probeBaseUrl,
	probeDeployedServer,
	protocolOfVersion,
} from './production-probe'

const ROOT = '/app'

function fsWith(files: Record<string, string>): AuditFs {
	return {
		async readText(path) {
			return files[path.replace(`${ROOT}/`, '')] ?? null
		},
		async walk() {
			return null
		},
	}
}

const APP_FILES = {
	'node_modules/@korajs/server/package.json': JSON.stringify({ version: '1.0.0-beta.14' }),
	'node_modules/@korajs/sync/package.json': JSON.stringify({ version: '1.0.0-beta.14' }),
}

interface Recorded {
	url: string
	init: RequestInit | undefined
}

/** A fetch that answers from a route table and records every request. */
function network(
	routes: Record<string, { status: number; body?: unknown } | Error>,
	files: Record<string, string> = APP_FILES,
): { deps: ProbeDeps; calls: Recorded[] } {
	const calls: Recorded[] = []
	const deps: ProbeDeps = {
		fetch: async (input, init) => {
			const url = String(input)
			calls.push({ url, init })
			const route = routes[new URL(url).pathname]
			if (route instanceof Error) throw route
			if (!route) return new Response('not found', { status: 404 })
			return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
				status: route.status,
				headers: { 'content-type': 'application/json' },
			})
		},
		timeoutSignal: () => new AbortController().signal,
		fs: fsWith(files),
	}
	return { deps, calls }
}

const HEALTHY = { status: 'ok', version: '1.0.0-beta.14', uptime: 5, connectedClients: 0 }

describe('protocolOfVersion', () => {
	it('maps releases to the sync protocol they speak', () => {
		expect(protocolOfVersion('1.0.0-beta.12')).toBe(1)
		expect(protocolOfVersion('1.0.0-beta.13')).toBe(2)
		expect(protocolOfVersion('1.0.0-beta.14')).toBe(2)
		expect(protocolOfVersion('1.0.0')).toBe(2)
		expect(protocolOfVersion('1.2.0')).toBe(2)
		expect(protocolOfVersion('0.6.0')).toBe(1)
		expect(protocolOfVersion('1.0.0-canary-abc')).toBeNull()
		expect(protocolOfVersion('nonsense')).toBeNull()
	})
})

describe('probeBaseUrl', () => {
	it('turns a sync URL into its http origin and drops credentials', () => {
		expect(probeBaseUrl('wss://sync.example.com/kora-sync')).toEqual({
			base: 'https://sync.example.com',
			hadCredentials: false,
		})
		expect(probeBaseUrl('https://user:pw@sync.example.com:8443/x?y=1')).toEqual({
			base: 'https://sync.example.com:8443',
			hadCredentials: true,
		})
		expect(probeBaseUrl('ftp://x')).toBeNull()
		expect(probeBaseUrl('not a url')).toBeNull()
	})
})

describe('probeDeployedServer', () => {
	it('passes a healthy, current server and sends no credentials', async () => {
		const { deps, calls } = network({
			'/health': { status: 200, body: { ...HEALTHY, authRequired: true } },
			'/__kora/status': { status: 401 },
		})
		const results = await probeDeployedServer(ROOT, 'https://sync.example.com', deps)
		expect(results.map((r) => [r.id, r.status])).toEqual([
			['production-server-health', 'pass'],
			['production-server-protocol', 'pass'],
			['production-server-auth', 'pass'],
		])
		expect(results[2]?.message).toContain('requires authentication')
		expect(calls.map((c) => c.url)).toEqual([
			'https://sync.example.com/health',
			'https://sync.example.com/__kora/status',
		])
		for (const call of calls) {
			expect(call.init?.credentials).toBe('omit')
			const headers = new Headers(call.init?.headers)
			expect(headers.has('authorization')).toBe(false)
			expect(headers.has('cookie')).toBe(false)
		}
	})

	it('does not send credentials embedded in the URL', async () => {
		const { deps, calls } = network({ '/health': { status: 200, body: HEALTHY } })
		const results = await probeDeployedServer(ROOT, 'https://me:secret@sync.example.com', deps)
		expect(calls.every((c) => !c.url.includes('secret'))).toBe(true)
		expect(results[0]?.message).toContain('credentials in the URL were not sent')
		expect(JSON.stringify(results)).not.toContain('secret')
	})

	it('warns, never fails, when the network is down', async () => {
		const { deps } = network({ '/health': new TypeError('fetch failed') })
		const results = await probeDeployedServer(ROOT, 'https://sync.example.com', deps)
		expect(results[0]).toMatchObject({ id: 'production-server-health', status: 'warn' })
		expect(results[0]?.message).toContain('fetch failed')
		expect(results.slice(1).every((r) => r.status === 'skip')).toBe(true)
	})

	it('times out cleanly as a warning', async () => {
		const { deps } = network({})
		const timeout = new DOMException('The operation timed out', 'TimeoutError')
		const results = await probeDeployedServer(ROOT, 'https://sync.example.com', {
			...deps,
			timeoutSignal: () => AbortSignal.abort(timeout),
			fetch: async (_input, init) => {
				// A real fetch rejects with the signal's reason once it has aborted.
				if (init?.signal?.aborted) throw init.signal.reason
				return new Response('{}')
			},
		})
		expect(results[0]?.status).toBe('warn')
		expect(results[0]?.message).toContain('did not answer within 5 s')
	})

	it('fails on a 5xx health answer, warns on a 404 (not a Kora server)', async () => {
		const down = await probeDeployedServer(
			ROOT,
			'https://sync.example.com',
			network({ '/health': { status: 503 } }).deps,
		)
		expect(down[0]?.status).toBe('fail')
		const cdn = await probeDeployedServer(ROOT, 'https://sync.example.com', network({}).deps)
		expect(cdn[0]?.status).toBe('warn')
		expect(cdn[0]?.message).toContain('does not look like a Kora server')
	})

	it('warns when the server body is not a Kora health document', async () => {
		const results = await probeDeployedServer(
			ROOT,
			'https://sync.example.com',
			network({ '/health': { status: 200, body: { hello: 'world' } } }).deps,
		)
		expect(results[0]?.status).toBe('warn')
		expect(results[0]?.message).toContain('not with a Kora health document')
	})

	it('warns when the deployed server speaks an older sync protocol than the app', async () => {
		const results = await probeDeployedServer(
			ROOT,
			'https://sync.example.com',
			network({ '/health': { status: 200, body: { ...HEALTHY, version: '1.0.0-beta.12' } } }).deps,
		)
		const protocol = results.find((r) => r.id === 'production-server-protocol')
		expect(protocol?.status).toBe('warn')
		expect(protocol?.message).toContain('speaks sync protocol 1')
		expect(protocol?.message).toContain('protocol 2')
	})

	it('warns when the build differs from the app server but the protocol matches', async () => {
		const results = await probeDeployedServer(
			ROOT,
			'https://sync.example.com',
			network({ '/health': { status: 200, body: { ...HEALTHY, version: '1.0.0-beta.13' } } }).deps,
		)
		const protocol = results.find((r) => r.id === 'production-server-protocol')
		expect(protocol?.status).toBe('warn')
		expect(protocol?.message).toContain('v1.0.0-beta.13')
		expect(protocol?.message).toContain('@korajs/server v1.0.0-beta.14')
	})

	it('prefers a protocolVersion the server reports', async () => {
		const results = await probeDeployedServer(
			ROOT,
			'https://sync.example.com',
			network({
				'/health': {
					status: 200,
					body: { ...HEALTHY, version: '9.9.9-custom', protocolVersion: 1 },
				},
			}).deps,
		)
		expect(results.find((r) => r.id === 'production-server-protocol')?.status).toBe('warn')
	})

	it('warns when the server reports that handshakes need no authentication', async () => {
		const results = await probeDeployedServer(
			ROOT,
			'https://sync.example.com',
			network({ '/health': { status: 200, body: { ...HEALTHY, authRequired: false } } }).deps,
		)
		const auth = results.find((r) => r.id === 'production-server-auth')
		expect(auth?.status).toBe('warn')
		expect(auth?.message).toContain('accepts unauthenticated devices')
	})

	it('warns when the operational endpoints answer anonymous requests', async () => {
		const results = await probeDeployedServer(
			ROOT,
			'https://sync.example.com',
			network({
				'/health': { status: 200, body: HEALTHY },
				'/__kora/status': { status: 200, body: {} },
			}).deps,
		)
		const auth = results.find((r) => r.id === 'production-server-auth')
		expect(auth?.status).toBe('warn')
		expect(auth?.message).toContain('/__kora/status answered 200 with no credentials')
		expect(auth?.fix).toContain('operationalAuth')
	})

	it('says handshake authentication is not reported when the server does not tell', async () => {
		const results = await probeDeployedServer(
			ROOT,
			'https://sync.example.com',
			network({ '/health': { status: 200, body: HEALTHY }, '/__kora/status': { status: 403 } })
				.deps,
		)
		const auth = results.find((r) => r.id === 'production-server-auth')
		expect(auth?.status).toBe('pass')
		expect(auth?.message).toContain('not reported by this server')
		expect(auth?.message).toContain('answered 403')
	})

	it('warns about a URL it cannot probe', async () => {
		const results = await probeDeployedServer(ROOT, 'ftp://nope', network({}).deps)
		expect(results).toHaveLength(1)
		expect(results[0]?.status).toBe('warn')
	})
})
