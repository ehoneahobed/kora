import type { Operation } from '@korajs/core'
import { topologicalSort } from '@korajs/core/internal'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { MemoryQueueStorage } from './memory-queue-storage'
import { OutboundQueue } from './outbound-queue'

/**
 * The outbound queue keeps its operations in causal order. A device that writes offline queues
 * one operation per write: keeping the order must not cost a full sort per write (10,000 writes
 * took ~11 s of main-thread time).
 */
function op(
	id: string,
	wallTime: number,
	deps: string[] = [],
	nodeId = 'device',
	logical = 0,
): Operation {
	return {
		id,
		nodeId,
		type: 'insert',
		collection: 'todos',
		recordId: `rec-${id}`,
		data: { title: id },
		previousData: null,
		timestamp: { wallTime, logical, nodeId },
		sequenceNumber: wallTime,
		causalDeps: deps,
		schemaVersion: 1,
	}
}

const queued = (queue: OutboundQueue): Operation[] =>
	(queue.takeBatch(Number.MAX_SAFE_INTEGER)?.operations ?? []) as Operation[]

describe('outbound queue order', () => {
	test('10,000 local writes queued one at a time take well under a second', async () => {
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()
		const started = performance.now()
		let previous: string | null = null
		for (let i = 0; i < 10_000; i++) {
			const id = `w${i}`
			await queue.enqueue(op(id, 1_000 + i, previous && i % 3 === 0 ? [previous] : []))
			previous = id
		}
		const elapsed = performance.now() - started
		expect(queue.size).toBe(10_000)
		expect(elapsed).toBeLessThan(1_000)
	})

	test('regression (CI seed -628581730): an operation later than the tail but not than the queue', async () => {
		// o6 (wallTime 1064) is queued before o4 and o1 arrive; o5 (1063) is later than the tail
		// then, but a full sort puts it before o6.
		const t = (wallTime: number, logical: number, nodeId: string) => ({ wallTime, logical, nodeId })
		const at = (id: string, ts: ReturnType<typeof t>, deps: string[]): Operation => ({
			...op(id, ts.wallTime, deps, ts.nodeId, ts.logical),
		})
		const ops = [
			at('o0', t(1033, 0, 'c'), []),
			at('o1', t(1023, 1, 'c'), ['o0']),
			at('o2', t(1070, 2, 'a'), ['o1']),
			at('o3', t(1060, 3, 'a'), ['o2']),
			at('o4', t(1049, 4, 'c'), ['o0']),
			at('o5', t(1063, 5, 'c'), ['o4']),
			at('o6', t(1064, 6, 'a'), ['o1']),
			at('o7', t(1095, 7, 'b'), []),
		]
		const byId = new Map(ops.map((o) => [o.id, o]))
		const arrival = ['o3', 'o0', 'o2', 'o6', 'o4', 'o1', 'o5', 'o7'].map(
			(id) => byId.get(id) as Operation,
		)
		const queue = new OutboundQueue(new MemoryQueueStorage())
		await queue.initialize()
		const cut = Math.floor((arrival.length * 3) / 4)
		for (const one of arrival.slice(0, cut)) await queue.enqueue(one)
		await queue.enqueueMany(arrival.slice(cut))
		expect(queued(queue).map((o) => o.id)).toEqual(topologicalSort(ops).map((o) => o.id))
	})

	test('property: any arrival order queues every operation once, in the canonical causal order', async () => {
		// A random DAG: each operation may depend on earlier ones (by creation), from a few nodes.
		const dagArb = fc
			.array(
				fc.record({
					deps: fc.array(fc.nat(), { maxLength: 3 }),
					node: fc.constantFrom('a', 'b', 'c'),
					time: fc.integer({ min: 0, max: 50 }),
				}),
				{ minLength: 1, maxLength: 25 },
			)
			.map((specs) =>
				specs.map((spec, i) => {
					const deps = i === 0 ? [] : [...new Set(spec.deps.map((d) => `o${d % i}`))]
					// Real timestamps never collide (HLC): the counter carries the index.
					return op(`o${i}`, 1_000 + i * 10 + spec.time, deps, spec.node, i)
				}),
			)
		await fc.assert(
			fc.asyncProperty(
				dagArb.chain((ops) =>
					fc.tuple(
						fc.constant(ops),
						fc.shuffledSubarray(ops, { minLength: ops.length, maxLength: ops.length }),
						fc.integer({ min: 0, max: 3 }),
					),
				),
				async ([ops, arrival, split]) => {
					const queue = new OutboundQueue(new MemoryQueueStorage())
					await queue.initialize()
					// Some arrive one at a time, some in batches, some twice.
					const cut = Math.floor((arrival.length * split) / 4)
					for (const one of arrival.slice(0, cut)) await queue.enqueue(one)
					await queue.enqueueMany(arrival.slice(cut))
					await queue.enqueue(arrival[0] as Operation)
					expect(queued(queue).map((o) => o.id)).toEqual(topologicalSort(ops).map((o) => o.id))
				},
			),
			{ numRuns: 1000 },
		)
	})
})
