import type { ServerTransport } from '@korajs/server'
import type { SyncMessage } from '@korajs/sync'
import type { TransportPair } from './protobuf-wire-transport'

/**
 * Wraps a server transport so its handshake responses advertise a caller-chosen
 * wall-clock time, independent of the process `Date.now()`.
 *
 * The sync engine measures clock skew as `serverTime - Date.now()` at handshake.
 * To simulate a device whose clock is fast while the server's clock is correct —
 * both running in one test process — the client mocks `Date.now()` and this
 * wrapper injects the server's true time into the handshake response, so the
 * skew the engine sees is real.
 */
class ServerClockServerTransport implements ServerTransport {
	constructor(
		private readonly inner: ServerTransport,
		private readonly serverNow: () => number,
	) {}

	send(message: SyncMessage): void {
		if (message.type === 'handshake-response') {
			this.inner.send({ ...message, serverTime: this.serverNow() })
			return
		}
		this.inner.send(message)
	}

	onMessage(handler: (message: SyncMessage) => void): void {
		this.inner.onMessage(handler)
	}

	onClose(handler: (code: number, reason: string) => void): void {
		this.inner.onClose(handler)
	}

	onError(handler: (error: Error) => void): void {
		this.inner.onError(handler)
	}

	isConnected(): boolean {
		return this.inner.isConnected()
	}

	close(code?: number, reason?: string): void {
		this.inner.close(code, reason)
	}
}

/**
 * Wraps a transport pair so the server side reports `serverNow()` as its
 * handshake wall-clock time.
 *
 * @param pair - The underlying transport pair
 * @param serverNow - Returns the server's true current time (ms since epoch)
 * @returns A transport pair whose handshake responses carry the injected time
 */
export function wrapTransportPairWithServerClock(
	pair: TransportPair,
	serverNow: () => number,
): TransportPair {
	return {
		client: pair.client,
		serverTransport: new ServerClockServerTransport(pair.serverTransport, serverNow),
	}
}
