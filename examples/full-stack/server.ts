import { existsSync, readFileSync } from 'node:fs'
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

loadLocalEnv()

function loadLocalEnv(mode = process.env.NODE_ENV || 'development') {
	const existingKeys = new Set(Object.keys(process.env))
	for (const file of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
		if (!existsSync(file)) continue
		for (const [key, value] of Object.entries(parseEnvFile(readFileSync(file, 'utf8')))) {
			if (!existingKeys.has(key)) {
				process.env[key] = value
			}
		}
	}
}

function parseEnvFile(contents: string): Record<string, string> {
	const env: Record<string, string> = {}
	for (const rawLine of contents.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line
		const equalsIndex = normalized.indexOf('=')
		if (equalsIndex <= 0) continue
		const key = normalized.slice(0, equalsIndex).trim()
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
		env[key] = parseEnvValue(normalized.slice(equalsIndex + 1).trim())
	}
	return env
}

function parseEnvValue(value: string): string {
	const quote = value[0]
	if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
		const inner = value.slice(1, -1)
		return quote === '"' ? inner.replace(/\\n/g, '\n').replace(/\\r/g, '\r') : inner
	}
	const commentIndex = value.search(/\s#/)
	return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim()
}

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
