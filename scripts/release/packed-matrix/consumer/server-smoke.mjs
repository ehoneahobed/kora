/**
 * Packed Node server startup and smoke contract, on the server store named by
 * KORA_SMOKE_STORE (`sqlite` or `postgres`).
 *
 * Everything imported here is the installed tarball. The contract:
 *
 *   1. `createProductionServer` starts in NODE_ENV=production on a SQLite file or a Postgres
 *      database, with an authenticated sync endpoint.
 *   2. `/health` reports the packed version, the current protocol and that auth is required;
 *      the operational endpoints are closed without their token and open with it; the app
 *      shell is served with the isolation headers and SPA fallback.
 *   3. A client with a bad token never syncs; two devices of one user converge through the
 *      server.
 *   4. The trusted data plane (`server.kora`) applies a background write that reaches devices.
 *   5. A write made while the server is down uploads after the server restarts on the same
 *      database, and a brand new device receives everything: the data outlives the process.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	TokenAuthProvider,
	createPostgresServerStore,
	createProductionServer,
	createSqliteServerStore,
} from '@korajs/server'
import { createApp, defineSchema, t } from 'korajs'
import postgres from 'postgres'
import {
	ensureWebSocket,
	expect,
	expectEqual,
	pass,
	runScript,
	titlesOf,
	untilTitles,
} from './common.mjs'

const STORE = process.env.KORA_SMOKE_STORE
const DIR = process.env.KORA_SMOKE_DIR
const EXPECT_VERSION = process.env.KORA_EXPECT_SERVER_VERSION
const PG_URL = process.env.KORA_PG_URL

const ADMIN = 'admin-token-for-the-matrix'
const METRICS = 'metrics-token-for-the-matrix'
const USER_TOKEN = 'alice-token'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
	},
})

/** Creates a database of its own on the Postgres server, so a run never touches another's. */
async function createPostgresDatabase() {
	expect(PG_URL, 'KORA_PG_URL names the Postgres server to test against')
	const name = `kora_matrix_${process.pid}_${Date.now()}`
	const admin = postgres(PG_URL, { max: 1, onnotice: () => {} })
	await admin.unsafe(`CREATE DATABASE ${name}`)
	await admin.end()
	const url = new URL(PG_URL)
	url.pathname = `/${name}`
	return {
		url: url.toString(),
		drop: async () => {
			const cleanup = postgres(PG_URL, { max: 1, onnotice: () => {} })
			await cleanup.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
			await cleanup.end()
		},
	}
}

async function openStore(location) {
	const store =
		STORE === 'postgres'
			? await createPostgresServerStore({ connectionString: location })
			: await createSqliteServerStore({ filename: location })
	await store.setSchema(schema)
	return store
}

async function startServer(store, staticDir, port) {
	const server = createProductionServer({
		store,
		port,
		staticDir,
		syncPath: '/kora-sync',
		syncOptions: {
			schemaVersion: schema.version,
			unscopedSharing: 'allow',
			// The server logs one JSON line per event; the matrix output is a summary table.
			logger: { log() {} },
			auth: new TokenAuthProvider({
				validate: async (token) => (token === USER_TOKEN ? { userId: 'alice' } : null),
			}),
		},
		operationalAuth: { adminToken: ADMIN, metricsToken: METRICS },
	})
	const url = await server.start()
	return { server, url }
}

function openDevice(name, url, token) {
	return createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: join(DIR, `${name}.db`) },
		sync: {
			url: `${url.replace('http', 'ws')}/kora-sync`,
			auth: async () => ({ token }),
			autoConnect: false,
			unassignedWrites: 'assign-to-first-user',
		},
	})
}

async function http(url, path, init) {
	const response = await fetch(`${url}${path}`, init)
	return { status: response.status, headers: response.headers, text: await response.text() }
}

