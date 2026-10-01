import { type Server, createServer as createHttpServer } from 'node:http'
import {
	type AddressInfo,
	Socket as NetSocket,
	type Socket,
	createServer as createTcpServer,
} from 'node:net'
import type { Operation } from '@korajs/core'
import { JsonMessageSerializer, type SyncMessage } from '@korajs/sync'
import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { createProductionServer } from '../../src/server/production-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'
import { WsServerTransport } from '../../src/transport/ws-server-transport'

/**
 * LMS-12 (external report, Part D #12): connection liveness.
 *
 * 1. HEAD: a ghost (half-open) delivery-watermark session is re-scanned from its
 *    unacknowledged watermark on every delivery-poll tick, forever.
 * 2. HEAD: the production server never pings an idle WebSocket (no liveness probe).
 * 3. The report's snippet, replicated: terminate() on a missed pong DOES run Kora's
 *    normal close path (session + relay registrations removed).
 * 4. HEAD: an abandoned HTTP long-poll client is never reaped (ping/pong cannot help).
 */

const json = new JsonMessageSerializer()
let seq = 0
function op(): Operation {
	seq += 1
	return {
		id: `op-${seq}`,
		nodeId: 'teacher',
		type: 'insert',
		collection: 'todos',
		recordId: `r-${seq}`,
		data: { title: `t${seq}` },
		previousData: null,
		timestamp: { wallTime: 1_000 + seq, logical: 0, nodeId: 'teacher' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
	vi.useRealTimers()
	while (cleanups.length) await cleanups.pop()?.()
})

describe('LMS-12: liveness', () => {
	test('HEAD cost: a ghost watermark session re-scans its whole unacked backlog every poll tick', async () => {
		const store = new MemoryServerStore('srv')
		for (let i = 0; i < 2_000; i++) await store.applyRemoteOperation(op())
		const server = new KoraSyncServer({ store, deliveryPollIntervalMs: 50 })
		cleanups.push(() => server.stop())
		// A transport that stays "connected" but whose peer never reads or acks: exactly
		// what a half-open TCP connection looks like to the server.
		const { client, server: transport } = createServerTransportPair()
		server.handleConnection(transport)
		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'sleeping-phone',
			versionVector: {},
			schemaVersion: 1,
			lastDeliverySequence: 0,
		} as SyncMessage)
		await new Promise((r) => setTimeout(r, 100))
		await store.applyRemoteOperation(op()) // frontier moves past the ghost's watermark
		const spy = vi.spyOn(store, 'getOperationsAfterDelivery')
		await new Promise((r) => setTimeout(r, 1_000))
		const scannedRows = spy.mock.results.length
		const calls = spy.mock.calls.filter((c) => c[0] === 0).length
		console.log(
			`[LMS-12] ghost session over 1 s at 50 ms poll: ${scannedRows} scan queries, ${calls} restarted from watermark 0 (2,001-op backlog each)`,
		)
		// Correct behaviour would bound this (liveness reaping or backoff). HEAD re-scans
		// from 0 on roughly every tick for as long as the socket looks open.
		expect(calls).toBeGreaterThan(5)
	}, 20_000)

	test('the production server must probe an idle WebSocket (ping) within 35 s', async () => {
		const store = new MemoryServerStore('srv')
		const port = 41_000 + Math.floor(Math.random() * 1_000)
		const prod = createProductionServer({ store, port, staticDir: '/nonexistent' })
		await prod.start()
		cleanups.push(() => prod.stop())
		const ws = new WebSocket(`ws://127.0.0.1:${port}/kora-sync`)
		cleanups.push(() => ws.terminate())
		let pinged = false
		ws.on('ping', () => {
			pinged = true
		})
		await new Promise((r) => ws.once('open', r))
		await new Promise((r) => setTimeout(r, 35_000))
		expect(pinged).toBe(true)
	}, 45_000)

	test("the report's snippet: terminate() on a missed pong runs Kora's close path", async () => {
		const store = new MemoryServerStore('srv')
		const sync = new KoraSyncServer({ store })
		const wss = new WebSocketServer({ noServer: true })
		const http: Server = createHttpServer()
		const PING_MS = 150
		http.on('upgrade', (req, socket, head) => {
			wss.handleUpgrade(req, socket, head, (ws) => {
				// --- verbatim shape of the report's fix, interval shortened ---
				let isAlive = true
				ws.on('pong', () => {
					isAlive = true
				})
				const pingTimer = setInterval(() => {
					if (!isAlive) {
						ws.terminate()
						return
					}
					isAlive = false
					ws.ping()
				}, PING_MS)
				ws.on('close', () => clearInterval(pingTimer))
				sync.handleConnection(new WsServerTransport(ws as never))
			})
		})
		await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
		cleanups.push(() => new Promise<void>((r) => http.close(() => r())))
		cleanups.push(() => sync.stop())
		const { port } = http.address() as AddressInfo
		// autoPong:false = a peer that is gone but whose socket never sent FIN.
		const ws = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false })
		cleanups.push(() => ws.terminate())
		await new Promise((r) => ws.once('open', r))
		ws.send(
			json.encode({
				type: 'handshake',
				messageId: 'hs',
				nodeId: 'phone',
				versionVector: {},
				schemaVersion: 1,
			} as SyncMessage) as string,
		)
		await vi.waitFor(() => expect(sync.getConnectionCount()).toBe(1))
		await vi.waitFor(() => expect(sync.getConnectionCount()).toBe(0), { timeout: 3_000 })
	}, 10_000)

	test('a half-open (blackholed) connection is NOT detected by HEAD within 10 s', async () => {
		// TCP proxy that silently stops forwarding: no FIN, no RST. The OS will not report
		// this for minutes (retransmission timeout), so only an application probe can.
		const store = new MemoryServerStore('srv')
		const port = 42_000 + Math.floor(Math.random() * 1_000)
		const prod = createProductionServer({ store, port, staticDir: '/nonexistent' })
		await prod.start()
		cleanups.push(() => prod.stop())
		let blackhole = false
		const sockets: Socket[] = []
		const proxy = createTcpServer((inbound) => {
			const outbound = new NetSocket()
			outbound.connect(port, '127.0.0.1')
			sockets.push(inbound, outbound)
			inbound.on('data', (d) => !blackhole && outbound.write(d))
			outbound.on('data', (d) => !blackhole && inbound.write(d))
			inbound.on('error', () => {})
			outbound.on('error', () => {})
		})
		await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()))
		cleanups.push(() => {
			for (const s of sockets) s.destroy()
			return new Promise<void>((r) => proxy.close(() => r()))
		})
		const proxyPort = (proxy.address() as AddressInfo).port
		const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/kora-sync`)
		cleanups.push(() => ws.terminate())
		await new Promise((r) => ws.once('open', r))
		const statusBefore = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
		blackhole = true
		await new Promise((r) => setTimeout(r, 10_000))
		const statusAfter = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
		console.log(
			`[LMS-12] blackholed peer: connectedClients before=${statusBefore.connectedClients} after 10 s=${statusAfter.connectedClients}`,
		)
		// Documented HEAD behaviour (not a target): the ghost is still counted.
		expect(statusAfter.connectedClients).toBe(1)
	}, 20_000)

	test('an abandoned HTTP long-poll client must be reaped after inactivity', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
		const store = new MemoryServerStore('srv')
		const server = new KoraSyncServer({ store })
		cleanups.push(() => server.stop())
		await server.handleHttpRequest({
			clientId: 'phone-on-3g',
			method: 'POST',
			contentType: 'application/json',
			body: json.encode({
				type: 'handshake',
				messageId: 'hs',
				nodeId: 'phone',
				versionVector: {},
				schemaVersion: 1,
			} as SyncMessage) as string,
		})
		await vi.waitFor(() => expect(server.getConnectionCount()).toBe(1))
		// Never polls again. Relays keep queueing into its transport.
		for (let i = 0; i < 200; i++) server.relayServerOperations([op()])
		await vi.advanceTimersByTimeAsync(30 * 60_000) // 30 minutes of silence
		expect(server.getConnectionCount()).toBe(0)
	}, 20_000)
})
