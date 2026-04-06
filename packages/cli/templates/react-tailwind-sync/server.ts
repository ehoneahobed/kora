import { createProductionServer, createSqliteServerStore } from '@korajs/server'

// SQLite persists data to disk — survives server restarts
const store = createSqliteServerStore({ filename: './kora-server.db' })

// To use PostgreSQL instead:
// 1. Install: pnpm add postgres
// 2. Replace the store above with:
//
// import { createPostgresServerStore } from '@korajs/server'
// const store = await createPostgresServerStore({
//   connectionString: 'postgresql://user:password@localhost:5432/mydb',
// })

// Production server: serves static files + WebSocket sync on a single port.
// One port means one tunnel (ngrok, cloudflared) handles everything.
const server = createProductionServer({
  store,
  port: Number(process.env.PORT) || 3001,
  staticDir: './dist',
  syncPath: '/kora-sync',
})

server.start().then((url) => {
  console.log(`Kora app running at ${url}`)
})
