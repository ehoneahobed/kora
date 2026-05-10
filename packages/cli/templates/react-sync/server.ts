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
  const server = createProductionServer({
    store,
    port: Number(process.env.PORT) || 3001,
    staticDir: './dist',
    syncPath,
    operationalAuth: {
      adminToken: process.env.KORA_ADMIN_TOKEN,
      metricsToken: process.env.KORA_METRICS_TOKEN,
      backupToken: process.env.KORA_BACKUP_TOKEN,
    },
  })

  const url = await server.start()
  console.log(`Kora app running at ${url}`)
  console.log(`  Sync endpoint: ${url.replace('http', 'ws')}${syncPath}`)
}

void start()
