import type { AtomicOp, FieldDescriptor, Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { mergeField } from '../../src/engine/field-merger'
import { MergeEngine } from '../../src/engine/merge-engine'

function makeOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-a',
		type: 'update',
		collection: 'stock',
		recordId: 'rec-1',
		data: {},
		previousData: {},
		timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

const numberField: FieldDescriptor = {
	kind: 'number',
	required: true,
	defaultValue: 0,
	auto: false,
	enumValues: null,
	itemKind: null,
	mergeStrategy: null,
	transitions: null,
}

const arrayField: FieldDescriptor = {
	kind: 'array',
	required: false,
	defaultValue: [],
	auto: false,
	enumValues: null,
	itemKind: 'string',
	mergeStrategy: null,
	transitions: null,
}

describe('atomic ops in field-merger', () => {
	test('concurrent increments compose (sum of deltas)', () => {
		const localOp = makeOp({
			id: 'op-local',
			nodeId: 'node-a',
			data: { quantity: 13 }, // base=10, increment(+3) → 13
			previousData: { quantity: 10 },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			atomicOps: { quantity: { type: 'increment', value: 3 } },
		})
		const remoteOp = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { quantity: 15 }, // base=10, increment(+5) → 15
			previousData: { quantity: 10 },
			timestamp: { wallTime: 1001, logical: 0, nodeId: 'node-b' },
			atomicOps: { quantity: { type: 'increment', value: 5 } },
		})

		const result = mergeField('quantity', localOp, remoteOp, { quantity: 10 }, numberField)

		// Should compose: 10 + 3 + 5 = 18, not LWW(13, 15) = 15
		expect(result.value).toBe(18)
		expect(result.trace.strategy).toBe('atomic-increment')
	})

	test('concurrent decrements compose correctly', () => {
		const localOp = makeOp({
			id: 'op-local',
			data: { quantity: 8 }, // base=10, increment(-2) → 8
			previousData: { quantity: 10 },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			atomicOps: { quantity: { type: 'increment', value: -2 } },
		})
		const remoteOp = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { quantity: 7 }, // base=10, increment(-3) → 7
			previousData: { quantity: 10 },
			timestamp: { wallTime: 1001, logical: 0, nodeId: 'node-b' },
			atomicOps: { quantity: { type: 'increment', value: -3 } },
		})

		const result = mergeField('quantity', localOp, remoteOp, { quantity: 10 }, numberField)
		expect(result.value).toBe(5) // 10 + (-2) + (-3) = 5
	})

	test('concurrent max ops take the maximum', () => {
		const localOp = makeOp({
			id: 'op-local',
			data: { highScore: 150 },
			previousData: { highScore: 100 },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			atomicOps: { highScore: { type: 'max', value: 150 } },
		})
		const remoteOp = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { highScore: 200 },
			previousData: { highScore: 100 },
			timestamp: { wallTime: 1001, logical: 0, nodeId: 'node-b' },
			atomicOps: { highScore: { type: 'max', value: 200 } },
		})

		const result = mergeField('highScore', localOp, remoteOp, { highScore: 100 }, numberField)
		expect(result.value).toBe(200)
		expect(result.trace.strategy).toBe('atomic-max')
	})

	test('concurrent min ops take the minimum', () => {
		const localOp = makeOp({
			id: 'op-local',
			data: { minPrice: 8 },
			previousData: { minPrice: 10 },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			atomicOps: { minPrice: { type: 'min', value: 8 } },
		})
		const remoteOp = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { minPrice: 5 },
			previousData: { minPrice: 10 },
			timestamp: { wallTime: 1001, logical: 0, nodeId: 'node-b' },
			atomicOps: { minPrice: { type: 'min', value: 5 } },
		})

		const result = mergeField('minPrice', localOp, remoteOp, { minPrice: 10 }, numberField)
		expect(result.value).toBe(5)
		expect(result.trace.strategy).toBe('atomic-min')
	})

	test('falls back to LWW when only one side uses atomic ops', () => {
		const localOp = makeOp({
			id: 'op-local',
			data: { quantity: 13 },
			previousData: { quantity: 10 },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			atomicOps: { quantity: { type: 'increment', value: 3 } },
		})
		const remoteOp = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { quantity: 50 }, // Regular update, not atomic
			previousData: { quantity: 10 },
			timestamp: { wallTime: 1001, logical: 0, nodeId: 'node-b' },
			// No atomicOps
		})

		const result = mergeField('quantity', localOp, remoteOp, { quantity: 10 }, numberField)
		// Remote is later (wallTime 1001 > 1000), so LWW picks remote = 50
		expect(result.value).toBe(50)
		expect(result.trace.strategy).toBe('lww')
	})

	test('falls back to LWW when atomic op types differ', () => {
		const localOp = makeOp({
			id: 'op-local',
			data: { score: 15 },
			previousData: { score: 10 },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			atomicOps: { score: { type: 'increment', value: 5 } },
		})
		const remoteOp = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { score: 50 },
			previousData: { score: 10 },
			timestamp: { wallTime: 1001, logical: 0, nodeId: 'node-b' },
			atomicOps: { score: { type: 'max', value: 50 } },
		})

		const result = mergeField('score', localOp, remoteOp, { score: 10 }, numberField)
		// Mismatched types → fallback to LWW → remote wins (later timestamp)
		expect(result.value).toBe(50)
		expect(result.trace.strategy).toBe('lww')
	})

	test('custom resolver (Tier 3) takes precedence over atomic ops', () => {
		const localOp = makeOp({
			id: 'op-local',
			data: { quantity: 13 },
			previousData: { quantity: 10 },
			atomicOps: { quantity: { type: 'increment', value: 3 } },
		})
		const remoteOp = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { quantity: 15 },
			previousData: { quantity: 10 },
			atomicOps: { quantity: { type: 'increment', value: 5 } },
		})

		const customResolver = (local: unknown, remote: unknown, base: unknown) => {
			return 999 // Custom resolver always returns 999
		}

		const result = mergeField(
			'quantity',
			localOp,
			remoteOp,
			{ quantity: 10 },
			numberField,
			customResolver,
		)
		expect(result.value).toBe(999)
		expect(result.trace.strategy).toBe('custom')
		expect(result.trace.tier).toBe(3)
	})
})

