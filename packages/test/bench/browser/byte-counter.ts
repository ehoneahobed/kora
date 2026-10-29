/**
 * A pass-through TCP proxy that counts the bytes each direction carries. It shapes nothing
 * (the browser's own CDP throttle does that): it exists to report what the sync connection
 * put on the wire, permessage-deflate included, which the page cannot see.
 */
import { type Server, type Socket, connect, createServer } from 'node:net'

export interface ByteCounter {
	port: number
	/** Bytes the server sent to the browser and the browser sent to the server since the last reset. */
	read(): { downBytes: number; upBytes: number; connections: number }
	reset(): void
	close(): Promise<void>
}

/** Listen on a free local port and forward every connection to `targetPort`, counting bytes. */
export async function startByteCounter(targetPort: number): Promise<ByteCounter> {
	let downBytes = 0
	let upBytes = 0
	let connections = 0
	const sockets = new Set<Socket>()
	const server: Server = createServer((client) => {
		connections += 1
		const upstream = connect(targetPort, '127.0.0.1')
		for (const socket of [client, upstream]) {
			socket.setNoDelay(true)
			sockets.add(socket)
			socket.on('close', () => sockets.delete(socket))
			// A reset by the peer at teardown is not a measurement failure.
			socket.on('error', () => socket.destroy())
		}
		client.on('data', (chunk) => {
			upBytes += chunk.length
			if (!upstream.write(chunk)) {
				client.pause()
				upstream.once('drain', () => client.resume())
			}
		})
		upstream.on('data', (chunk) => {
			downBytes += chunk.length
			if (!client.write(chunk)) {
				upstream.pause()
				client.once('drain', () => upstream.resume())
			}
		})
		client.on('close', () => upstream.destroy())
		upstream.on('close', () => client.destroy())
	})
	const port = await new Promise<number>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (address !== null && typeof address === 'object') resolve(address.port)
			else reject(new Error('byte counter could not bind'))
		})
	})
	return {
		port,
		read: () => ({ downBytes, upBytes, connections }),
		reset() {
			downBytes = 0
			upBytes = 0
			connections = 0
		},
		close() {
			for (const socket of sockets) socket.destroy()
			return new Promise((resolve) => server.close(() => resolve()))
		},
	}
}
