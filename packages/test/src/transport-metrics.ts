import type { ServerTransport } from '@korajs/server'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import type { TransportPair } from './protobuf-wire-transport'

export interface TestTransferMetrics {
	connectionAttempts: number
	disconnections: number
	clientMessages: number
	serverMessages: number
	clientBytes: number
	serverBytes: number
	reset(): void
}

function wireBytes(message: SyncMessage): number {
	return new TextEncoder().encode(JSON.stringify(message)).byteLength
}

/** Create a transport wrapper and counters for asserting reconnect and transfer cost. */
export function createTransportMetrics(): {
	metrics: TestTransferMetrics
	wrapTransport(pair: TransportPair): TransportPair
} {
	const metrics: TestTransferMetrics = {
		connectionAttempts: 0,
		disconnections: 0,
		clientMessages: 0,
		serverMessages: 0,
		clientBytes: 0,
		serverBytes: 0,
		reset() {
			this.connectionAttempts = 0
			this.disconnections = 0
			this.clientMessages = 0
			this.serverMessages = 0
			this.clientBytes = 0
			this.serverBytes = 0
		},
	}

	return {
		metrics,
		wrapTransport(pair) {
			const client: SyncTransport = {
				...pair.client,
				async connect(url, options) {
					metrics.connectionAttempts++
					await pair.client.connect(url, options)
				},
				async disconnect() {
					metrics.disconnections++
					await pair.client.disconnect()
				},
				send(message) {
					metrics.clientMessages++
					metrics.clientBytes += wireBytes(message)
					pair.client.send(message)
				},
				onMessage: (handler) => pair.client.onMessage(handler),
				onClose: (handler) => pair.client.onClose(handler),
				onError: (handler) => pair.client.onError(handler),
				isConnected: () => pair.client.isConnected(),
			}
			const serverTransport: ServerTransport = {
				...pair.serverTransport,
				send(message) {
					metrics.serverMessages++
					metrics.serverBytes += wireBytes(message)
					pair.serverTransport.send(message)
				},
				onMessage: (handler) => pair.serverTransport.onMessage(handler),
				onClose: (handler) => pair.serverTransport.onClose(handler),
				onError: (handler) => pair.serverTransport.onError(handler),
				isConnected: () => pair.serverTransport.isConnected(),
				close: (code, reason) => pair.serverTransport.close(code, reason),
			}
			return { client, serverTransport }
		},
	}
}
