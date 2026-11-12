import { JsonMessageSerializer } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WebSocket } from 'ws'
import { createSqliteServerStore } from '../store/sqlite-server-store'
import { type ProductionServer, createProductionServer } from './production-server'

const serializer = new JsonMessageSerializer()
let running: ProductionServer | null = null

async function start(
	config: Partial<Parameters<typeof createProductionServer>[0]> = {},
): Promise<string> {
	const store = createSqliteServerStore({ filename: ':memory:' })
	running = createProductionServer({
		store,
		port: 0,
		staticDir: '/nonexistent',
		operationalAuth: {
			metricsToken: 'metrics',
			adminToken: 'admin',
			backupToken: 'backup',
			insightsToken: 'insights',
		},
		...config,
	})
	return running.start()
}

const get = (base: string, path: string, token?: string): Promise<Response> =>
	fetch(`${base}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {})

afterEach(async () => {
	await running?.stop()
	running = null
	vi.unstubAllEnvs()
})

describe('/__kora/insights', () => {
	test('routes report counts under http, reduced to numbers; file delivery is counted', async () => {
		const base = await start({
			httpRoutes: [
				{
					path: '/auth',
					handle: async () => ({ status: 200, body: {} }),
					insights: {
						key: 'auth',
						read: () => ({
							since: 1,
							lastHour: {
								signIns: {
									succeeded: 3,
									failed: 1,
									byCode: { INVALID_CREDENTIALS: 1, 'not a key!': 4 },
								},
							},
							email: 'person@example.com',
							negative: -5,
							deep: { a: { b: { c: { d: 1 } } } },
						}),
					},
				},
				{
					path: '/broken',
					handle: async () => ({ status: 200, body: {} }),
					insights: {
						key: 'broken',
						read: () => {
							throw new Error('boom')
						},
					},
				},
			],
		})
		const insights = (await (await get(base, '/__kora/insights', 'insights')).json()) as {
			http: Record<string, unknown>
			files: unknown
		}
		expect(insights.http.auth).toEqual({
			since: 1,
			lastHour: { signIns: { succeeded: 3, failed: 1, byCode: { INVALID_CREDENTIALS: 1 } } },
			deep: { a: { b: {} } },
		})
		expect(insights.http.broken).toBeUndefined()
		expect(JSON.stringify(insights)).not.toContain('person@example.com')
		expect(insights.files).toEqual({
			served: 0,
			servedFromStore: 0,
			servedByPeer: 0,
			notHeld: 0,
			throttled: 0,
			storeReadErrors: 0,
			badPeerAnswers: 0,
		})
	})

	test('needs a token, and accepts the insights or metrics one', async () => {
		const base = await start()
		expect((await get(base, '/__kora/insights')).status).toBe(401)
		expect((await get(base, '/__kora/insights', 'wrong')).status).toBe(401)
		expect((await get(base, '/__kora/insights', 'insights')).status).toBe(200)
		expect((await get(base, '/__kora/insights', 'metrics')).status).toBe(200)
	})

	test('the insights token opens nothing else', async () => {
		const base = await start()
		for (const path of ['/__kora/metrics', '/__kora/status', '/__kora']) {
			expect((await get(base, path, 'insights')).status, path).toBe(401)
		}
		const backup = await fetch(`${base}/__kora/backup/export`, {
			method: 'POST',
			headers: { authorization: 'Bearer insights' },
		})
		expect(backup.status).toBe(401)
	})

	test('a host can provide the token through the environment', async () => {
		vi.stubEnv('KORA_INSIGHTS_TOKEN', 'from-host')
		const base = await start({
			operationalAuth: { metricsToken: 'metrics', adminToken: 'admin', backupToken: 'backup' },
		})
		expect((await get(base, '/__kora/insights', 'from-host')).status).toBe(200)
	})

	test('reports aggregates and stored-file totals, and is never cached', async () => {
		const base = await start({ blobStats: async () => ({ count: 3, bytes: 900 }) })
		const response = await get(base, '/__kora/insights', 'insights')
		expect(response.headers.get('cache-control')).toBe('no-store')
		const body = (await response.json()) as {
			version: number
			server: { connectedDevices: number }
			stored: { devices: { known: number } }
			blobs: unknown
		}
		expect(body.version).toBe(1)
		expect(body.server.connectedDevices).toBe(0)
		expect(body.stored.devices.known).toBe(0)
		expect(body.blobs).toEqual({ count: 3, bytes: 900 })
	})
})

describe('device activity', () => {
	test('a device that connects is counted, under a label rather than its id', async () => {
		const store = createSqliteServerStore({ filename: ':memory:' })
		running = createProductionServer({
			store,
			port: 0,
			staticDir: '/nonexistent',
			operationalAuth: {
				insightsToken: 'insights',
				adminToken: 'a',
				metricsToken: 'm',
				backupToken: 'b',
			},
		})
		const base = await running.start()
		const ws = new WebSocket(`${base.replace('http', 'ws')}/kora-sync`)
		const shaken = new Promise<void>((resolve) => ws.once('message', () => resolve()))
		await new Promise<void>((resolve) => ws.once('open', () => resolve()))
		ws.send(
			serializer.encode({
				type: 'handshake',
				messageId: 'hs-1',
				nodeId: 'real-device-id',
				versionVector: {},
				schemaVersion: 1,
				protocolVersion: 2,
				supportedWireFormats: ['json'],
			} as never),
		)
		await shaken
		await vi.waitFor(async () =>
			expect((await store.getStoreInsights(Date.now())).devices.known).toBe(1),
		)
		ws.close()
		expect(JSON.stringify(await store.getStoreInsights(Date.now()))).not.toContain('real-device-id')
	})

	test('a failing activity record cannot disturb a connection', async () => {
		const store = createSqliteServerStore({ filename: ':memory:' })
		store.recordDeviceActivity = async () => {
			throw new Error('storage unavailable')
		}
		running = createProductionServer({ store, port: 0, staticDir: '/nonexistent' })
		const base = await running.start()
		const ws = new WebSocket(`${base.replace('http', 'ws')}/kora-sync`)
		const reply = new Promise<string>((resolve) =>
			ws.once('message', (data) => resolve(String(data))),
		)
		await new Promise<void>((resolve) => ws.once('open', () => resolve()))
		ws.send(
			serializer.encode({
				type: 'handshake',
				messageId: 'hs-2',
				nodeId: 'device-2',
				versionVector: {},
				schemaVersion: 1,
				protocolVersion: 2,
				supportedWireFormats: ['json'],
			} as never),
		)
		expect(await reply).toContain('handshake-response')
		ws.close()
	})
})
