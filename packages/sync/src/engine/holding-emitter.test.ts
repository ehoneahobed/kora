import type { KoraEvent, KoraEventEmitter, Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { HoldingEmitter, MAX_HELD_EVENTS, MAX_HELD_OPERATIONS } from './holding-emitter'

class Recorder implements KoraEventEmitter {
	readonly seen: KoraEvent[] = []
	on(): () => void {
		return () => undefined
	}
	off(): void {}
	emit(event: KoraEvent): void {
		this.seen.push(event)
	}
}

function received(count: number): KoraEvent {
	const operations = Array.from({ length: count }, (_, index) => ({ id: `o${index}` }) as Operation)
	return { type: 'sync:received', operations, batchSize: count }
}

describe('HoldingEmitter', () => {
	test('holds delivery events while asked to and publishes them in order on release', () => {
		const inner = new Recorder()
		let holding = true
		const emitter = new HoldingEmitter(inner, () => holding)
		emitter.emit(received(2))
		emitter.emit({ type: 'sync:acknowledged', sequenceNumber: 1 })
		emitter.emit({ type: 'sync:connected', nodeId: 'n' })
		expect(inner.seen.map((event) => event.type)).toEqual(['sync:connected'])
		holding = false
		expect(emitter.release()).toEqual({ summarized: 0, dropped: 0 })
		expect(inner.seen.map((event) => event.type)).toEqual([
			'sync:connected',
			'sync:received',
			'sync:acknowledged',
		])
		expect(emitter.heldCount).toBe(0)
	})

	test('discard forgets what was held and its counts', () => {
		const inner = new Recorder()
		const emitter = new HoldingEmitter(inner, () => true)
		emitter.emit(received(MAX_HELD_OPERATIONS + 1))
		emitter.discard()
		expect(emitter.heldCount).toBe(0)
		expect(emitter.release()).toEqual({ summarized: 0, dropped: 0 })
		expect(inner.seen).toEqual([])
	})

	test('operations kept across held sync:received events are bounded; the rest are held as counted summaries', () => {
		const inner = new Recorder()
		const emitter = new HoldingEmitter(inner, () => true)
		const batches = 5
		const size = MAX_HELD_OPERATIONS / 2
		for (let index = 0; index < batches; index++) emitter.emit(received(size))
		const counts = emitter.release()
		const events = inner.seen as Array<Extract<KoraEvent, { type: 'sync:received' }>>
		expect(events).toHaveLength(batches)
		// Two batches fit whole; the others keep their batchSize and drop the operations.
		expect(events.map((event) => event.operations.length)).toEqual([size, size, 0, 0, 0])
		expect(events.map((event) => event.batchSize)).toEqual(Array(batches).fill(size))
		expect(counts).toEqual({ summarized: 3, dropped: 0 })
	})

	test('events past the held-event cap are counted, never silently lost', () => {
		const inner = new Recorder()
		const emitter = new HoldingEmitter(inner, () => true)
		for (let index = 0; index < MAX_HELD_EVENTS + 7; index++) {
			emitter.emit({ type: 'sync:acknowledged', sequenceNumber: index })
		}
		expect(emitter.heldCount).toBe(MAX_HELD_EVENTS)
		const counts = emitter.release()
		expect(counts).toEqual({ summarized: 0, dropped: 7 })
		expect(inner.seen).toHaveLength(MAX_HELD_EVENTS)
	})

	test('a throwing listener does not stop the rest from being published', () => {
		const seen: string[] = []
		const inner: KoraEventEmitter = {
			on: () => () => undefined,
			off: () => undefined,
			emit: (event) => {
				if (event.type === 'sync:acknowledged') throw new Error('listener failed')
				seen.push(event.type)
			},
		}
		const emitter = new HoldingEmitter(inner, () => true)
		emitter.emit({ type: 'sync:acknowledged', sequenceNumber: 1 })
		emitter.emit(received(1))
		emitter.release()
		expect(seen).toEqual(['sync:received'])
	})
})
