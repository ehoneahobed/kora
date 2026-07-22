import { describe, expect, test } from 'vitest'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'

describe('createProductionServer operational auth', () => {
	test('keeps health public and protects operational endpoints when tokens are configured', async () => {
		const port = 39217
		const server = createProductionServer({
			store: new MemoryServerStore('server-1'),
			port,
			operationalAuth: {
				adminToken: 'admin-secret',
				metricsToken: 'metrics-secret',
				backupToken: 'backup-secret',
			},
		})

		await server.start()
		try {
			const baseUrl = `http://localhost:${port}`

			const health = await fetch(`${baseUrl}/health`)
			expect(health.status).toBe(200)

			const statusWithoutToken = await fetch(`${baseUrl}/__kora/status`)
			expect(statusWithoutToken.status).toBe(401)

			const statusWithToken = await fetch(`${baseUrl}/__kora/status`, {
				headers: { Authorization: 'Bearer admin-secret' },
			})
			expect(statusWithToken.status).toBe(200)

			const metricsWithAdminToken = await fetch(`${baseUrl}/__kora/metrics`, {
				headers: { Authorization: 'Bearer admin-secret' },
			})
			expect(metricsWithAdminToken.status).toBe(401)

			const metricsWithToken = await fetch(`${baseUrl}/__kora/metrics`, {
				headers: { Authorization: 'Bearer metrics-secret' },
			})
			expect(metricsWithToken.status).toBe(200)

			const backupWithToken = await fetch(`${baseUrl}/__kora/backup/export`, {
				method: 'POST',
				headers: { Authorization: 'Bearer backup-secret' },
			})
			expect(backupWithToken.status).toBe(200)
		} finally {
			await server.stop()
		}
	})

	test('mounts custom HTTP routes before static file serving', async () => {
		const port = 39218
		const server = createProductionServer({
			store: new MemoryServerStore('server-1'),
			port,
			httpRoutes: [
				{
					path: '/auth',
					async handle(request) {
						return {
							status: 200,
							body: {
								method: request.method,
								path: request.path,
								body: request.body,
								query: request.query,
								ip: request.ip,
							},
						}
					},
				},
			],
		})

		await server.start()
		try {
			const response = await fetch(`http://localhost:${port}/auth/signin?next=/dashboard`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'alice@example.com' }),
			})

			expect(response.status).toBe(200)
			const body = (await response.json()) as {
				method: string
				path: string
				body: { email: string }
				query: { next: string }
			}
			expect(body.method).toBe('POST')
			expect(body.path).toBe('/auth/signin')
			expect(body.body.email).toBe('alice@example.com')
			expect(body.query.next).toBe('/dashboard')

			const nonMatch = await fetch(`http://localhost:${port}/authentication/signin`)
			expect(nonMatch.status).toBe(404)
		} finally {
			await server.stop()
		}
	})

	// Regression: KoraForms hit a bug where a malformed request body reached
	// @korajs/auth's handleSignUp/handleSignIn as `undefined` fields, which
	// threw a TypeError inside a custom httpRoute handler. Because
	// http.createServer's request listener isn't awaited by Node, a handler
	// that throws becomes an unhandled promise rejection, which crashes the
	// entire process under Node's default `--unhandled-rejections=throw` —
	// one bad request took down the whole server, not just that response.
	// This proves the fix: any handler that throws returns a clean 500, and
	// the server keeps serving requests afterward instead of going down.
	test('a throwing httpRoutes handler returns 500 instead of crashing the server', async () => {
		const port = 39220
		const server = createProductionServer({
			store: new MemoryServerStore('server-1'),
			port,
			httpRoutes: [
				{
					path: '/echo',
					async handle(request) {
						// Simulates handleSignUp/handleSignIn crashing on a body field
						// that's missing at runtime despite its required `string` type.
						const email = (request.body as { email?: string } | undefined)?.email
						return { status: 200, body: { emailLength: (email as unknown as string).length } }
					},
				},
			],
		})

		await server.start()
		try {
			const baseUrl = `http://localhost:${port}`

			// No body at all — request.body is undefined, `.length` throws inside
			// the handler with the pre-fix code.
			const crashing = await fetch(`${baseUrl}/echo`, { method: 'POST' })
			expect(crashing.status).toBe(500)

			// The server must still be alive and serving normally afterward.
			const health = await fetch(`${baseUrl}/health`)
			expect(health.status).toBe(200)

			const stillWorks = await fetch(`${baseUrl}/echo`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'alice@example.com' }),
			})
			expect(stillWorks.status).toBe(200)
			const body = (await stillWorks.json()) as { emailLength: number }
			expect(body.emailLength).toBe('alice@example.com'.length)
		} finally {
			await server.stop()
		}
	})

	// Regression: the actual root cause of the KoraForms report. A raw
	// http.IncomingMessage starts paused; without an explicit resume() after
	// attaching 'data'/'end' listeners, the body reads back empty on some
	// Node versions/environments, so httpRoutes handlers (and @korajs/auth's
	// signup/signin built on top of them) silently never see the real body.
	test('reads the full POST body for httpRoutes handlers', async () => {
		const port = 39221
		const server = createProductionServer({
			store: new MemoryServerStore('server-1'),
			port,
			httpRoutes: [
				{
					path: '/echo',
					async handle(request) {
						return { status: 200, body: { received: request.body } }
					},
				},
			],
		})

		await server.start()
		try {
			const response = await fetch(`http://localhost:${port}/echo`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ hello: 'world' }),
			})

			expect(response.status).toBe(200)
			const body = (await response.json()) as { received: { hello: string } }
			expect(body.received).toEqual({ hello: 'world' })
		} finally {
			await server.stop()
		}
	})
})
