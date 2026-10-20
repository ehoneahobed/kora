/**
 * An in-process client/server link with a modelled network: per-direction bandwidth,
 * round-trip latency and in-order delivery, carrying JSON text like the WebSocket
 * transport. Payload size on the wire is the permessage-deflate size the server's `ws`
 * default would send (raw deflate per message of 1 KiB or more, no context takeover),
 * unless compression is off.
 *
 * The server side reports `bufferedAmount()` (bytes accepted but not yet on the wire),
 * so the session's delivery backpressure behaves as over a real socket.
 */
import { deflateRawSync } from 'node:zlib'
import type { ServerTransport } from '@korajs/server'
import type { SyncMessage, SyncTransport } from '@korajs/sync'

export interface LinkProfile {
	name: string
	/** Server-to-client bandwidth, bits per second. */
	downBps: number
	/** Client-to-server bandwidth, bits per second. */
	upBps: number
	/** Round-trip time, milliseconds (each direction adds half). */
	rttMs: number
	/** Model permessage-deflate (the `ws` server default). */
	deflate: boolean
}

/** Lighthouse "Slow 4G" (the median mobile profile): 1.6 Mbps down, 750 kbps up, 150 ms. */
export const SLOW_4G: LinkProfile = {
	name: 'slow-4g',
	downBps: 1_600_000,
	upBps: 750_000,
	rttMs: 150,
	deflate: true,
}

/** Chrome DevTools "Fast 4G": 9 Mbps down, 1.5 Mbps up, 60 ms. */
export const FAST_4G: LinkProfile = {
	name: 'fast-4g',
	downBps: 9_000_000,
	upBps: 1_500_000,
	rttMs: 60,
	deflate: true,
}

/** No network cost (isolates CPU). */
export const UNTHROTTLED: LinkProfile = {
	name: 'unthrottled',
	downBps: Number.POSITIVE_INFINITY,
	upBps: Number.POSITIVE_INFINITY,
	rttMs: 0,
	deflate: false,
}

export interface LinkStats {
	downMessages: number
	downJsonBytes: number
	downWireBytes: number
	upMessages: number
	upWireBytes: number
	/** When the client first received each message type (performance.now()). */
	firstDownAt: Record<string, number>
}

class Direction {
	private freeAt = 0
	constructor(
		private readonly bps: number,
		private readonly halfRtt: number,
		private readonly deflate: boolean,
	) {}

	/** Schedule `text`; returns its wire size. */
	send(text: string, deliver: () => void): number {
		const json = Buffer.byteLength(text)
		const wire = this.deflate && json >= 1024 ? deflateRawSync(text).length : json
		const now = performance.now()
		const start = Math.max(now, this.freeAt)
		this.freeAt = Number.isFinite(this.bps) ? start + (wire * 8 * 1000) / this.bps : start
		const at = this.freeAt + this.halfRtt
		setTimeout(deliver, Math.max(0, at - now))
		return wire
	}

	/** Bytes accepted but not yet on the wire. */
	buffered(): number {
		if (!Number.isFinite(this.bps)) return 0
		const backlogMs = this.freeAt - performance.now()
		return backlogMs > 0 ? Math.ceil((backlogMs * this.bps) / 8000) : 0
	}
}

type Handler<T> = ((value: T) => void) | null

/** A linked client/server transport pair over a modelled network. */
export function createThrottledPair(profile: LinkProfile): {
	client: SyncTransport
	server: ServerTransport
	stats: LinkStats
} {
	const stats: LinkStats = {
		downMessages: 0,
		downJsonBytes: 0,
		downWireBytes: 0,
		upMessages: 0,
		upWireBytes: 0,
		firstDownAt: {},
	}
	const down = new Direction(profile.downBps, profile.rttMs / 2, profile.deflate)
	const up = new Direction(profile.upBps, profile.rttMs / 2, profile.deflate)
	let open = true
	let clientMessage: Handler<SyncMessage> = null
	let clientClose: Handler<string> = null
	let serverMessage: Handler<SyncMessage> = null
	let serverClose: ((code: number, reason: string) => void) | null = null

	const closeBoth = (reason: string): void => {
		if (!open) return
		open = false
		clientClose?.(reason)
		serverClose?.(1000, reason)
	}

	const client: SyncTransport = {
		async connect(): Promise<void> {
			open = true
		},
		async disconnect(): Promise<void> {
			closeBoth('client disconnected')
		},
		send(message: SyncMessage): void {
			if (!open) throw new Error('Cannot send message: link closed')
			const text = JSON.stringify(message)
			stats.upMessages += 1
			stats.upWireBytes += up.send(text, () => {
				if (open) serverMessage?.(JSON.parse(text) as SyncMessage)
			})
		},
		onMessage(handler): void {
			clientMessage = handler
		},
		onClose(handler): void {
			clientClose = handler
		},
		onError(): void {},
		isConnected(): boolean {
			return open
		},
	}

	const server: ServerTransport = {
		send(message: SyncMessage): void {
			if (!open) return
			const text = JSON.stringify(message)
			stats.downMessages += 1
			stats.downJsonBytes += Buffer.byteLength(text)
			stats.downWireBytes += down.send(text, () => {
				if (!open) return
				stats.firstDownAt[message.type] ??= performance.now()
				clientMessage?.(JSON.parse(text) as SyncMessage)
			})
		},
		onMessage(handler): void {
			serverMessage = handler
		},
		onClose(handler): void {
			serverClose = handler
		},
		onError(): void {},
		isConnected(): boolean {
			return open
		},
		close(): void {
			closeBoth('server closed')
		},
		bufferedAmount(): number {
			return down.buffered()
		},
	}

	return { client, server, stats }
}
