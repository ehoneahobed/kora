import { createServer as createHttpServer } from 'node:http'
import { MemoryServerStore, createKoraServer } from '@korajs/server'

const port = Number(process.env.PORT) || 3001

const store = new MemoryServerStore()
const server = createKoraServer({
	store,
	port,
})

/** E2E-only: wipe sync state between Playwright tests. */
createHttpServer((req, res) => {
	if (req.url === '/__e2e_reset' && req.method === 'POST') {
		store.resetForTests()
		res.writeHead(204)
		res.end()
		return
	}
	res.writeHead(404)
	res.end()
}).listen(port + 100)

server.start().then(() => {
	console.log(`Kora sync server running on ws://localhost:${port}`)
	console.log(`E2E reset API on http://localhost:${port + 100}/__e2e_reset`)
})
