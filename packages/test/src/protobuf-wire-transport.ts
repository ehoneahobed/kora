import type { ServerTransport } from '@korajs/server'
import type { MessageSerializer, SyncMessage, SyncTransport, TransportOptions } from '@korajs/sync'
import { ProtobufMessageSerializer } from '@korajs/sync'

/**
 * A linked client/server transport pair, as consumed by {@link TestDevice}.
 */
export interface TransportPair {
	client: SyncTransport
	serverTransport: ServerTransport
}

/**
 * Message types the protobuf serializer models. Ephemeral messages
 * (awareness-update, yjs-doc-update) are JSON-only in the protocol, so they are
 * deep-copied instead of forced through the protobuf envelope.
 */
const PROTOBUF_WIRE_TYPES: ReadonlySet<SyncMessage['type']> = new Set([
	'handshake',
	'handshake-response',
	'operation-batch',
	'acknowledgment',
	'error',
])

/**
 * Round-trips a message through the real protobuf wire codec: object → protobuf
 * bytes → object. This is what makes a transport pair exercise the true wire
 * format rather than passing live object references between the two ends.
 */
function roundTripThroughProtobuf(
	message: SyncMessage,
	serializer: MessageSerializer,
): SyncMessage {
	if (!PROTOBUF_WIRE_TYPES.has(message.type)) {
		// Not part of the protobuf schema — still copy so no live reference leaks
		// across the "wire".
		return structuredClone(message)
	}

	const encoded = serializer.encode(message)
	if (!(encoded instanceof Uint8Array)) {
		throw new Error('Expected the protobuf serializer to encode to bytes')
	}
	return serializer.decode(encoded)
}

/**
 * Wraps a client transport so every outbound message crosses the protobuf wire.
 */
class ProtobufWireClientTransport implements SyncTransport {
	constructor(
		private readonly inner: SyncTransport,
		private readonly serializer: MessageSerializer,
	) {}

	connect(url: string, options?: TransportOptions): Promise<void> {
		return this.inner.connect(url, options)
	}

	disconnect(): Promise<void> {
		return this.inner.disconnect()
	}

	send(message: SyncMessage): void {
		this.inner.send(roundTripThroughProtobuf(message, this.serializer))
	}

	onMessage(handler: (message: SyncMessage) => void): void {
		this.inner.onMessage(handler)
	}

	onClose(handler: (reason: string) => void): void {
		this.inner.onClose(handler)
	}

	onError(handler: (error: Error) => void): void {
		this.inner.onError(handler)
	}

	isConnected(): boolean {
		return this.inner.isConnected()
	}
}

/**
 * Wraps a server transport so every outbound message crosses the protobuf wire.
 */
class ProtobufWireServerTransport implements ServerTransport {
	constructor(
		private readonly inner: ServerTransport,
		private readonly serializer: MessageSerializer,
	) {}

	send(message: SyncMessage): void {
		this.inner.send(roundTripThroughProtobuf(message, this.serializer))
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
 * Wraps a transport pair so that every sync message exchanged between the two
 * ends is encoded to protobuf bytes and decoded back — a faithful stand-in for
 * a real network hop that uses the protobuf wire format.
 *
 * Both directions are wrapped, so operations, handshakes, batches, and acks all
 * travel as bytes rather than shared object references.
 *
 * @param pair - The underlying (in-memory) transport pair to wrap
 * @returns A transport pair that routes messages through the protobuf codec
 */
export function wrapTransportPairWithProtobufWire(pair: TransportPair): TransportPair {
	const serializer = new ProtobufMessageSerializer()
	return {
		client: new ProtobufWireClientTransport(pair.client, serializer),
		serverTransport: new ProtobufWireServerTransport(pair.serverTransport, serializer),
	}
}
