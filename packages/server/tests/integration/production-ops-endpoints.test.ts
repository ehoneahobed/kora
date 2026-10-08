/**
 * F5: in production, operational endpoints without a token are disabled, never public.
 * Backups expose (export) or replace (import) every user's data.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'

const ENDPOINTS: Array<[string, string]> = [
	['GET', '/__kora/status'],
	['GET', '/__kora/metrics'],
	['GET', '/__kora'],
	['POST', '/__kora/backup/export'],
	['POST', '/__kora/backup/import'],
]

afterEach(() => {
	vi.unstubAllEnvs()
})

async function statuses(
	options: Parameters<typeof createProductionServer>[0],
	token?: string,
): Promise<number[]> {
	const server = createProductionServer(options)
	const base = await server.start()
	try {
		const out: number[] = []
		for (const [method, path] of ENDPOINTS) {
			const response = await fetch(`${base}${path}`, {
				method,
				...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
				...(method === 'POST' && path.endsWith('import') ? { body: new Uint8Array([1]) } : {}),
			})
			out.push(response.status)
			await response.body?.cancel()
		}
		return out
	} finally {
		await server.stop()
	}
}

describe('F5: operational endpoints in production', () => {
	test('without tokens they are disabled (403), and /health stays public', async () => {
		vi.stubEnv('NODE_ENV', 'production')
		const server = createProductionServer({ store: new MemoryServerStore('s'), port: 0 })
		const base = await server.start()
		try {
			expect((await fetch(`${base}/health`)).status).toBe(200)
			const exported = await fetch(`${base}/__kora/backup/export`, { method: 'POST' })
			expect(exported.status).toBe(403)
			expect(await exported.json()).toMatchObject({ code: 'OPERATIONAL_ENDPOINT_DISABLED' })
		} finally {
			await server.stop()
		}
		expect(await statuses({ store: new MemoryServerStore('s'), port: 0 })).toEqual([
			403, 403, 403, 403, 403,
		])
	})

	test('a configured token enables its group only', async () => {
		vi.stubEnv('NODE_ENV', 'production')
		const options = {
			store: new MemoryServerStore('s'),
			port: 0,
			operationalAuth: { metricsToken: 'm' },
		}
		const [status, metrics, , exported] = await statuses(options, 'm')
		expect(metrics).toBe(200)
		expect(status).toBe(403)
		expect(exported).toBe(403)
	})

	test('allowPublic keeps the beta.13 behaviour on purpose', async () => {
		vi.stubEnv('NODE_ENV', 'production')
		const [status, , , exported] = await statuses({
			store: new MemoryServerStore('s'),
			port: 0,
			operationalAuth: { allowPublic: true },
		})
		expect(status).toBe(200)
		expect(exported).toBe(200)
	})

	test('outside production they stay public, as before', async () => {
		vi.stubEnv('NODE_ENV', 'development')
		const [status, , , exported] = await statuses({ store: new MemoryServerStore('s'), port: 0 })
		expect(status).toBe(200)
		expect(exported).toBe(200)
	})
})
