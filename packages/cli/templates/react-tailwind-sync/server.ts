import { createKoraServer, createSqliteServerStore } from '@korajs/server'

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

const server = createKoraServer({
  store,
  port: Number(process.env.PORT) || 3001,
})

server.start().then(() => {
  console.log('Kora sync server running on ws://localhost:3001')
})
