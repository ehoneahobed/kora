import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { atomicOpsViolation } from './atomic-op-validation'

function op(overrides: Partial<Operation>): Operation {
	return {
		id: 'op-1',
		nodeId: 'n',
		type: 'update',
		collection: 'c',
		recordId: 'r',
		data: {},
		previousData: {},
		timestamp: { wallTime: 1, logical: 0, nodeId: 'n' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('atomicOpsViolation', () => {
	test('accepts what Kora writers produce', () => {
		expect(atomicOpsViolation(op({}))).toBeNull()
		expect(
			atomicOpsViolation(
				op({
					data: { n: 6, tags: ['a', 'b'], hi: 9, lo: 1 },
					previousData: { n: 5, tags: ['a'], hi: 3, lo: 4 },
					atomicOps: {
						n: { type: 'increment', value: 1 },
						tags: { type: 'append', value: 'b' },
						hi: { type: 'max', value: 9 },
						lo: { type: 'min', value: 1 },
					},
				}),
			),
		).toBeNull()
		// A field the base did not hold: the intent applied to unset.
		expect(
			atomicOpsViolation(
				op({ data: { n: 2 }, previousData: {}, atomicOps: { n: { type: 'increment', value: 2 } } }),
			),
		).toBeNull()
		expect(
			atomicOpsViolation(
				op({
					type: 'insert',
					previousData: null,
					data: { tags: ['x'] },
					atomicOps: { tags: { type: 'append', value: 'x' } },
				}),
			),
		).toBeNull()
	})

	test('refuses unknown types, bad operands and intents without a written field', () => {
		const bad = [
			op({ data: { n: 1 }, atomicOps: { n: { type: 'bogus', value: 1 } as never } }),
			op({ data: { n: 1 }, atomicOps: { n: { type: 'increment', value: '1' } as never } }),
			op({ data: { n: 1 }, atomicOps: { n: { type: 'max', value: Number.NaN } } }),
			op({ data: { n: 1 }, atomicOps: { n: { type: 'append' } as never } }),
			op({ data: { n: 1 }, atomicOps: { n: null } as never }),
			op({ data: {}, atomicOps: { n: { type: 'increment', value: 1 } } }),
			op({ type: 'delete', data: null, atomicOps: { n: { type: 'increment', value: 1 } } }),
			op({ data: { n: 1 }, atomicOps: [] as never }),
		]
		for (const candidate of bad) expect(atomicOpsViolation(candidate)).not.toBeNull()
	})

	test('refuses data that disagrees with its intent', () => {
		expect(
			atomicOpsViolation(
				op({
					type: 'insert',
					previousData: null,
					data: { credits: 1_000_000 },
					atomicOps: { credits: { type: 'increment', value: 0 } },
				}),
			),
		).toContain('agree')
		expect(
			atomicOpsViolation(
				op({
					data: { credits: 1_000_000 },
					previousData: { credits: 0 },
					atomicOps: { credits: { type: 'increment', value: 0 } },
				}),
			),
		).toContain('agree')
	})
})
