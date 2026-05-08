import { createProductionServer, createSqliteServerStore } from '@korajs/server'

// Sync server for your Tauri desktop app.
// Run with: pnpm dev:server
// The desktop app connects to this server to sync data across devices.

const store = createSqliteServerStore({ filename: './kora-server.db' })

const server = createProductionServer({
  store,
  port: Number(process.env.PORT) || 3001,
  staticDir: './dist',
  syncPath: '/kora-sync',
})

server.start().then((url) => {
  console.log(`Kora sync server running at ${url}`)
})
