import type { CollectionDefinition, Constraint, Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MergeEngine } from '../../src/engine/merge-engine'
import type { ConstraintContext } from '../../src/types'

function makeOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-a',
		type: 'update',
		collection: 'items',
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

function makeContext(records: Record<string, Record<string, unknown>[]> = {}): ConstraintContext {
	return {
		async queryRecords(collection: string, where: Record<string, unknown>) {
			const collRecords = records[collection] ?? []
			return collRecords.filter((r) => {
				for (const [key, val] of Object.entries(where)) {
					if (r[key] !== val) return false
				}
				return true
			})
		},
		async countRecords(collection: string, where: Record<string, unknown>) {
			const collRecords = records[collection] ?? []
			return collRecords.filter((r) => {
				for (const [key, val] of Object.entries(where)) {
					if (r[key] !== val) return false
				}
				return true
			}).length
		},
	}
}

const engine = new MergeEngine()

describe('three-tier merge integration', () => {
	test('full flow: Tier 1 auto-merge → Tier 2 unique constraint → resolution', async () => {
		const constraint: Constraint = {
			type: 'unique',
			fields: ['email'],
			onConflict: 'first-write-wins',
		}

		const collDef: CollectionDefinition = {
			fields: {
				name: {
					kind: 'string',
					required: true,
					defaultValue: '',
					auto: false,
					enumValues: null,
					itemKind: null,
				},
				email: {
					kind: 'string',
					required: true,
					defaultValue: '',
					auto: false,
					enumValues: null,
					itemKind: null,
				},
				active: {
					kind: 'boolean',
					required: true,
					defaultValue: true,
					auto: false,
					enumValues: null,
					itemKind: null,
				},
			},
			indexes: ['email'],
			constraints: [constraint],
			resolvers: {},
		}

		const local = makeOp({
			id: 'op-local',
			nodeId: 'node-a',
			data: { name: 'Alice Updated', email: 'duplicate@example.com' },
			previousData: { name: 'Alice', email: 'alice@example.com' },
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
		})
		const remote = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { name: 'Bob Updated', email: 'duplicate@example.com' },
			previousData: { name: 'Bob', email: 'bob@example.com' },
			timestamp: { wallTime: 1500, logical: 0, nodeId: 'node-b' },
		})

		// Another record already has this email
		const ctx = makeContext({
			items: [{ id: 'rec-2', email: 'duplicate@example.com', name: 'Existing' }],
		})

		const result = await engine.merge(
			{
				local,
				remote,
				baseState: { name: 'Alice', email: 'alice@example.com', active: true },
				collectionDef: collDef,
			},
			ctx,
		)

		// Tier 1: name conflicted → LWW → local wins (later timestamp)
		// Tier 1: email conflicted → LWW → local wins (later timestamp)
		// Tier 2: unique constraint on email violated → first-write-wins → remote (earlier) wins
		expect(result.mergedData.name).toBe('Alice Updated') // Tier 1 LWW
		expect(result.mergedData.email).toBe('duplicate@example.com') // FWW resolves to remote's email

		// Verify traces contain both tiers
		const tier1Traces = result.traces.filter((t) => t.tier === 1)
		const tier2Traces = result.traces.filter((t) => t.tier === 2)
		expect(tier1Traces.length).toBeGreaterThan(0)
		expect(tier2Traces.length).toBeGreaterThan(0)
	})

	test('Tier 3 custom resolver overrides LWW for specific field', async () => {
		const collDef: CollectionDefinition = {
			fields: {
				productId: {
					kind: 'string',
					required: true,
					defaultValue: '',
					auto: false,
					enumValues: null,
					itemKind: null,
				},
				quantity: {
					kind: 'number',
					required: true,
					defaultValue: 0,
					auto: false,
					enumValues: null,
					itemKind: null,
				},
				name: {
					kind: 'string',
					required: true,
					defaultValue: '',
					auto: false,
					enumValues: null,
					itemKind: null,
				},
			},
			indexes: [],
			constraints: [],
			resolvers: {
				quantity: (local: unknown, remote: unknown, base: unknown): unknown => {
					const l = local as number
					const r = remote as number
					const b = base as number
					return Math.max(0, b + (l - b) + (r - b))
				},
			},
		}

		const local = makeOp({
			data: { name: 'Widget Updated', quantity: 8 },
			previousData: { name: 'Widget', quantity: 10 },
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
		})
		const remote = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { name: 'Gadget', quantity: 7 },
			previousData: { name: 'Widget', quantity: 10 },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
		})

		const result = await engine.merge({
			local,
			remote,
			baseState: { productId: 'prod-1', name: 'Widget', quantity: 10 },
			collectionDef: collDef,
		})

		// name: both changed → LWW → local wins (later timestamp)
		expect(result.mergedData.name).toBe('Widget Updated')
		// quantity: both changed → custom resolver (additive merge)
		// base=10, local=8 (delta -2), remote=7 (delta -3) → 10 - 2 - 3 = 5
		expect(result.mergedData.quantity).toBe(5)

		// Verify trace types
		const lwwTraces = result.traces.filter((t) => t.strategy === 'lww')
		const customTraces = result.traces.filter((t) => t.strategy === 'custom')
		expect(lwwTraces).toHaveLength(1)
		expect(customTraces).toHaveLength(1)
		expect(customTraces[0]?.tier).toBe(3)
	})

	test('update vs delete conflict resolution', async () => {
		const collDef: CollectionDefinition = {
			fields: {
				title: {
					kind: 'string',
					required: true,
					defaultValue: '',
					auto: false,
					enumValues: null,
					itemKind: null,
				},
			},
			indexes: [],
			constraints: [],
			resolvers: {},
		}

		// Local updates, remote deletes (remote is later → delete wins)
		const local = makeOp({
			type: 'update',
			data: { title: 'updated' },
			previousData: { title: 'base' },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
		})
		const remote = makeOp({
			id: 'op-remote',
			type: 'delete',
			nodeId: 'node-b',
			data: null,
			previousData: null,
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-b' },
		})

		const result = await engine.merge({
			local,
			remote,
			baseState: { title: 'base' },
			collectionDef: collDef,
		})

		expect(result.mergedData).toEqual({})
		expect(result.appliedOperation).toBe('remote')
	})

	test('multiple field types in one merge: string LWW + array add-wins + custom resolver', async () => {
		const collDef: CollectionDefinition = {
			fields: {
				title: {
					kind: 'string',
					required: true,
					defaultValue: '',
					auto: false,
					enumValues: null,
					itemKind: null,
				},
				tags: {
					kind: 'array',
					required: false,
					defaultValue: [],
					auto: false,
					enumValues: null,
					itemKind: 'string',
				},
				score: {
					kind: 'number',
					required: false,
					defaultValue: 0,
					auto: false,
					enumValues: null,
					itemKind: null,
				},
			},
			indexes: [],
			constraints: [],
			resolvers: {
				score: (local: unknown, remote: unknown, base: unknown): unknown => {
					// Max-wins strategy
					return Math.max(local as number, remote as number)
				},
			},
		}

		const local = makeOp({
			data: { title: 'local', tags: ['a', 'b', 'c'], score: 80 },
			previousData: { title: 'base', tags: ['a', 'b'], score: 50 },
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
		})
		const remote = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { title: 'remote', tags: ['a', 'b', 'd'], score: 90 },
			previousData: { title: 'base', tags: ['a', 'b'], score: 50 },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
		})

		const result = await engine.merge({
			local,
			remote,
			baseState: { title: 'base', tags: ['a', 'b'], score: 50 },
			collectionDef: collDef,
		})

		// title: LWW → local wins (later)
		expect(result.mergedData.title).toBe('local')
		// tags: add-wins-set → union
		expect(result.mergedData.tags).toEqual(['a', 'b', 'c', 'd'])
		// score: custom resolver → max(80, 90) = 90
		expect(result.mergedData.score).toBe(90)
	})

	test('non-conflicting fields pass through untouched', async () => {
		const collDef: CollectionDefinition = {
			fields: {
				title: {
					kind: 'string',
					required: true,
					defaultValue: '',
					auto: false,
					enumValues: null,
					itemKind: null,
				},
				description: {
					kind: 'string',
					required: false,
					defaultValue: '',
					auto: false,
					enumValues: null,
					itemKind: null,
				},
				completed: {
					kind: 'boolean',
					required: true,
					defaultValue: false,
					auto: false,
					enumValues: null,
					itemKind: null,
				},
			},
			indexes: [],
			constraints: [],
			resolvers: {},
		}

		const local = makeOp({
			data: { title: 'local title' },
			previousData: { title: 'base title' },
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
		})
		const remote = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { completed: true },
			previousData: { completed: false },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
		})

		const result = await engine.merge({
			local,
			remote,
			baseState: { title: 'base title', description: 'keep me', completed: false },
			collectionDef: collDef,
		})

		// title: only local changed → local
		expect(result.mergedData.title).toBe('local title')
		// completed: only remote changed → remote
		expect(result.mergedData.completed).toBe(true)
		// description: neither changed → base
		expect(result.mergedData.description).toBe('keep me')
		// No conflict traces
		expect(result.traces).toHaveLength(0)
	})

	test('all three tiers in one merge', async () => {
		const constraint: Constraint = {
			type: 'unique',
			fields: ['email'],
			onConflict: 'last-write-wins',
		}

		const collDef: CollectionDefinition = {
			fields: {
				email: {
					kind: 'string',
					required: true,
					defaultValue: '',
					auto: false,
					enumValues: null,
					itemKind: null,
				},
				name: {
					kind: 'string',
					required: true,
					defaultValue: '',
					auto: false,
					enumValues: null,
					itemKind: null,
				},
				score: {
					kind: 'number',
					required: false,
					defaultValue: 0,
					auto: false,
					enumValues: null,
					itemKind: null,
				},
			},
			indexes: ['email'],
			constraints: [constraint],
			resolvers: {
				score: (local: unknown, remote: unknown, base: unknown): unknown => {
					return Math.max(local as number, remote as number)
				},
			},
		}

		const local = makeOp({
			id: 'op-local',
			nodeId: 'node-a',
			data: { name: 'Alice', email: 'shared@example.com', score: 80 },
			previousData: { name: 'Original', email: 'old@example.com', score: 50 },
			timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
		})
		const remote = makeOp({
			id: 'op-remote',
			nodeId: 'node-b',
			data: { name: 'Bob', email: 'shared@example.com', score: 90 },
			previousData: { name: 'Original', email: 'old@example.com', score: 50 },
			timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
		})

		const ctx = makeContext({
			items: [{ id: 'rec-2', email: 'shared@example.com' }],
		})

		const result = await engine.merge(
			{
				local,
				remote,
				baseState: { name: 'Original', email: 'old@example.com', score: 50 },
				collectionDef: collDef,
			},
			ctx,
		)

		// Tier 1: name → LWW → local (later)
		expect(result.mergedData.name).toBe('Alice')
		// Tier 3: score → custom (max-wins) → 90
		expect(result.mergedData.score).toBe(90)
		// Tier 2: email unique constraint violated → LWW → local (later)
		// Traces should cover all three tiers
		const tiers = new Set(result.traces.map((t) => t.tier))
		expect(tiers.has(1)).toBe(true) // LWW for name
		expect(tiers.has(2)).toBe(true) // constraint resolution
		expect(tiers.has(3)).toBe(true) // custom resolver for score
	})
})
