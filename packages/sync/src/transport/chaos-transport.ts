import type { SyncMessage } from '../protocol/messages'
import type {
	SyncTransport,
	TransportCloseHandler,
	TransportErrorHandler,
	TransportMessageHandler,
	TransportOptions,
} from './transport'

/**
 * Configuration for the chaos transport.
 */
export interface ChaosConfig {
	/** Probability of dropping a message (0-1). Defaults to 0. */
	dropRate?: number
	/** Probability of duplicating a message (0-1). Defaults to 0. */
	duplicateRate?: number
	/** Probability of reordering messages (0-1). Defaults to 0. */
	reorderRate?: number
	/** Maximum latency in ms for delayed messages. Defaults to 0. */
	maxLatency?: number
	/** Injectable random source for deterministic testing. Returns value in [0, 1). */
	randomSource?: () => number
}

/**
 * Chaos transport that wraps another transport and injects faults.
 * Used for testing sync convergence under unreliable network conditions.
 *
 * Supports message dropping, duplication, reordering, and latency injection.
 * All random behavior is injectable for deterministic, reproducible tests.
 */
export class ChaosTransport implements SyncTransport {
	private readonly inner: SyncTransport
	private readonly dropRate: number
	private readonly duplicateRate: number
	private readonly reorderRate: number
	private readonly maxLatency: number
	private readonly random: () => number

	private messageHandler: TransportMessageHandler | null = null
	private reorderBuffer: SyncMessage[] = []
	private timers: ReturnType<typeof setTimeout>[] = []

	constructor(inner: SyncTransport, config?: ChaosConfig) {
		this.inner = inner
		this.dropRate = config?.dropRate ?? 0
		this.duplicateRate = config?.duplicateRate ?? 0
		this.reorderRate = config?.reorderRate ?? 0
		this.maxLatency = config?.maxLatency ?? 0
		this.random = config?.randomSource ?? Math.random
	}

	async connect(url: string, options?: TransportOptions): Promise<void> {
		// Intercept incoming messages from the inner transport
		this.inner.onMessage((msg) => this.handleIncoming(msg))
		return this.inner.connect(url, options)
	}

	async disconnect(): Promise<void> {
		// Flush reorder buffer
		this.flushReorderBuffer()
		// Clear pending timers
		for (const timer of this.timers) {
			clearTimeout(timer)
		}
		this.timers = []
		return this.inner.disconnect()
	}

	send(message: SyncMessage): void {
		// Apply chaos to outgoing messages
		if (this.random() < this.dropRate) {
			return // Dropped
		}

		if (this.random() < this.reorderRate) {
			this.reorderBuffer.push(message)
			// Flush buffer on next non-reordered send
			return
		}

		// Flush any buffered messages first
		this.flushReorderBuffer()

		this.inner.send(message)

		// Duplicate?
		if (this.random() < this.duplicateRate) {
			this.inner.send(message)
		}
	}

	onMessage(handler: TransportMessageHandler): void {
		this.messageHandler = handler
	}

	onClose(handler: TransportCloseHandler): void {
		this.inner.onClose(handler)
	}

	onError(handler: TransportErrorHandler): void {
		this.inner.onError(handler)
	}

	isConnected(): boolean {
		return this.inner.isConnected()
	}

	private handleIncoming(message: SyncMessage): void {
		if (!this.messageHandler) return

		// Apply chaos to incoming messages
		if (this.random() < this.dropRate) {
			return // Dropped
		}

		if (this.maxLatency > 0) {
			const delay = Math.floor(this.random() * this.maxLatency)
			const timer = setTimeout(() => {
				this.deliverIncoming(message)
			}, delay)
			this.timers.push(timer)
			return
		}

		this.deliverIncoming(message)
	}

	private deliverIncoming(message: SyncMessage): void {
		if (!this.messageHandler) return

		this.messageHandler(message)

		// Duplicate incoming?
		if (this.random() < this.duplicateRate) {
			this.messageHandler(message)
		}
	}

	private flushReorderBuffer(): void {
		// Send buffered messages in random order
		const buffer = [...this.reorderBuffer]
		this.reorderBuffer = []

		// Fisher-Yates shuffle with injectable random
		for (let i = buffer.length - 1; i > 0; i--) {
			const j = Math.floor(this.random() * (i + 1))
			const temp = buffer[i] as SyncMessage
			buffer[i] = buffer[j] as SyncMessage
			buffer[j] = temp
		}

		for (const msg of buffer) {
			this.inner.send(msg)
		}
	}
}
