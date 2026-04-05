import type { KoraEvent, KoraEventEmitter, KoraEventType } from '@korajs/core'
import { MessageBridge } from '../bridge/message-bridge'
import { EventBuffer } from '../buffer/event-buffer'
import type { DevtoolsConfig, TimestampedEvent } from '../types'

const DEFAULT_BUFFER_SIZE = 10_000
const DEFAULT_CHANNEL_NAME = 'kora-devtools'

/** All event types the instrumenter subscribes to */
const ALL_EVENT_TYPES: readonly KoraEventType[] = [
	'operation:created',
	'operation:applied',
	'merge:started',
	'merge:completed',
	'merge:conflict',
	'constraint:violated',
	'sync:connected',
	'sync:disconnected',
	'sync:sent',
	'sync:received',
	'sync:acknowledged',
	'query:subscribed',
	'query:invalidated',
	'query:executed',
	'connection:quality',
] as const

/**
 * Core orchestrator for Kora DevTools instrumentation.
 *
 * Attaches to a KoraEventEmitter, records all emitted events into a ring buffer
 * with sequential IDs and reception timestamps, and optionally forwards them
 * through a MessageBridge for consumption by a DevTools panel.
 *
 * @example
 * ```typescript
 * const instrumenter = new Instrumenter(app.emitter, { bufferSize: 5000 })
 * const buffer = instrumenter.getBuffer()
 * // ... later
 * instrumenter.destroy()
 * ```
 */
export class Instrumenter {
	private readonly buffer: EventBuffer
	private readonly bridge: MessageBridge | null
	private readonly unsubscribers: Array<() => void> = []
	private nextId = 1
	private paused = false
	private destroyed = false

	constructor(
		private readonly emitter: KoraEventEmitter,
		config?: DevtoolsConfig,
	) {
		const bufferSize = config?.bufferSize ?? DEFAULT_BUFFER_SIZE
		const bridgeEnabled = config?.bridgeEnabled ?? true
		const channelName = config?.channelName ?? DEFAULT_CHANNEL_NAME

		this.buffer = new EventBuffer(bufferSize)
		this.bridge = bridgeEnabled ? new MessageBridge(channelName) : null

		this.attachListeners()
	}

	/** Access the underlying event buffer */
	getBuffer(): EventBuffer {
		return this.buffer
	}

	/** Access the message bridge, or null if bridge is disabled */
	getBridge(): MessageBridge | null {
		return this.bridge
	}

	/** Temporarily stop recording events. Events emitted while paused are dropped. */
	pause(): void {
		this.paused = true
	}

	/** Resume recording events after a pause. */
	resume(): void {
		this.paused = false
	}

	/** Whether the instrumenter is currently paused */
	isPaused(): boolean {
		return this.paused
	}

	/**
	 * Detach all listeners from the emitter and destroy the bridge.
	 * After calling destroy, the instrumenter is inert.
	 */
	destroy(): void {
		if (this.destroyed) return
		this.destroyed = true

		for (const unsub of this.unsubscribers) {
			unsub()
		}
		this.unsubscribers.length = 0

		this.bridge?.destroy()
	}

	private attachListeners(): void {
		for (const eventType of ALL_EVENT_TYPES) {
			const unsub = this.emitter.on(eventType, (event: KoraEvent) => {
				this.handleEvent(event)
			})
			this.unsubscribers.push(unsub)
		}
	}

	private handleEvent(event: KoraEvent): void {
		if (this.paused || this.destroyed) return

		const timestamped: TimestampedEvent = {
			id: this.nextId++,
			event,
			receivedAt: Date.now(),
		}

		this.buffer.push(timestamped)
		this.bridge?.send(timestamped)
	}
}
