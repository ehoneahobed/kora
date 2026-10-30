/**
 * Runs under a PRIOR release (beta.12, the latest published release, the latest canary):
 * leaves behind what a user's machine holds when they upgrade.
 *
 *   - a server database (SQLite file) written by the prior server;
 *   - a device database (SQLite file) written by a prior client, holding records that synced
 *     and one local write that was never uploaded.
 *
 * `upgrade-reader.mjs` then opens both files with the candidate packed packages and requires
 * that nothing is lost. Only API that exists in every prior release is used here.
 */
import { join } from 'node:path'
import { TokenAuthProvider, createProductionServer, createSqliteServerStore } from '@korajs/server'
import { createApp, defineSchema, t } from 'korajs'
import { ensureWebSocket, expect, freePort, pass, runScript, until } from './common.mjs'

const DIR = process.env.KORA_UPGRADE_DIR
const TOKEN = 'alice-token'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), completed: t.boolean().default(false) } },
	},
})

await runScript('upgrade-writer', async () => {
	expect(DIR, 'KORA_UPGRADE_DIR is set')
	await ensureWebSocket()
	const store = await createSqliteServerStore({ filename: join(DIR, 'server.db') })
	await store.setSchema(schema)
	const server = createProductionServer({
		store,
		port: await freePort(),
		staticDir: DIR,
		syncOptions: {
			schemaVersion: schema.version,
			logger: { log() {} },
			unscopedSharing: 'allow',
			// The same authentication the candidate runs with: this is an upgrade, not a switch from
			// anonymous devices to signed-in ones (that is a documented, separate migration).
			auth: new TokenAuthProvider({
				validate: async (token) => (token === TOKEN ? { userId: 'alice' } : null),
			}),
		},
	})
	const url = await server.start()
	const app = createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: join(DIR, 'device.db') },
		sync: {
			url: `${url.replace('http', 'ws')}/kora-sync`,
			auth: async () => ({ token: TOKEN }),
			autoConnect: false,
			unassignedWrites: 'assign-to-first-user',
		},
	})
	try {
		await app.ready
		await app.todos.insert({ title: 'synced-1' })
		await app.todos.insert({ title: 'synced-2' })
		await app.sync.connect()
		await until(
			(callback) => app.sync.subscribeStatus(callback),
			(status) => status.status === 'synced' && status.pendingOperations === 0,
			'the prior client to finish uploading',
		)
		await app.sync.disconnect()
		await app.todos.insert({ title: 'unsynced-3' })
		pass('prior release wrote the server database and a device database with one unsent write')
	} finally {
		await app.close().catch(() => {})
		await server.stop().catch(() => {})
		await store.close().catch(() => {})
	}
})
