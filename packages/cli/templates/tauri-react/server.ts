import { createKoraAuthServer } from '@korajs/auth/server'
import {
	createPostgresServerStore,
	createProductionServer,
	createSqliteServerStore,
} from '@korajs/server'
import schema from './src/schema'

// Sync server for your Kora desktop app.
// Started automatically by `pnpm dev`, or run standalone with `pnpm dev:server`.
// Deploy with `pnpm deploy:server` (uses kora deploy).
//
// All desktop clients connect to this server to sync data across devices.
// For production, deploy this server and set VITE_SYNC_URL when building
// the desktop app: VITE_SYNC_URL=wss://your-server.com/kora-sync pnpm build

async function createStore() {
	if (process.env.DATABASE_URL) {
		return createPostgresServerStore({
			connectionString: process.env.DATABASE_URL,
		})
	}

	return createSqliteServerStore({
		filename: process.env.KORA_SERVER_DB || './kora-server.db',
	})
}

async function start() {
	const store = await createStore()
	await store.setSchema(schema)

	const syncPath = process.env.KORA_SYNC_PATH || '/kora-sync'
	const auth = process.env.KORA_AUTH_SECRET
		? createKoraAuthServer({ jwtSecret: process.env.KORA_AUTH_SECRET })
		: null
	const server = createProductionServer({
		store,
		port: Number(process.env.PORT) || 3001,
		syncPath,
		httpRoutes: auth ? [{ path: '/auth', handle: auth.handleRequest }] : undefined,
		syncOptions: auth ? { auth: auth.auth } : undefined,
		operationalAuth: {
			adminToken: process.env.KORA_ADMIN_TOKEN,
			metricsToken: process.env.KORA_METRICS_TOKEN,
			backupToken: process.env.KORA_BACKUP_TOKEN,
		},
	})

	const url = await server.start()
	console.log(`Kora sync server running at ${url}`)
	console.log(`  Sync endpoint: ${url.replace('http', 'ws')}${syncPath}`)
	if (auth) console.log(`  Auth endpoint: ${url}/auth`)
}

void start()
