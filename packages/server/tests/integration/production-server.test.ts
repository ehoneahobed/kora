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
})
