/**
 * A TCP proxy that models one shared network link in front of the parity server: per-direction
 * bandwidth shared by every connection (fair round-robin between connections, as TCP flows
 * share a bottleneck), half the round-trip time added each way, and one extra round trip
 * before a new connection carries data (the TCP handshake loopback does not have).
 *
 * Why not only CDP `Network.emulateNetworkConditions` (design doc 2.3): measured in this
 * Chromium, page-level CDP throttling does not reach the service worker, so the precache
 * (finding F4) would download for free and never compete with the first data. A real link is
 * shared by the page, its workers, its service worker and its WebSocket; this proxy is.
 *
 * It also counts the bytes it delivers to the browser, with their times (P9).
 */
import { type Server, type Socket, connect, createServer } from 'node:net'

export interface LinkConditions {
	/** Round-trip time added to every exchange, milliseconds. */
	rttMs: number
	/** Server-to-browser bandwidth, bytes per second. */
	downBytesPerSecond: number
	/** Browser-to-server bandwidth, bytes per second. */
	upBytesPerSecond: number
}

export interface ShapingProxy {
	port: number
	/** Change the link (takes effect for data queued from now on). Null: no shaping. */
	setConditions(conditions: LinkConditions | null): void
	/** Bytes delivered to the browser between two epoch times (ms), and in total since `reset`. */
	downBytesBetween(fromEpochMs: number, toEpochMs: number): number
	downBytesTotal(): number
	reset(): void
	close(): Promise<void>
}

/** The scheduler's tick: each tick sends this much of the link's capacity. */
const TICK_MS = 5
/** Largest slice of one connection sent before moving to the next (fairness granularity). */
const SLICE_BYTES = 4096
/** Pause a sender whose queue holds more than this (bounds the proxy's memory). */
const HIGH_WATER_BYTES = 256 * 1024

interface Direction {
	conditions: () => LinkConditions | null
	bytesPerSecond: (conditions: LinkConditions) => number
	/** Connections with queued data, in round-robin order. */
	active: Flow[]
	/** Bytes the link may still send this tick (credit, carried between ticks while busy). */
	credit: number
	timer: ReturnType<typeof setTimeout> | null
	lastTick: number
}

interface Flow {
	queue: Buffer[]
	queued: number
	/** Socket the data goes to. */
	target: Socket
	/** Socket the data comes from (paused at the high-water mark). */
	source: Socket
	/** The flow carries no data before this time (the handshake round trip). */
	openUntil: number
	onDeliver: (bytes: number) => void
}

