import { createKoraServer, MemoryServerStore } from '@korajs/server'

const store = new MemoryServerStore()
const server = createKoraServer({
  store,
  port: 3001,
})

server.start().then(() => {
  console.log('Kora sync server running on ws://localhost:3001')
})