describe('atomic ops in MergeEngine', () => {
	const engine = new MergeEngine()

	test('concurrent increment ops merge correctly across multiple fields', async () => {
		const collectionDef = {
			fields: {
				cashTotal: numberField,
				salesCount: numberField,
			},
			indexes: [],
			constraints: [],
			resolvers: {},
			scope: [],
		}

		const localOp = makeOp({
			id: 'op-local',
			data: { cashTotal: 110, salesCount: 6 },
			previousData: { cashTotal: 100, salesCount: 5 },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			atomicOps: {
				cashTotal: { type: 'increment', value: 10 },
				salesCount: { type: 'increment', value: 1 },
			},
		})
		const remoteOp = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { cashTotal: 125, salesCount: 6 },
			previousData: { cashTotal: 100, salesCount: 5 },
			timestamp: { wallTime: 1001, logical: 0, nodeId: 'node-b' },
			atomicOps: {
				cashTotal: { type: 'increment', value: 25 },
				salesCount: { type: 'increment', value: 1 },
			},
		})

		const result = await engine.merge({
			local: localOp,
			remote: remoteOp,
			baseState: { cashTotal: 100, salesCount: 5 },
			collectionDef,
		})

		expect(result.mergedData.cashTotal).toBe(135) // 100 + 10 + 25
		expect(result.mergedData.salesCount).toBe(7) // 5 + 1 + 1
	})

	test('mixed atomic and non-atomic fields merge correctly', async () => {
		const stringField: FieldDescriptor = {
			kind: 'string',
			required: true,
			defaultValue: '',
			auto: false,
			enumValues: null,
			itemKind: null,
			mergeStrategy: null,
			transitions: null,
		}

		const collectionDef = {
			fields: {
				quantity: numberField,
				name: stringField,
			},
			indexes: [],
			constraints: [],
			resolvers: {},
			scope: [],
		}

		const localOp = makeOp({
			id: 'op-local',
			data: { quantity: 8 },
			previousData: { quantity: 10 },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			atomicOps: { quantity: { type: 'increment', value: -2 } },
		})
		const remoteOp = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { name: 'Widget Pro' },
			previousData: { name: 'Widget' },
			timestamp: { wallTime: 1001, logical: 0, nodeId: 'node-b' },
		})

		const result = await engine.merge({
			local: localOp,
			remote: remoteOp,
			baseState: { quantity: 10, name: 'Widget' },
			collectionDef,
		})

		// quantity: only local changed → no-conflict, takes local value (8)
		expect(result.mergedData.quantity).toBe(8)
		// name: only remote changed → no-conflict, takes remote value
		expect(result.mergedData.name).toBe('Widget Pro')
	})

	test('increment merge is commutative', async () => {
		const collectionDef = {
			fields: { quantity: numberField },
			indexes: [],
			constraints: [],
			resolvers: {},
			scope: [],
		}

		const opA = makeOp({
			id: 'op-a',
			nodeId: 'node-a',
			data: { quantity: 13 },
			previousData: { quantity: 10 },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			atomicOps: { quantity: { type: 'increment', value: 3 } },
		})
		const opB = makeOp({
			id: 'op-b',
			nodeId: 'node-b',
			data: { quantity: 15 },
			previousData: { quantity: 10 },
			timestamp: { wallTime: 1001, logical: 0, nodeId: 'node-b' },
			atomicOps: { quantity: { type: 'increment', value: 5 } },
		})

		const resultAB = await engine.merge({
			local: opA,
			remote: opB,
			baseState: { quantity: 10 },
			collectionDef,
		})
		const resultBA = await engine.merge({
			local: opB,
			remote: opA,
			baseState: { quantity: 10 },
			collectionDef,
		})

		expect(resultAB.mergedData.quantity).toBe(resultBA.mergedData.quantity)
		expect(resultAB.mergedData.quantity).toBe(18)
	})
})
