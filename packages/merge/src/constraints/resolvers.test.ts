import type { Constraint, Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import type { ConstraintViolation } from '../types'
import { resolveConstraintViolation } from './resolvers'

function makeOp(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'op-1',
		nodeId: 'node-a',
		type: 'update',
		collection: 'users',
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

function makeViolation(constraint: Constraint, fields: string[]): ConstraintViolation {
	return {
		constraint,
		fields,
		message: `Test violation on [${fields.join(', ')}]`,
	}
}

describe('resolveConstraintViolation', () => {
	describe('last-write-wins', () => {
		test('later operation wins', () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['email'],
				onConflict: 'last-write-wins',
			}
			const local = makeOp({
				data: { email: 'local@example.com' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { email: 'remote@example.com' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})
			const merged = { email: 'merged@example.com', name: 'Test' }
			const base = { email: 'base@example.com', name: 'Test' }

			const result = resolveConstraintViolation(
				makeViolation(constraint, ['email']),
				merged,
				local,
				remote,
				base,
			)

			expect(result.resolvedRecord.email).toBe('local@example.com')
			expect(result.trace.strategy).toBe('constraint-lww')
			expect(result.trace.tier).toBe(2)
		})

		test('remote wins when it has later timestamp', () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['email'],
				onConflict: 'last-write-wins',
			}
			const local = makeOp({
				data: { email: 'local@example.com' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { email: 'remote@example.com' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-b' },
			})

			const result = resolveConstraintViolation(
				makeViolation(constraint, ['email']),
				{ email: 'merged', name: 'Test' },
				local,
				remote,
				{ email: 'base', name: 'Test' },
			)

			expect(result.resolvedRecord.email).toBe('remote@example.com')
		})
	})

	describe('first-write-wins', () => {
		test('earlier operation wins', () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['email'],
				onConflict: 'first-write-wins',
			}
			const local = makeOp({
				data: { email: 'local@example.com' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { email: 'remote@example.com' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = resolveConstraintViolation(
				makeViolation(constraint, ['email']),
				{ email: 'merged', name: 'Test' },
				local,
				remote,
				{ email: 'base', name: 'Test' },
			)

			// Remote has earlier timestamp → remote wins
			expect(result.resolvedRecord.email).toBe('remote@example.com')
			expect(result.trace.strategy).toBe('constraint-fww')
		})
	})

	describe('priority-field', () => {
		test('higher numeric priority wins', () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['slot'],
				onConflict: 'priority-field',
				priorityField: 'priority',
			}
			const local = makeOp({
				data: { slot: 'A', priority: 10 },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { slot: 'B', priority: 5 },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-b' },
			})

			const result = resolveConstraintViolation(
				makeViolation(constraint, ['slot']),
				{ slot: 'merged', priority: 10 },
				local,
				remote,
				{ slot: 'base', priority: 1 },
			)

			// local has priority 10 > remote priority 5 → local wins
			expect(result.resolvedRecord.slot).toBe('A')
			expect(result.trace.strategy).toBe('constraint-priority')
		})

		test('falls back to LWW when no priorityField specified', () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['slot'],
				onConflict: 'priority-field',
				// priorityField not set
			}
			const local = makeOp({
				data: { slot: 'A' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { slot: 'B' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = resolveConstraintViolation(
				makeViolation(constraint, ['slot']),
				{ slot: 'merged' },
				local,
				remote,
				{ slot: 'base' },
			)

			expect(result.resolvedRecord.slot).toBe('A')
			expect(result.trace.strategy).toBe('constraint-priority-fallback-lww')
		})
	})

	describe('server-decides', () => {
		test('marks record for server resolution', () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['email'],
				onConflict: 'server-decides',
			}
			const local = makeOp({ data: { email: 'local@example.com' } })
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { email: 'remote@example.com' },
			})

			const result = resolveConstraintViolation(
				makeViolation(constraint, ['email']),
				{ email: 'merged' },
				local,
				remote,
				{ email: 'base' },
			)

			expect(result.resolvedRecord._pendingServerResolution).toBe(true)
			expect(result.trace.strategy).toBe('constraint-server-decides')
		})
	})

	describe('custom', () => {
		test('calls custom resolve function', () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['email'],
				onConflict: 'custom',
				resolve: (local, remote, _base) => {
					// Pick whichever is longer
					return String(local).length >= String(remote).length ? local : remote
				},
			}
			const local = makeOp({ data: { email: 'long-local@example.com' } })
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { email: 'short@ex.com' },
			})

			const result = resolveConstraintViolation(
				makeViolation(constraint, ['email']),
				{ email: 'merged' },
				local,
				remote,
				{ email: 'base' },
			)

			expect(result.resolvedRecord.email).toBe('long-local@example.com')
			expect(result.trace.strategy).toBe('constraint-custom')
		})

		test('falls back to LWW when no resolve function provided', () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['email'],
				onConflict: 'custom',
				// resolve not set
			}
			const local = makeOp({
				data: { email: 'local@example.com' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { email: 'remote@example.com' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = resolveConstraintViolation(
				makeViolation(constraint, ['email']),
				{ email: 'merged' },
				local,
				remote,
				{ email: 'base' },
			)

			expect(result.resolvedRecord.email).toBe('local@example.com')
			expect(result.trace.strategy).toBe('constraint-custom-fallback-lww')
		})
	})

	describe('MergeTrace', () => {
		test('trace includes constraint violation info', () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['email'],
				onConflict: 'last-write-wins',
			}
			const local = makeOp({
				data: { email: 'local@example.com' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { email: 'remote@example.com' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})
			const violation = makeViolation(constraint, ['email'])

			const result = resolveConstraintViolation(violation, { email: 'merged' }, local, remote, {
				email: 'base',
			})

			expect(result.trace.tier).toBe(2)
			expect(result.trace.constraintViolated).toBe(violation.message)
			expect(result.trace.field).toBe('email')
			expect(typeof result.trace.duration).toBe('number')
		})
	})

	describe('multiple fields', () => {
		test('resolves all violated fields', () => {
			const constraint: Constraint = {
				type: 'unique',
				fields: ['name', 'email'],
				onConflict: 'last-write-wins',
			}
			const local = makeOp({
				data: { name: 'Local Name', email: 'local@example.com' },
				timestamp: { wallTime: 2000, logical: 0, nodeId: 'node-a' },
			})
			const remote = makeOp({
				id: 'op-2',
				nodeId: 'node-b',
				data: { name: 'Remote Name', email: 'remote@example.com' },
				timestamp: { wallTime: 1000, logical: 0, nodeId: 'node-b' },
			})

			const result = resolveConstraintViolation(
				makeViolation(constraint, ['name', 'email']),
				{ name: 'Merged', email: 'merged@example.com' },
				local,
				remote,
				{ name: 'Base', email: 'base@example.com' },
			)

			// Local is later → local fields win
			expect(result.resolvedRecord.name).toBe('Local Name')
			expect(result.resolvedRecord.email).toBe('local@example.com')
		})
	})
})
