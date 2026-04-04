import type { KoraEventType } from '@kora/core'
import type { TimestampedEvent } from '../types'

const DEFAULT_CAPACITY = 10_000

/**
 * Fixed-capacity ring buffer for storing timestamped events.
 * When the buffer is full, the oldest events are evicted to make room for new ones.
 * This prevents unbounded memory growth when events accumulate fast.
 */
export class EventBuffer {
	private readonly _capacity: number
	private readonly buffer: Array<TimestampedEvent | undefined>
	/** Index where the next event will be written */
	private head = 0
	/** Total number of events ever pushed (used to compute readable range) */
	private _totalPushed = 0

	constructor(capacity: number = DEFAULT_CAPACITY) {
		if (capacity < 1) {
			throw new Error('EventBuffer capacity must be at least 1')
		}
		this._capacity = capacity
		this.buffer = new Array<TimestampedEvent | undefined>(capacity)
	}

	/** Maximum number of events the buffer can hold */
	get capacity(): number {
		return this._capacity
	}

	/** Current number of events in the buffer */
	get size(): number {
		return Math.min(this._totalPushed, this._capacity)
	}

	/**
	 * Append an event to the buffer.
	 * If the buffer is at capacity, the oldest event is evicted.
	 */
	push(event: TimestampedEvent): void {
		this.buffer[this.head] = event
		this.head = (this.head + 1) % this._capacity
		this._totalPushed++
	}

	/**
	 * Returns all events in insertion order (oldest first).
	 */
	getAll(): readonly TimestampedEvent[] {
		if (this._totalPushed === 0) return []

		const result: TimestampedEvent[] = []

		if (this._totalPushed <= this._capacity) {
			// Buffer hasn't wrapped yet — events are 0..head-1
			for (let i = 0; i < this.head; i++) {
				const event = this.buffer[i]
				if (event) result.push(event)
			}
		} else {
			// Buffer has wrapped — oldest is at head, newest is at head-1
			for (let i = 0; i < this._capacity; i++) {
				const index = (this.head + i) % this._capacity
				const event = this.buffer[index]
				if (event) result.push(event)
			}
		}

		return result
	}

	/**
	 * Returns events whose sequential IDs fall within [start, end] (inclusive).
	 */
	getRange(start: number, end: number): readonly TimestampedEvent[] {
		return this.getAll().filter((e) => e.id >= start && e.id <= end)
	}

	/**
	 * Returns events matching a specific KoraEventType.
	 */
	getByType(type: KoraEventType): readonly TimestampedEvent[] {
		return this.getAll().filter((e) => e.event.type === type)
	}

	/** Remove all events from the buffer */
	clear(): void {
		this.buffer.fill(undefined)
		this.head = 0
		this._totalPushed = 0
	}
}
