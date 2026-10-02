import { describe, expect, test } from 'vitest'
import { createFoldState, foldRecord, materialize, mergeOp } from '../fold/fold'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { AtomicOp, Operation, SchemaDefinition } from '../types'

// Performance gates run via `pnpm --filter @korajs/core test:benchmarks`, not `pnpm test`.
const REGRESSION_FACTOR = 1.1
/** CLAUDE.md: merge 1,000 concurrent operations in under 500 ms. */
const MERGE_1K_LIMIT_MS = 500 * REGRESSION_FACTOR

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				done: t.boolean(),
				qty: t.number(),
				tags: t.array(t.string()),
				doc: t.json(),
				score: t.number().merge('counter'),
				stock: t.number(),
			},
			resolve: {
				stock: (l, r, b) => (l as number) + ((r as number) - (b as number)),
			},
		},
	},
}) as unknown as SchemaDefinition

function makeOp(
	node: string,
	wall: number,
	seq: number,
	type: Operation['type'],
	data: Record<string, unknown> | null,
	previousData: Record<string, unknown> | null,
	atomicOps?: Record<string, AtomicOp>,
): Operation {
	return {
		id: `${node}:${seq}`,
		nodeId: node,
		type,
		collection: 'items',
		recordId: 'r1',
		data,
		previousData,
		timestamp: { wallTime: wall, logical: 0, nodeId: node },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...(atomicOps ? { atomicOps } : {}),
	}
}

const BASE = {
	title: 'base',
	done: false,
	qty: 0,
	tags: ['base'],
	doc: { k: 0 },
	score: 0,
	stock: 100,
}

/** 1,000 concurrent updates from 1,000 nodes, all written against the same base. */
function concurrentOps(): Operation[] {
	const ops: Operation[] = []
	for (let i = 0; i < 1000; i++) {
		const node = `node-${String(i).padStart(4, '0')}`
		ops.push(
			makeOp(
				node,
				1_000 + (i % 37),
				1,
				'update',
				{
					title: `t${i}`,
					done: i % 2 === 0,
					qty: 1,
					tags: ['base', `tag-${i % 100}`],
					doc: { k: 0, [`key${i % 50}`]: i },
					score: 1,
					stock: 99,
				},
				BASE,
				{ qty: { type: 'increment', value: 1 } },
			),
		)
	}
	return ops
}

/** Deterministic Fisher-Yates so the arrival order is scrambled but reproducible. */
function scramble<T>(items: T[]): T[] {
	const out = [...items]
	let seed = 42
	for (let i = out.length - 1; i > 0; i--) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		const j = seed % (i + 1)
		const tmp = out[i] as T
		out[i] = out[j] as T
		out[j] = tmp
	}
	return out
}

function elapsed(fn: () => void): number {
	const start = performance.now()
	fn()
	return performance.now() - start
}

describe('fold performance gates', () => {
	const insert = makeOp('origin', 1, 1, 'insert', BASE, null)
	const ops = scramble(concurrentOps())

	test('mergeOp: 1,000 concurrent operations in scrambled order under 500 ms (with traces)', () => {
		// Warm-up so the gate measures steady-state code, not JIT compilation.
		let warm = createFoldState('items', 'r1')
		for (const op of [insert, ...ops.slice(0, 200)]) warm = mergeOp(warm, op, schema).state

		let state = createFoldState('items', 'r1')
		let traceCount = 0
		const ms = elapsed(() => {
			state = mergeOp(state, insert, schema).state
			for (const op of ops) {
				const result = mergeOp(state, op, schema)
				state = result.state
				traceCount += result.traces.length
			}
		})
		console.log(
			`[fold bench] mergeOp x1000 concurrent (traces=conflicts): ${ms.toFixed(1)} ms, ${traceCount} traces`,
		)
		expect(materialize(state)?.qty).toBe(1000)
		expect(materialize(state)?.score).toBe(1000)
		expect(materialize(state)?.stock).toBe(-900)
		expect(ms).toBeLessThan(MERGE_1K_LIMIT_MS)
	})

	test('foldRecord: 1,000 concurrent operations from scratch under 500 ms', () => {
		const ms = elapsed(() => {
			foldRecord([insert, ...ops], schema)
		})
		console.log(`[fold bench] foldRecord x1000 concurrent (no traces): ${ms.toFixed(1)} ms`)
		expect(ms).toBeLessThan(MERGE_1K_LIMIT_MS)
	})

	test('incremental cost is independent of record history length (SRV-7)', () => {
		const history = (length: number): ReturnType<typeof createFoldState> => {
			let state = mergeOp(createFoldState('items', 'r1'), insert, schema).state
			for (let i = 0; i < length; i++) {
				state = mergeOp(
					state,
					makeOp('writer', 10 + i, i + 2, 'update', { title: `v${i}` }, { title: `v${i - 1}` }),
					schema,
					{ traces: 'none' },
				).state
			}
			return state
		}
		const measure = (state: ReturnType<typeof createFoldState>, start: number): number => {
			let s = state
			return elapsed(() => {
				for (let i = 0; i < 2000; i++) {
					s = mergeOp(
						s,
						makeOp(
							'late',
							start + i,
							i + 1,
							'update',
							{ title: `n${i}`, done: i % 2 === 0 },
							{
								title: 'x',
								done: true,
							},
						),
						schema,
						{ traces: 'none' },
					).state
				}
			})
		}
		const short = history(10)
		const long = history(20_000)
		measure(short, 100_000)
		const shortMs = measure(short, 100_000)
		const longMs = measure(long, 100_000)
		console.log(
			`[fold bench] 2,000 merges on a 10-op record: ${shortMs.toFixed(1)} ms; on a 20,000-op record: ${longMs.toFixed(1)} ms`,
		)
		expect(longMs).toBeLessThan(Math.max(shortMs * 3, 50))
	})
})
