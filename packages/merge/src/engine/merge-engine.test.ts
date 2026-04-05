import type { CollectionDefinition, Constraint, Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { richtextToString, stringToRichtextUpdate } from '../strategies/yjs-richtext'
import type { ConstraintContext } from '../types'
import { MergeEngine } from './merge-engine'

function makeOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-a',
		type: 'update',
		collection: 'todos',
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

function makeCollectionDef(overrides: Partial<CollectionDefinition> = {}): CollectionDefinition {
	return {
		fields: {
			title: {
				kind: 'string',
				required: true,
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
			tags: {
				kind: 'array',
				required: false,
				defaultValue: [],
				auto: false,
				enumValues: null,
				itemKind: 'string',
			},
			priority: {
				kind: 'enum',
				required: true,
				defaultValue: 'medium',
				auto: false,
				enumValues: ['low', 'medium', 'high'],
				itemKind: null,
			},
			count: {
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
		resolvers: {},
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

describe('MergeEngine', () => {
	describe('update vs update (field-level merge)', () => {
		test('non-conflicting fields: each side keeps its changes', async () => {
			const local = makeOp({
				data: { title: 'local title' },
				previousData: { title: 'base title' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { completed: true },
				previousData: { completed: false },
				timestamp: { wallTime: 1500, logical: 0, nodeId: 'node-b' },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: {
					title: 'base title',
					completed: false,
					tags: [],
					priority: 'medium',
					count: 0,
				},
				collectionDef: makeCollectionDef(),
			})

			expect(result.mergedData.title).toBe('local title')
			expect(result.mergedData.completed).toBe(true)
		})

		test('conflicting string field: LWW resolves', async () => {
			const local = makeOp({
				data: { title: 'local title' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'remote title' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: { title: 'base', completed: false, tags: [], priority: 'medium', count: 0 },
				collectionDef: makeCollectionDef(),
			})

			expect(result.mergedData.title).toBe('local title')
			expect(result.traces).toHaveLength(1)
			expect(result.traces[0]?.strategy).toBe('lww')
		})

		test('conflicting array field: add-wins set', async () => {
			const local = makeOp({
				data: { tags: ['a', 'b', 'c'] },
				previousData: { tags: ['a', 'b'] },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { tags: ['a', 'b', 'd'] },
				previousData: { tags: ['a', 'b'] },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: {
					title: 'base',
					completed: false,
					tags: ['a', 'b'],
					priority: 'medium',
					count: 0,
				},
				collectionDef: makeCollectionDef(),
			})

			expect(result.mergedData.tags).toEqual(['a', 'b', 'c', 'd'])
		})

		test('multiple fields: mix of conflict and non-conflict', async () => {
			const local = makeOp({
				data: { title: 'local title', completed: true, priority: 'high' },
				previousData: { title: 'base', completed: false, priority: 'medium' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'remote title', tags: ['urgent'] },
				previousData: { title: 'base', tags: [] },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: { title: 'base', completed: false, tags: [], priority: 'medium', count: 0 },
				collectionDef: makeCollectionDef(),
			})

			// title: both changed → LWW → local wins (later timestamp)
			expect(result.mergedData.title).toBe('local title')
			// completed: only local → local's value
			expect(result.mergedData.completed).toBe(true)
			// tags: only remote → remote's value
			expect(result.mergedData.tags).toEqual(['urgent'])
			// priority: only local → local's value
			expect(result.mergedData.priority).toBe('high')
		})

		test('conflicting richtext field uses crdt-text strategy', async () => {
			const richtextCollection = makeCollectionDef({
				fields: {
					notes: {
						kind: 'richtext',
						required: false,
						defaultValue: undefined,
						auto: false,
						enumValues: null,
						itemKind: null,
					},
				},
			})

			const base = stringToRichtextUpdate('hello')
			const local = makeOp({
				data: { notes: stringToRichtextUpdate('A hello') },
				previousData: { notes: base },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { notes: stringToRichtextUpdate('hello B') },
				previousData: { notes: base },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: { notes: base },
				collectionDef: richtextCollection,
			})

			expect(result.mergedData.notes).toBeInstanceOf(Uint8Array)
			expect(richtextToString(result.mergedData.notes as Uint8Array)).toContain('hello')
			expect(result.traces[0]?.strategy).toBe('crdt-text')
		})
	})

	describe('insert vs insert', () => {
		test('merges all fields from both inserts', async () => {
			const local = makeOp({
				type: 'insert',
				data: { title: 'local', completed: true, tags: ['a'] },
				previousData: null,
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				type: 'insert',
				nodeId: 'node-b',
				data: { title: 'remote', completed: false, tags: ['b'] },
				previousData: null,
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: {},
				collectionDef: makeCollectionDef(),
			})

			// Both inserted title → LWW → local wins
			expect(result.mergedData.title).toBe('local')
			// Both inserted completed → LWW → local wins
			expect(result.mergedData.completed).toBe(true)
			// Both inserted tags → add-wins-set → union
			expect(result.mergedData.tags).toEqual(['a', 'b'])
		})
	})

	describe('delete operations', () => {
		test('delete vs delete: both agree', async () => {
			const local = makeOp({
				type: 'delete',
				data: null,
				previousData: null,
			})
			const remote = makeOp({
				id: 'op-2',
				type: 'delete',
				nodeId: 'node-b',
				data: null,
				previousData: null,
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: { title: 'old' },
				collectionDef: makeCollectionDef(),
			})

			expect(result.mergedData).toEqual({})
			expect(result.appliedOperation).toBe('merged')
		})

		test('update vs delete: later operation wins (delete wins when later)', async () => {
			const local = makeOp({
				type: 'update',
				data: { title: 'updated' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
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
				collectionDef: makeCollectionDef(),
			})

			expect(result.mergedData).toEqual({})
			expect(result.appliedOperation).toBe('remote')
		})

		test('update vs delete: update wins when later', async () => {
			const local = makeOp({
				type: 'update',
				data: { title: 'updated' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				type: 'delete',
				nodeId: 'node-b',
				data: null,
				previousData: null,
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: { title: 'base' },
				collectionDef: makeCollectionDef(),
			})

			expect(result.mergedData.title).toBe('updated')
			expect(result.appliedOperation).toBe('local')
		})

		test('delete vs update: delete wins when later', async () => {
			const local = makeOp({
				type: 'delete',
				data: null,
				previousData: null,
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				type: 'update',
				nodeId: 'node-b',
				data: { title: 'remote update' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: { title: 'base' },
				collectionDef: makeCollectionDef(),
			})

			expect(result.mergedData).toEqual({})
			expect(result.appliedOperation).toBe('local')
		})
	})

	describe('Tier 3: custom resolvers', () => {
		test('custom resolver overrides LWW for specific field', async () => {
			const collDef = makeCollectionDef({
				resolvers: {
					count: (localVal, remoteVal, base) => {
						// Additive merge
						const l = localVal as number
						const r = remoteVal as number
						const b = base as number
						return Math.max(0, b + (l - b) + (r - b))
					},
				},
			})

			const local = makeOp({
				data: { count: 8 },
				previousData: { count: 10 },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { count: 7 },
				previousData: { count: 10 },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-b' },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: { title: 'base', completed: false, tags: [], priority: 'medium', count: 10 },
				collectionDef: collDef,
			})

			// base=10, local=8 (delta -2), remote=7 (delta -3) → 10 + (-2) + (-3) = 5
			expect(result.mergedData.count).toBe(5)
			expect(result.traces.some((t) => t.strategy === 'custom')).toBe(true)
		})
	})

	describe('Tier 2: constraint validation', () => {
		test('unique constraint violation triggers resolution', async () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['title'],
				onConflict: 'last-write-wins',
			}
			const collDef = makeCollectionDef({ constraints: [constraint] })

			const local = makeOp({
				data: { title: 'duplicate-title' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'duplicate-title' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			// Another record exists with the same title
			const ctx = makeContext({
				todos: [{ id: 'rec-2', title: 'duplicate-title' }],
			})

			const result = await engine.merge(
				{
					local,
					remote,
					baseState: { title: 'base', completed: false, tags: [], priority: 'medium', count: 0 },
					collectionDef: collDef,
				},
				ctx,
			)

			// The constraint resolution trace should be present
			expect(result.traces.some((t) => t.tier === 2)).toBe(true)
		})

		test('no constraint context: skips Tier 2', async () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['title'],
				onConflict: 'last-write-wins',
			}
			const collDef = makeCollectionDef({ constraints: [constraint] })

			const local = makeOp({
				data: { title: 'dup' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'dup' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			// No constraint context provided
			const result = await engine.merge({
				local,
				remote,
				baseState: { title: 'base', completed: false, tags: [], priority: 'medium', count: 0 },
				collectionDef: collDef,
			})

			// Only Tier 1 traces (no Tier 2)
			expect(result.traces.every((t) => t.tier !== 2)).toBe(true)
		})
	})

	describe('mergeFields (synchronous)', () => {
		test('performs Tier 1 + Tier 3 only', () => {
			const collDef = makeCollectionDef({
				resolvers: {
					count: (l, r, b) =>
						Math.max(
							0,
							(b as number) + ((l as number) - (b as number)) + ((r as number) - (b as number)),
						),
				},
			})

			const local = makeOp({
				data: { title: 'local', count: 8 },
				previousData: { title: 'base', count: 10 },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'remote', count: 7 },
				previousData: { title: 'base', count: 10 },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = engine.mergeFields({
				local,
				remote,
				baseState: { title: 'base', completed: false, tags: [], priority: 'medium', count: 10 },
				collectionDef: collDef,
			})

			expect(result.mergedData.title).toBe('local')
			expect(result.mergedData.count).toBe(5)
			expect(result.traces.some((t) => t.strategy === 'lww')).toBe(true)
			expect(result.traces.some((t) => t.strategy === 'custom')).toBe(true)
		})
	})

	describe('traces', () => {
		test('only conflict traces are included (no no-conflict traces)', async () => {
			const local = makeOp({
				data: { title: 'local title', completed: true },
				previousData: { title: 'base', completed: false },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'remote title' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: { title: 'base', completed: false, tags: [], priority: 'medium', count: 0 },
				collectionDef: makeCollectionDef(),
			})

			// Only title has a conflict (both modified it); completed was only modified by local
			expect(result.traces).toHaveLength(1)
			expect(result.traces[0]?.field).toBe('title')
		})
	})

	describe('appliedOperation determination', () => {
		test('reports local when all conflicts resolve to local', async () => {
			const local = makeOp({
				data: { title: 'local', priority: 'high' },
				previousData: { title: 'base', priority: 'low' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'remote', priority: 'medium' },
				previousData: { title: 'base', priority: 'low' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: { title: 'base', completed: false, tags: [], priority: 'low', count: 0 },
				collectionDef: makeCollectionDef(),
			})

			expect(result.appliedOperation).toBe('local')
		})

		test('reports remote when all conflicts resolve to remote', async () => {
			const local = makeOp({
				data: { title: 'local', priority: 'high' },
				previousData: { title: 'base', priority: 'low' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'remote', priority: 'medium' },
				previousData: { title: 'base', priority: 'low' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-b' },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: { title: 'base', completed: false, tags: [], priority: 'low', count: 0 },
				collectionDef: makeCollectionDef(),
			})

			expect(result.appliedOperation).toBe('remote')
		})

		test('reports merged when conflicts resolve to different sides', async () => {
			const collDef = makeCollectionDef({
				resolvers: {
					count: () => 42, // custom resolver produces a different value
				},
			})

			const local = makeOp({
				data: { title: 'local', count: 5 },
				previousData: { title: 'base', count: 10 },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'remote', count: 3 },
				previousData: { title: 'base', count: 10 },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = await engine.merge({
				local,
				remote,
				baseState: { title: 'base', completed: false, tags: [], priority: 'medium', count: 10 },
				collectionDef: collDef,
			})

			expect(result.appliedOperation).toBe('merged')
		})
	})
})
