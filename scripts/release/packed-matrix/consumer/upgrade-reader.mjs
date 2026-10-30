/**
 * Runs under the CANDIDATE packed packages against the files `upgrade-writer.mjs` left behind
 * by a prior release. The contract (release notes: "upgrade without deleting local data"):
 *
 *   1. the device database opens and still holds every record, including the unsent write;
 *   2. the candidate server opens the prior server database, with authentication now required,
 *      and keeps the history;
 *   3. the device syncs, its unsent write uploads, and a brand new device receives all three
 *      records: nothing is lost, nothing is duplicated;
 *   4. the device keeps working afterwards (a new write round-trips).
 */
import { join } from 'node:path'
import { TokenAuthProvider, createProductionServer, createSqliteServerStore } from '@korajs/server'
import { createApp, defineSchema, t } from 'korajs'
import {
	ensureWebSocket,
	expect,
	expectEqual,
	pass,
	runScript,
	titlesOf,
	untilTitles,
} from './common.mjs'

const DIR = process.env.KORA_UPGRADE_DIR
const PRIOR = process.env.KORA_PRIOR_VERSION ?? 'prior'
const TOKEN = 'alice-token'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
	},
})

await runScript('upgrade-reader', async () => {
	expect(DIR, 'KORA_UPGRADE_DIR is set')
	await ensureWebSocket()
	const devices = []
	const open = (file, url) => {
		const app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: join(DIR, file) },
			sync: {
				url: `${url.replace('http', 'ws')}/kora-sync`,
				auth: async () => ({ token: TOKEN }),
				autoConnect: false,
				unassignedWrites: 'assign-to-first-user',
			},
		})
		devices.push(app)
		return app
	}

	// 1. The device database, before any server is involved.
	const offline = createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: join(DIR, 'device.db') },
	})
	try {
		await offline.ready
		expectEqual(
			await titlesOf(offline.todos),
			['synced-1', 'synced-2', 'unsynced-3'],
			`the ${PRIOR} device database opens with every record, unsent write included`,
		)
	} finally {
		await offline.close()
	}
	pass(`the ${PRIOR} device database opens in the candidate with all 3 records`)

	// 2. The prior server database under the candidate server, now with authentication.
	const store = await createSqliteServerStore({ filename: join(DIR, 'server.db') })
	await store.setSchema(schema)
	const server = createProductionServer({
		store,
		port: 0,
		staticDir: DIR,
		syncOptions: {
			schemaVersion: schema.version,
			unscopedSharing: 'allow',
			logger: { log() {} },
			auth: new TokenAuthProvider({
				validate: async (token) => (token === TOKEN ? { userId: 'alice' } : null),
			}),
		},
	})
	try {
		const url = await server.start()
		const health = await (await fetch(`${url}/health`)).json()
		expect(health.totalOperations >= 2, `the candidate server kept the ${PRIOR} history`, health)
		pass(
			`the candidate server opens the ${PRIOR} server database with ${health.totalOperations} operations`,
		)

		// 3. The device syncs: the unsent write uploads; a new device receives everything.
		const device = open('device.db', url)
		await device.ready
		await device.sync.connect()
		await device.sync.waitForSettled()
		expectEqual(
			await titlesOf(device.todos),
			['synced-1', 'synced-2', 'unsynced-3'],
			'syncing the upgraded device changes none of its records',
		)
		const fresh = open('fresh.db', url)
		await fresh.ready
		await fresh.sync.connect()
		await untilTitles(
			fresh.todos,
			['synced-1', 'synced-2', 'unsynced-3'],
			'a new device to receive the upgraded device history, unsent write included',
		)
		pass('the unsent write uploaded and a new device received all 3 records, once each')

		// 4. Still working.
		await device.todos.insert({ title: 'after-upgrade-4' })
		await untilTitles(
			fresh.todos,
			['synced-1', 'synced-2', 'unsynced-3', 'after-upgrade-4'],
			'a write made after the upgrade to reach the other device',
		)
		pass('a write after the upgrade round-trips')
	} finally {
		for (const app of devices) await app.close().catch(() => {})
		await server.stop().catch(() => {})
		await store.close().catch(() => {})
	}
})
