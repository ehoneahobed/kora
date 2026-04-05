import type { FieldDescriptor, HLCTimestamp, Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { mergeField } from './field-merger'
import { richtextToString, stringToRichtextUpdate } from '../strategies/yjs-richtext'

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

const stringField: FieldDescriptor = {
	kind: 'string',
	required: true,
	defaultValue: '',
	auto: false,
	enumValues: null,
	itemKind: null,
}

const numberField: FieldDescriptor = {
	kind: 'number',
	required: true,
	defaultValue: 0,
	auto: false,
	enumValues: null,
	itemKind: null,
}

const booleanField: FieldDescriptor = {
	kind: 'boolean',
	required: true,
	defaultValue: false,
	auto: false,
	enumValues: null,
	itemKind: null,
}

const enumField: FieldDescriptor = {
	kind: 'enum',
	required: true,
	defaultValue: 'low',
	auto: false,
	enumValues: ['low', 'medium', 'high'],
	itemKind: null,
}

const timestampField: FieldDescriptor = {
	kind: 'timestamp',
	required: false,
	defaultValue: null,
	auto: false,
	enumValues: null,
	itemKind: null,
}

const arrayField: FieldDescriptor = {
	kind: 'array',
	required: false,
	defaultValue: [],
	auto: false,
	enumValues: null,
	itemKind: 'string',
}

const richtextField: FieldDescriptor = {
	kind: 'richtext',
	required: false,
	defaultValue: null,
	auto: false,
	enumValues: null,
	itemKind: null,
}

describe('mergeField', () => {
	describe('non-conflict cases', () => {
		test('only local changed → takes local value', () => {
			const local = makeOp({
				data: { title: 'new title' },
				previousData: { title: 'old title' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { completed: true },
				previousData: { completed: false },
			})
			const base = { title: 'old title', completed: false }

			const result = mergeField('title', local, remote, base, stringField)

			expect(result.value).toBe('new title')
			expect(result.trace.strategy).toBe('no-conflict-local')
		})

		test('only remote changed → takes remote value', () => {
			const local = makeOp({
				data: { completed: true },
				previousData: { completed: false },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'remote title' },
				previousData: { title: 'old title' },
			})
			const base = { title: 'old title', completed: false }

			const result = mergeField('title', local, remote, base, stringField)

			expect(result.value).toBe('remote title')
			expect(result.trace.strategy).toBe('no-conflict-remote')
		})

		test('neither changed → keeps base value', () => {
			const local = makeOp({
				data: { completed: true },
				previousData: { completed: false },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { completed: false },
				previousData: { completed: true },
			})
			const base = { title: 'base title', completed: false }

			const result = mergeField('title', local, remote, base, stringField)

			expect(result.value).toBe('base title')
			expect(result.trace.strategy).toBe('no-conflict-unchanged')
		})
	})

	describe('LWW conflict resolution (string, number, boolean, enum, timestamp)', () => {
		test('string field: later timestamp wins', () => {
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

			const result = mergeField('title', local, remote, { title: 'base' }, stringField)

			expect(result.value).toBe('local title')
			expect(result.trace.strategy).toBe('lww')
			expect(result.trace.tier).toBe(1)
		})

		test('number field: LWW', () => {
			const local = makeOp({
				data: { count: 10 },
				previousData: { count: 5 },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { count: 20 },
				previousData: { count: 5 },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-b' },
			})

			const result = mergeField('count', local, remote, { count: 5 }, numberField)

			expect(result.value).toBe(20) // remote is later
		})

		test('boolean field: LWW', () => {
			const local = makeOp({
				data: { completed: true },
				previousData: { completed: false },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { completed: false },
				previousData: { completed: false },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = mergeField('completed', local, remote, { completed: false }, booleanField)

			expect(result.value).toBe(true) // local is later
		})

		test('enum field: LWW', () => {
			const local = makeOp({
				data: { priority: 'high' },
				previousData: { priority: 'low' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { priority: 'medium' },
				previousData: { priority: 'low' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-b' },
			})

			const result = mergeField('priority', local, remote, { priority: 'low' }, enumField)

			expect(result.value).toBe('medium') // remote is later
		})

		test('timestamp field: LWW', () => {
			const local = makeOp({
				data: { dueDate: 1000 },
				previousData: { dueDate: 500 },
				timestamp: { wallTime: 3000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { dueDate: 2000 },
				previousData: { dueDate: 500 },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = mergeField('dueDate', local, remote, { dueDate: 500 }, timestampField)

			expect(result.value).toBe(1000) // local is later
		})
	})

	describe('array field: add-wins set', () => {
		test('disjoint additions from both sides are merged', () => {
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

			const result = mergeField('tags', local, remote, { tags: ['a', 'b'] }, arrayField)

			expect(result.value).toEqual(['a', 'b', 'c', 'd'])
			expect(result.trace.strategy).toBe('add-wins-set')
			expect(result.trace.tier).toBe(1)
		})

		test('handles null/undefined base as empty array', () => {
			const local = makeOp({
				data: { tags: ['a'] },
				previousData: { tags: null },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { tags: ['b'] },
				previousData: { tags: null },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = mergeField('tags', local, remote, {}, arrayField)

			expect(result.value).toEqual(['a', 'b'])
		})
	})

	describe('richtext field', () => {
		test('merges concurrent richtext updates with Yjs strategy', () => {
			const local = makeOp({
				data: { notes: stringToRichtextUpdate('base local') },
				previousData: { notes: stringToRichtextUpdate('base') },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { notes: stringToRichtextUpdate('base remote') },
				previousData: { notes: stringToRichtextUpdate('base') },
			})

			const result = mergeField(
				'notes',
				local,
				remote,
				{ notes: stringToRichtextUpdate('base') },
				richtextField,
			)

			expect(result.value).toBeInstanceOf(Uint8Array)
			expect(richtextToString(result.value as Uint8Array)).toContain('base')
			expect(result.trace.strategy).toBe('crdt-text')
			expect(result.trace.tier).toBe(1)
		})
	})

	describe('Tier 3: custom resolver', () => {
		test('custom resolver overrides default strategy', () => {
			const local = makeOp({
				data: { quantity: 8 },
				previousData: { quantity: 10 },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { quantity: 7 },
				previousData: { quantity: 10 },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-b' },
			})

			// Additive merge: apply both deltas to base
			const additiveResolver = (localVal: unknown, remoteVal: unknown, base: unknown): unknown => {
				const l = localVal as number
				const r = remoteVal as number
				const b = base as number
				return Math.max(0, b + (l - b) + (r - b))
			}

			const result = mergeField(
				'quantity',
				local,
				remote,
				{ quantity: 10 },
				numberField,
				additiveResolver,
			)

			// base=10, local=8 (delta -2), remote=7 (delta -3) → 10 + (-2) + (-3) = 5
			expect(result.value).toBe(5)
			expect(result.trace.strategy).toBe('custom')
			expect(result.trace.tier).toBe(3)
		})

		test('custom resolver receives correct base/local/remote values', () => {
			const receivedArgs: unknown[] = []
			const captureResolver = (local: unknown, remote: unknown, base: unknown): unknown => {
				receivedArgs.push(local, remote, base)
				return local
			}

			const local = makeOp({
				data: { title: 'local-title' },
				previousData: { title: 'base-title' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'remote-title' },
				previousData: { title: 'base-title' },
			})

			mergeField('title', local, remote, { title: 'base-title' }, stringField, captureResolver)

			expect(receivedArgs).toEqual(['local-title', 'remote-title', 'base-title'])
		})
	})

	describe('MergeTrace', () => {
		test('trace contains all required fields', () => {
			const local = makeOp({
				data: { title: 'local' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'remote' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = mergeField('title', local, remote, { title: 'base' }, stringField)
			const { trace } = result

			expect(trace.operationA).toBe(local)
			expect(trace.operationB).toBe(remote)
			expect(trace.field).toBe('title')
			expect(trace.strategy).toBe('lww')
			expect(trace.inputA).toBe('local')
			expect(trace.inputB).toBe('remote')
			expect(trace.base).toBe('base')
			expect(trace.output).toBe('local')
			expect(trace.tier).toBe(1)
			expect(trace.constraintViolated).toBeNull()
			expect(typeof trace.duration).toBe('number')
			expect(trace.duration).toBeGreaterThanOrEqual(0)
		})
	})

	describe('edge cases', () => {
		test('field value is null', () => {
			const local = makeOp({
				data: { title: null },
				previousData: { title: 'base' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'remote' },
				previousData: { title: 'base' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = mergeField('title', local, remote, { title: 'base' }, stringField)

			expect(result.value).toBeNull() // local is later, local value is null
		})

		test('delete operation has null data', () => {
			const local = makeOp({
				type: 'delete',
				data: null,
				previousData: null,
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { title: 'update' },
				previousData: { title: 'base' },
			})
			const base = { title: 'base' }

			// When local data is null (delete), field 'title' is not in localData
			// so it's a non-conflict: only remote changed title
			const result = mergeField('title', local, remote, base, stringField)

			expect(result.value).toBe('update')
			expect(result.trace.strategy).toBe('no-conflict-remote')
		})
	})
})
