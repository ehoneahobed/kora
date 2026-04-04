import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { computeOperationId } from '../../src/operations/content-hash'
import type { OperationInput } from '../../src/types'

const operationInputArb: fc.Arbitrary<OperationInput> = fc.record({
	nodeId: fc.stringMatching(/^[a-z0-9]{4,8}$/),
	type: fc.constant('insert' as const),
	collection: fc.stringMatching(/^[a-z]{3,8}$/),
	recordId: fc.stringMatching(/^[a-z0-9]{8}$/),
	data: fc.dictionary(
		fc.stringMatching(/^[a-z]{1,4}$/),
		fc.oneof(fc.string(), fc.integer(), fc.boolean()),
		{ maxKeys: 5 },
	),
	previousData: fc.constant(null),
	sequenceNumber: fc.nat({ max: 10000 }),
	causalDeps: fc.array(fc.stringMatching(/^[a-z0-9]{8}$/), { maxLength: 3 }),
	schemaVersion: fc.integer({ min: 1, max: 10 }),
})

const timestampStringArb = fc.stringMatching(/^[0-9]{15}:[0-9]{5}:[a-z0-9]{4,8}$/)

describe('Operation property-based tests', () => {
	test('content-addressing is deterministic', async () => {
		await fc.assert(
			fc.asyncProperty(operationInputArb, timestampStringArb, async (input, ts) => {
				const id1 = await computeOperationId(input, ts)
				const id2 = await computeOperationId(input, ts)
				expect(id1).toBe(id2)
			}),
			{ numRuns: 50 },
		)
	})

	test('different inputs produce different hashes', async () => {
		await fc.assert(
			fc.asyncProperty(
				operationInputArb,
				operationInputArb,
				timestampStringArb,
				async (input1, input2, ts) => {
					if (JSON.stringify(input1) === JSON.stringify(input2)) return
					const id1 = await computeOperationId(input1, ts)
					const id2 = await computeOperationId(input2, ts)
					expect(id1).not.toBe(id2)
				},
			),
			{ numRuns: 50 },
		)
	})

	test('content hash is always a 64-char hex string', async () => {
		await fc.assert(
			fc.asyncProperty(operationInputArb, timestampStringArb, async (input, ts) => {
				const id = await computeOperationId(input, ts)
				expect(id).toMatch(/^[0-9a-f]{64}$/)
			}),
			{ numRuns: 50 },
		)
	})
})
