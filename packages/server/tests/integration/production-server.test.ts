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
})
