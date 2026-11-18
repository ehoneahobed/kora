import { createServer } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { postToAddress } from './webhooks'

/**
 * The default transport connects to the address it is given, not to what the URL's host
 * resolves to: here the host does not resolve at all (.invalid), and the connection still
 * reaches the local server at the given address (the TLS handshake then fails: it is not an
 * HTTPS server, and that does not matter here).
 */
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(() => {
	for (const server of servers.splice(0)) server.close()
})

describe('postToAddress', () => {
	test('connects to the given address, whatever the URL host resolves to', async () => {
		let connections = 0
		const server = createServer((socket) => {
			connections++
			socket.destroy()
		})
		servers.push(server)
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		const port = (server.address() as { port: number }).port
		await postToAddress({
			url: `https://webhook.invalid:${port}/hook`,
			address: '127.0.0.1',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		}).catch(() => undefined)
		expect(connections).toBe(1)
	})
})