await runScript('server-smoke', async () => {
	expect(STORE === 'sqlite' || STORE === 'postgres', 'KORA_SMOKE_STORE is sqlite or postgres')
	expect(DIR, 'KORA_SMOKE_DIR is set')
	expect(process.env.NODE_ENV === 'production', 'the smoke runs with NODE_ENV=production')
	await ensureWebSocket()
	mkdirSync(DIR, { recursive: true })
	const staticDir = join(DIR, 'dist')
	mkdirSync(staticDir, { recursive: true })
	writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>shell</title><div id="root">')

	const postgresDb = STORE === 'postgres' ? await createPostgresDatabase() : null
	const location = postgresDb ? postgresDb.url : join(DIR, 'server.db')
	const devices = []
	let running = null
	let store = null
	try {
		// 1. Startup.
		store = await openStore(location)
		running = await startServer(store, staticDir, 0)
		const { url } = running
		pass(`${STORE} server started at ${url}`)

		// 2. HTTP contract.
		const health = await http(url, '/health')
		expectEqual(health.status, 200, 'GET /health status')
		const body = JSON.parse(health.text)
		expectEqual(body.status, 'ok', '/health status field')
		if (EXPECT_VERSION)
			expectEqual(body.version, EXPECT_VERSION, '/health reports the packed version')
		expectEqual(body.protocolVersion, 2, '/health protocolVersion')
		expectEqual(body.authRequired, true, '/health authRequired')
		expect(health.headers.get('cross-origin-opener-policy') === 'same-origin', 'COOP header')
		expect(Boolean(health.headers.get('cross-origin-embedder-policy')), 'COEP header')
		pass('/health: version, protocol 2, auth required, isolation headers')

		const closedStatus = await http(url, '/__kora/status')
		expect([401, 403].includes(closedStatus.status), '/__kora/status refuses without a token', {
			status: closedStatus.status,
		})
		const openStatus = await http(url, '/__kora/status', {
			headers: { 'x-kora-admin-token': ADMIN },
		})
		expectEqual(openStatus.status, 200, '/__kora/status with the admin token')
		const metrics = await http(url, '/__kora/metrics', {
			headers: { 'x-kora-metrics-token': METRICS },
		})
		expectEqual(metrics.status, 200, '/__kora/metrics with the metrics token')
		pass('operational endpoints closed without a token, open with it')

		const shell = await http(url, '/')
		expect(shell.status === 200 && shell.text.includes('id="root"'), 'GET / serves the app shell')
		const deepLink = await http(url, '/some/deep/link', { headers: { accept: 'text/html' } })
		expect(
			deepLink.status === 200 && deepLink.text.includes('id="root"'),
			'SPA fallback serves the shell',
		)
		const missing = await http(url, '/missing.js', { headers: { accept: '*/*' } })
		expectEqual(missing.status, 404, 'a missing asset is a 404, not the shell')
		pass('static shell, SPA fallback, 404 for missing assets')

		// 3. Sync contract.
		const stranger = openDevice('stranger', url, 'not-a-valid-token')
		devices.push(stranger)
		await stranger.ready
		await stranger.todos.insert({ title: 'never uploaded' })
		await stranger.sync.connect()
		const refused = await stranger.sync.waitForSettled()
		expectEqual(refused.outcome, 'suspended', 'a bad token suspends the client')
		expectEqual(stranger.sync.status.status, 'auth-required', 'the client reports auth-required')
		const afterStranger = JSON.parse((await http(url, '/health')).text)
		expectEqual(afterStranger.totalOperations, 0, 'the server holds nothing from the bad token')
		pass('a bad token is refused and uploads nothing')

		const a = openDevice('device-a', url, USER_TOKEN)
		const b = openDevice('device-b', url, USER_TOKEN)
		devices.push(a, b)
		await Promise.all([a.ready, b.ready])
		await a.todos.insert({ title: 'from A' })
		await a.sync.connect()
		await a.sync.waitForSettled()
		await b.sync.connect()
		await untilTitles(b.todos, ['from A'], 'device B to receive the write from A')
		await b.todos.insert({ title: 'from B' })
		await untilTitles(a.todos, ['from A', 'from B'], 'device A to receive the write from B')
		pass('two devices converge through the server')

		// The trusted data plane a background job uses: same validated pipeline, fan-out to devices.
		const job = await running.server.kora.apply({
			collection: 'todos',
			type: 'insert',
			data: { title: 'from server job' },
		})
		expect(job.ok, 'server.kora.apply accepts a background write', job)
		const held = await running.server.kora.query('todos')
		expect(
			held.some((row) => row.title === 'from server job'),
			'server.kora.query reads the materialized record',
		)
		await untilTitles(
			a.todos,
			['from A', 'from B', 'from server job'],
			'device A to receive the server job write',
		)
		await untilTitles(
			b.todos,
			['from A', 'from B', 'from server job'],
			'device B to receive the server job write',
		)
		pass('server.kora data plane: apply, query and live fan-out to devices')

		// 4. Restart on the same database.
		await b.sync.disconnect()
		await a.sync.disconnect()
		await running.server.stop()
		await store.close()
		await a.todos.insert({ title: 'while the server was down' })
		store = await openStore(location)
		running = await startServer(store, staticDir, 0)
		const restartedUrl = running.url
		// The app builds its transport from the URL it was created with; the new process has a
		// new port, so devices that survive the restart are opened again on the same files.
		await a.close()
		devices.splice(devices.indexOf(a), 1)
		const a2 = openDevice('device-a', restartedUrl, USER_TOKEN)
		devices.push(a2)
		await a2.ready
		expect(
			(await titlesOf(a2.todos)).includes('while the server was down'),
			'the offline write survived the app restart on disk',
		)
		await a2.sync.connect()
		await a2.sync.waitForSettled()
		const fresh = openDevice('device-fresh', restartedUrl, USER_TOKEN)
		devices.push(fresh)
		await fresh.ready
		await fresh.sync.connect()
		await untilTitles(
			fresh.todos,
			['from A', 'from B', 'from server job', 'while the server was down'],
			'a brand new device to receive everything after the restart',
		)
		pass('server restart keeps the data; a queued write uploads; a new device gets it all')
	} finally {
		for (const device of devices) await device.close().catch(() => {})
		if (running) await running.server.stop().catch(() => {})
		if (store) await store.close().catch(() => {})
		if (postgresDb) await postgresDb.drop().catch(() => {})
	}
})
