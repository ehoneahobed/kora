/**
 * Smoke contract of a scaffolded sync template's OWN server (`server.ts`, started by
 * `pnpm start`), driven over HTTP and WebSocket from a Node client. Run with
 * `node --import tsx` inside the scaffolded app, so `./src/schema.ts` is the user's schema and
 * every package is the installed tarball.
 *
 * Two phases around a server restart, which the matrix performs between them:
 *
 *   seed:   /health and the app shell are right; a user signs up through the template's auth
 *           routes; a device signs in, writes and syncs.
 *   verify: after the restart on the SAME database the user can sign in again (the user store
 *           persisted), and a brand new device receives what the first device wrote.
 *
 * The same script runs against SQLite and Postgres; the server picks its store from
 * `DATABASE_URL`, exactly as the template documents.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createKoraAuth, createKoraAuthSync } from '@korajs/auth'
import { createApp } from 'korajs'
import { ensureWebSocket, expect, expectEqual, pass, runScript, untilTitles } from './common.mjs'
import schema from './src/schema.ts'

const PHASE = process.env.KORA_TEMPLATE_PHASE
const URL_BASE = process.env.KORA_TEMPLATE_URL
const DIR = process.env.KORA_TEMPLATE_DIR
const EXPECT_VERSION = process.env.KORA_EXPECT_SERVER_VERSION
const STATE_FILE = DIR ? join(DIR, 'template-smoke-state.json') : ''

function openDevice(name, authClient) {
	const app = createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: join(DIR, `${name}.db`) },
		sync: {
			url: `${URL_BASE.replace('http', 'ws')}/kora-sync`,
			authClient: createKoraAuthSync({ authClient, schema }),
			autoConnect: false,
		},
	})
	return app
}

await runScript(`template-server-smoke (${PHASE})`, async () => {
	expect(PHASE === 'seed' || PHASE === 'verify', 'KORA_TEMPLATE_PHASE is seed or verify')
	expect(URL_BASE && DIR, 'KORA_TEMPLATE_URL and KORA_TEMPLATE_DIR are set')
	await ensureWebSocket()
	const credentials =
		PHASE === 'seed'
			? { email: `matrix-${process.pid}@example.test`, password: 'correct-horse-battery-staple-9' }
			: JSON.parse(readFileSync(STATE_FILE, 'utf8'))
	const auth = createKoraAuth({ serverUrl: URL_BASE })
	const apps = []
	try {
		if (PHASE === 'seed') {
			const health = await (await fetch(`${URL_BASE}/health`)).json()
			expectEqual(health.status, 'ok', "the template server's /health status")
			if (EXPECT_VERSION)
				expectEqual(health.version, EXPECT_VERSION, '/health reports the packed server')
			expectEqual(health.protocolVersion, 2, '/health protocolVersion')
			expectEqual(health.authRequired, true, 'the template server requires authentication')
			const shell = await fetch(`${URL_BASE}/`)
			expect(shell.status === 200, 'GET / serves the built app shell')
			expect(
				shell.headers.get('cross-origin-opener-policy') === 'same-origin',
				'the shell is served cross-origin isolated (COOP)',
			)
			expect((await fetch(`${URL_BASE}/sw.js`)).status === 200, 'the service worker is served')
			pass('template server: /health, app shell, isolation headers, service worker')

			await auth.signUp(credentials)
			writeFileSync(STATE_FILE, JSON.stringify(credentials))
			pass('a user signs up through the template auth routes')
		} else {
			await auth.signIn(credentials)
			pass('the user signs in again after the restart: the user store persisted')
		}

		if (PHASE === 'seed') {
			const first = openDevice('device-1', auth)
			apps.push(first)
			await first.ready
			await first.todos.insert({ title: 'seeded before the restart' })
			await first.sync.connect()
			await first.sync.waitForSettled()
			const health = await (await fetch(`${URL_BASE}/health`)).json()
			expect(health.totalOperations >= 1, 'the server holds the first device write', health)
			pass('a signed-in device writes and syncs to the template server')
		} else {
			const fresh = openDevice('device-2', auth)
			apps.push(fresh)
			await fresh.ready
			await fresh.sync.connect()
			await untilTitles(
				fresh.todos,
				['seeded before the restart'],
				'a new device to receive the data written before the restart',
			)
			pass('a brand new device receives the pre-restart data from the same database')
		}
	} finally {
		for (const app of apps) await app.close().catch(() => {})
	}
})
