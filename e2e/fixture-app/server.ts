import { createKoraServer, MemoryServerStore } from '@korajs/server'

const port = Number(process.env.PORT) || 3001

const store = new MemoryServerStore()
const server = createKoraServer({
  store,
  port,
})

server.start().then(() => {
  console.log(`Kora sync server running on ws://localhost:${port}`)
})