/** Listen on a free local port and forward every connection to `targetPort`, shaped. */
export async function startShapingProxy(targetPort: number): Promise<ShapingProxy> {
	let conditions: LinkConditions | null = null
	const delivered: Array<[number, number]> = []
	const sockets = new Set<Socket>()

	const makeDirection = (bytesPerSecond: (c: LinkConditions) => number): Direction => ({
		conditions: () => conditions,
		bytesPerSecond,
		active: [],
		credit: 0,
		timer: null,
		lastTick: 0,
	})
	const down = makeDirection((c) => c.downBytesPerSecond)
	const up = makeDirection((c) => c.upBytesPerSecond)

	function deliver(flow: Flow, chunk: Buffer, delayMs: number): void {
		const send = (): void => {
			if (flow.target.destroyed) return
			flow.target.write(chunk)
			flow.onDeliver(chunk.length)
		}
		if (delayMs <= 0) send()
		else setTimeout(send, delayMs)
	}

	function pump(direction: Direction): void {
		direction.timer = null
		const now = performance.now()
		const link = direction.conditions()
		if (link === null) {
			// Unshaped: drain everything now.
			for (const flow of direction.active) {
				for (const chunk of flow.queue) deliver(flow, chunk, 0)
				flow.queue = []
				flow.queued = 0
				flow.source.resume()
			}
			direction.active = []
			return
		}
		const elapsed = direction.lastTick === 0 ? TICK_MS : now - direction.lastTick
		direction.lastTick = now
		direction.credit = Math.min(
			direction.credit + (direction.bytesPerSecond(link) * elapsed) / 1000,
			direction.bytesPerSecond(link) * 0.05,
		)
		const oneWay = link.rttMs / 2
		let progressed = true
		while (direction.credit > 0 && direction.active.length > 0 && progressed) {
			progressed = false
			const round = [...direction.active]
			for (const flow of round) {
				if (direction.credit <= 0) break
				if (flow.openUntil > now) continue
				const head = flow.queue[0]
				if (head === undefined) continue
				const size = Math.min(head.length, SLICE_BYTES, Math.ceil(direction.credit))
				const slice = head.subarray(0, size)
				if (size === head.length) flow.queue.shift()
				else flow.queue[0] = head.subarray(size)
				flow.queued -= size
				direction.credit -= size
				progressed = true
				deliver(flow, Buffer.from(slice), oneWay)
				if (flow.queued < HIGH_WATER_BYTES / 2) flow.source.resume()
				if (flow.queue.length === 0) {
					direction.active = direction.active.filter((other) => other !== flow)
				}
			}
			// Move the head of the round-robin to the back so the next tick starts elsewhere.
			const first = direction.active.shift()
			if (first !== undefined) direction.active.push(first)
		}
		if (direction.active.length > 0) {
			direction.timer = setTimeout(() => pump(direction), TICK_MS)
		} else {
			direction.lastTick = 0
		}
	}

	function enqueue(direction: Direction, flow: Flow, chunk: Buffer): void {
		flow.queue.push(chunk)
		flow.queued += chunk.length
		if (!direction.active.includes(flow)) direction.active.push(flow)
		if (flow.queued > HIGH_WATER_BYTES) flow.source.pause()
		if (direction.timer === null) {
			const wait = Math.max(0, flow.openUntil - performance.now())
			direction.timer = setTimeout(() => pump(direction), wait)
		}
	}

	const server: Server = createServer((client) => {
		const upstream = connect(targetPort, '127.0.0.1')
		for (const socket of [client, upstream]) {
			socket.setNoDelay(true)
			sockets.add(socket)
			socket.on('close', () => sockets.delete(socket))
			socket.on('error', () => socket.destroy())
		}
		const openUntil = performance.now() + (conditions?.rttMs ?? 0)
		const upFlow: Flow = {
			queue: [],
			queued: 0,
			target: upstream,
			source: client,
			openUntil,
			onDeliver: () => {},
		}
		const downFlow: Flow = {
			queue: [],
			queued: 0,
			target: client,
			source: upstream,
			openUntil,
			onDeliver: (bytes) => delivered.push([performance.timeOrigin + performance.now(), bytes]),
		}
		client.on('data', (chunk: Buffer) => enqueue(up, upFlow, chunk))
		upstream.on('data', (chunk: Buffer) => enqueue(down, downFlow, chunk))
		// Close after the queued data is delivered, never before.
		const closeAfterDrain = (flow: Flow): void => {
			const check = (): void => {
				if (flow.queued === 0) setTimeout(() => flow.target.end(), (conditions?.rttMs ?? 0) / 2 + 1)
				else setTimeout(check, TICK_MS)
			}
			check()
		}
		client.on('end', () => closeAfterDrain(upFlow))
		upstream.on('end', () => closeAfterDrain(downFlow))
		client.on('close', () => upstream.destroy())
		upstream.on('close', () => {
			if (downFlow.queued === 0) client.destroy()
		})
	})

	const port = await new Promise<number>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (address !== null && typeof address === 'object') resolve(address.port)
			else reject(new Error('shaping proxy could not bind'))
		})
	})

	return {
		port,
		setConditions(next) {
			conditions = next
		},
		downBytesBetween(from, to) {
			let total = 0
			for (const [at, bytes] of delivered) if (at >= from && at < to) total += bytes
			return total
		},
		downBytesTotal() {
			return delivered.reduce((sum, [, bytes]) => sum + bytes, 0)
		},
		reset() {
			delivered.length = 0
		},
		close() {
			for (const socket of sockets) socket.destroy()
			return new Promise((resolve) => server.close(() => resolve()))
		},
	}
}
