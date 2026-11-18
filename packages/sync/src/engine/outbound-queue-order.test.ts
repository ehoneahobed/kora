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
			{ numRuns: 300 },
		)
	})
})
