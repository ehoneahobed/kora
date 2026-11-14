import { describe, expect, test } from 'vitest'
import { createOriginPolicy } from '../../src/server/cross-origin'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
	const server = createProductionServer({
		store: new MemoryServerStore('server-1'),
		port: 0,
		allowedOrigins: ['https://pos.example.com'],
		httpRoutes: [
			{
				path: '/auth',
				async handle(request) {
					return { status: 200, body: { path: request.path, method: request.method } }
				},
			},
		],
	})
	const base = await server.start()
	try {
		return await run(base)
	} finally {
		await server.stop()
	}
}

function preflight(base: string, origin: string): Promise<Response> {
	return fetch(`${base}/auth/signin`, {
		method: 'OPTIONS',
		headers: {
			Origin: origin,
			'Access-Control-Request-Method': 'POST',
			'Access-Control-Request-Headers': 'content-type, authorization',
		},
	})
}

describe('createProductionServer: calls from native app shells', () => {
	test('a Tauri page may sign in: the preflight is answered and the response readable', async () => {
		await withServer(async (base) => {
			for (const origin of [
				'tauri://localhost',
				'http://tauri.localhost',
				'https://tauri.localhost',
			]) {
				const answer = await preflight(base, origin)
				expect(answer.status).toBe(204)
				expect(answer.headers.get('access-control-allow-origin')).toBe(origin)
				expect(answer.headers.get('access-control-allow-headers')).toBe(
					'content-type, authorization',
				)
				expect(answer.headers.get('access-control-allow-credentials')).toBeNull()
			}
			const signIn = await fetch(`${base}/auth/signin`, {
				method: 'POST',
				headers: { Origin: 'tauri://localhost', 'content-type': 'application/json' },
				body: '{}',
			})
			expect(signIn.status).toBe(200)
			expect(signIn.headers.get('access-control-allow-origin')).toBe('tauri://localhost')
			expect(signIn.headers.get('vary')).toContain('Origin')
			expect(await signIn.json()).toEqual({ path: '/auth/signin', method: 'POST' })
		})
	})

	test('an origin the app lists is allowed; any other website is not', async () => {
		await withServer(async (base) => {
			expect(
				(await preflight(base, 'https://pos.example.com')).headers.get(
					'access-control-allow-origin',
				),
			).toBe('https://pos.example.com')
			const foreign = await preflight(base, 'https://evil.example')
			expect(foreign.headers.get('access-control-allow-origin')).toBeNull()
			const post = await fetch(`${base}/auth/signin`, {
				method: 'POST',
				headers: { Origin: 'https://evil.example', 'content-type': 'application/json' },
				body: '{}',
			})
			expect(post.headers.get('access-control-allow-origin')).toBeNull()
		})
	})

	test('the public health check is readable from an app shell; other paths are not', async () => {
		await withServer(async (base) => {
			const health = await fetch(`${base}/health`, { headers: { Origin: 'tauri://localhost' } })
			expect(health.headers.get('access-control-allow-origin')).toBe('tauri://localhost')
			const status = await fetch(`${base}/__kora/status`, {
				headers: { Origin: 'tauri://localhost' },
			})
			expect(status.headers.get('access-control-allow-origin')).toBeNull()
		})
	})
})

describe('createOriginPolicy', () => {
	test('local development servers only outside production', () => {
		expect(
			createOriginPolicy([], { NODE_ENV: 'development' }).allows('http://localhost:5173'),
		).toBe(true)
		expect(createOriginPolicy([], { NODE_ENV: 'production' }).allows('http://localhost:5173')).toBe(
			false,
		)
		expect(createOriginPolicy([], { NODE_ENV: 'production' }).allows('tauri://localhost')).toBe(
			true,
		)
	})

	test('the host adds origins with KORA_ALLOWED_ORIGINS', () => {
		const policy = createOriginPolicy([], {
			NODE_ENV: 'production',
			KORA_ALLOWED_ORIGINS: 'https://a.example, https://B.example/',
		})
		expect(policy.allows('https://a.example')).toBe(true)
		expect(policy.allows('https://b.example')).toBe(true)
		expect(policy.allows('https://c.example')).toBe(false)
	})

	test('no origin, or an opaque one, is never allowed', () => {
		const policy = createOriginPolicy([], { NODE_ENV: 'development' })
		expect(policy.allows(undefined)).toBe(false)
		expect(policy.allows('null')).toBe(false)
	})
})
