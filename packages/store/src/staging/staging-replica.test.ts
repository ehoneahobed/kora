import type { KoraEvent, KoraEventEmitter } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { ReplicaEventBuffer } from './staging-replica'

class Recorder implements KoraEventEmitter {
	readonly seen: KoraEvent[] = []
	throwOn: string | null = null
	on(): () => void {
		return () => undefined
	}
	off(): void {}
	emit(event: KoraEvent): void {
		if (this.throwOn === event.type) throw new Error('listener failed')
		this.seen.push(event)
	}
}

function applied(index: number): KoraEvent {
	return {
		type: 'operation:applied',
		operation: {
			id: `op-${index}`,
			collection: 'lessons',
			recordId: `r${index}`,
		} as never,
		duration: 0,
	}
}

function trace(index: number): KoraEvent {
	return {
		type: 'merge:completed',
		trace: { operationA: { collection: 'lessons', recordId: `r${index}` } } as never,
	}
}

describe('ReplicaEventBuffer', () => {
	test('replays what it kept in order, after the merge', async () => {
		const live = new Recorder()
		const buffer = new ReplicaEventBuffer(live)
		buffer.emit(applied(1))
		buffer.emit(trace(1))
		buffer.emit(applied(2))
		expect(live.seen).toEqual([])
		const flushed = await buffer.flush()
		expect(live.seen.map((event) => event.type)).toEqual([
			'operation:applied',
			'merge:completed',
			'operation:applied',
		])
		expect(flushed).toEqual({ summarized: {}, listenerErrors: 0 })
	})

	test('above the cap applies are counted by type, and merge events are never displaced by them', async () => {
		const live = new Recorder()
		const buffer = new ReplicaEventBuffer(live)
		for (let i = 0; i < 30_000; i++) buffer.emit(applied(i))
		for (let i = 0; i < 100; i++) buffer.emit(trace(i))
		const flushed = await buffer.flush()
		expect(live.seen.filter((event) => event.type === 'merge:completed')).toHaveLength(100)
		expect(live.seen.filter((event) => event.type === 'operation:applied')).toHaveLength(20_000)
		expect(flushed.summarized).toEqual({ 'operation:applied': 10_000 })
	})

	test('merge events past their own budget are counted too, never silently dropped', async () => {
		const live = new Recorder()
		const buffer = new ReplicaEventBuffer(live)
		for (let i = 0; i < 50_005; i++) buffer.emit(trace(i))
		const flushed = await buffer.flush()
		expect(live.seen).toHaveLength(50_000)
		expect(flushed.summarized).toEqual({ 'merge:completed': 5 })
	})

	test('a throwing listener is caught and counted; the rest are still delivered', async () => {
		const live = new Recorder()
		live.throwOn = 'merge:completed'
		const buffer = new ReplicaEventBuffer(live)
		buffer.emit(applied(1))
		buffer.emit(trace(1))
		buffer.emit(applied(2))
		const flushed = await buffer.flush()
		expect(flushed.listenerErrors).toBe(1)
		expect(live.seen.map((event) => event.type)).toEqual(['operation:applied', 'operation:applied'])
	})

	test('flush(only) replays just the records the unfinished merge made live', async () => {
		const live = new Recorder()
		const buffer = new ReplicaEventBuffer(live)
		for (let i = 0; i < 4; i++) buffer.emit(applied(i))
		buffer.emit({ type: 'sync:connected', nodeId: 'x' } as never)
		await buffer.flush((key) => key === 'lessons\u0000r1' || key === 'lessons\u0000r3')
		expect(
			live.seen.map((event) => (event as { operation?: { recordId: string } }).operation?.recordId),
		).toEqual(['r1', 'r3'])
	})

	test('a storage failure of the replica is reported at once, query events are not kept', async () => {
		const live = new Recorder()
		const buffer = new ReplicaEventBuffer(live)
		buffer.emit({
			type: 'store:persistence-error',
			dbName: 'x',
			message: 'm',
			code: 'C',
		} as never)
		buffer.emit({ type: 'query:invalidated', queryId: 'q', trigger: {} } as never)
		expect(live.seen.map((event) => event.type)).toEqual(['store:persistence-error'])
		await buffer.flush()
		expect(live.seen).toHaveLength(1)
	})
})
