import {
	type CreateKoraAuthServerOptions,
	createKoraAuthServer,
	createPostgresOAuthStores,
	createSqliteOAuthStores,
	googleProvider,
} from '@korajs/auth/server'
import {
	createPostgresServerStore,
	createProductionServer,
	createSqliteServerStore,
} from '@korajs/server'
import schema from './src/schema'

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
	const auth = await createAuth()
	const server = createProductionServer({
		store,
		port: Number(process.env.PORT) || 3001,
		staticDir: './dist',
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
	console.log(`Kora app running at ${url}`)
	console.log(`  Sync endpoint: ${url.replace('http', 'ws')}${syncPath}`)
	if (auth) console.log(`  Auth endpoint: ${url}/auth`)
}

void start()

async function createAuth() {
	if (!process.env.KORA_AUTH_SECRET) {
		return null
	}

	const oauth = await createOAuthConfig()
	return createKoraAuthServer({
		jwtSecret: process.env.KORA_AUTH_SECRET,
		...(oauth ? { oauth } : {}),
	})
}

async function createOAuthConfig(): Promise<CreateKoraAuthServerOptions['oauth'] | undefined> {
	if (!process.env.KORA_GOOGLE_CLIENT_ID || !process.env.KORA_GOOGLE_REDIRECT_URI) {
		return undefined
	}

	const oauthStores = process.env.DATABASE_URL
		? await createPostgresOAuthStores({ connectionString: process.env.DATABASE_URL })
		: await createSqliteOAuthStores({
				filename: process.env.KORA_AUTH_DB || './kora-auth.db',
			})

	return {
		providers: [
			googleProvider({
				clientId: process.env.KORA_GOOGLE_CLIENT_ID,
				clientSecret: process.env.KORA_GOOGLE_CLIENT_SECRET,
				redirectUri: process.env.KORA_GOOGLE_REDIRECT_URI,
				pkce: process.env.KORA_OAUTH_PKCE === 'true' || !process.env.KORA_GOOGLE_CLIENT_SECRET,
			}),
		],
		stateStore: oauthStores.stateStore,
		linkedIdentityStore: oauthStores.linkedIdentityStore,
	}
}
