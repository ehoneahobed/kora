import { createProductionServer, createSqliteServerStore } from '@korajs/server'

// Sync server for your Kora desktop app.
// Started automatically by `pnpm dev`, or run standalone with `pnpm dev:server`.
// Deploy with `pnpm deploy:server` (uses kora deploy).
//
// All desktop clients connect to this server to sync data across devices.
// For production, deploy this server and set VITE_SYNC_URL when building
// the desktop app: VITE_SYNC_URL=wss://your-server.com/kora-sync pnpm build

const store = createSqliteServerStore({ filename: './kora-server.db' })

const server = createProductionServer({
  store,
  port: Number(process.env.PORT) || 3001,
  staticDir: './dist',
  syncPath: '/kora-sync',
})

server.start().then((url) => {
  console.log(`Kora sync server running at ${url}`)
  console.log(`  Sync endpoint: ${url.replace('http', 'ws')}/kora-sync`)
})
